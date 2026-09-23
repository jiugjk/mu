/**
 * QQBotGateway 事件处理
 *
 * 处理 SDK 的 message / interaction 事件：
 * - message: 中间件处理完毕后，将消息转发到 mu（原版为 OpenClaw AI）
 * - interaction: 配置更新 / 审批按钮
 *
 * mu 适配：审批按钮原版回调 OpenClaw 网关的 exec/plugin approval RPC；移植后回答 mu 会话里等待中的问题
 * （权限审批、风险命令确认等都经由 ctx.ui.select/confirm 发到 QQ，见 features/chat-surface.ts）。
 */

import type { InteractionEvent, MiddlewareContext, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { getAdapters } from "../adapter/resolve.ts";
import { getOpenClawVersion } from "../bot-instance.ts";
import { resolveGroupConfigFromAccount, resolveGroupPolicy, resolveMentionPatterns } from "../config.ts";
import { dispatchToMu } from "../dispatch/index.ts";
import { parseChatButtonData } from "../features/chat-surface.ts";
import { cacheMsgId } from "../features/msgid-cache.ts";
import { recordKnownUser } from "../features/proactive.ts";
import { sendText } from "../outbound/outbound-service.ts";
import { runWithRequestContext } from "../request-context.ts";
import type { QQBotRuntime } from "../runtime.ts";
import type { ResolvedQQBotAccount } from "../types.ts";
import { getPackageVersion } from "../utils/pkg-version.ts";
import type { PluginLogger } from "../utils/plugin-logger.ts";

export async function handleMessage(
	ctx: MiddlewareContext,
	msg: QQBotInboundMessage,
	account: ResolvedQQBotAccount,
	runtime: QQBotRuntime,
	log: PluginLogger,
): Promise<void> {
	const hlog = log.child("handle");
	const scope = msg.replyTarget.scope;
	const targetId =
		scope === "group" ? `qqbot:group:${msg.replyTarget.targetId}` : `qqbot:c2c:${msg.replyTarget.targetId}`;

	const mergedCount = (ctx.state.mergedMessages as unknown[] | undefined)?.length;
	if (mergedCount) {
		hlog.info(`merged batch count=${mergedCount} msgId=${msg.messageId}`);
	} else {
		hlog.debug(`enter msgId=${msg.messageId} scope=${scope} contentLen=${(msg.content ?? "").length}`);
	}

	try {
		cacheMsgId(scope, msg.replyTarget.targetId, msg.messageId);

		recordKnownUser({
			type: scope === "group" ? "group" : "c2c",
			openid: scope === "group" ? msg.replyTarget.targetId : msg.senderId,
			accountId: account.accountId,
			nickname: msg.senderName,
			lastInteractionAt: Date.now(),
		});

		await runWithRequestContext(
			{
				accountId: account.accountId,
				messageId: msg.messageId,
				openId: msg.senderId,
				target: targetId,
			},
			() => dispatchToMu(ctx, msg, account, runtime, log),
		);
	} catch (err) {
		hlog.error(`dispatch error: ${err}`);
	}
	hlog.debug(`done msgId=${msg.messageId}`);
}

const INTERACTION_QUERY = 2001;
const INTERACTION_UPDATE = 2002;

export async function handleInteraction(
	event: InteractionEvent,
	account: ResolvedQQBotAccount,
	runtime: QQBotRuntime,
	log: PluginLogger,
	acknowledgeInteraction: (id: string, code?: number, data?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
	if (event.data?.type === INTERACTION_QUERY) {
		await handleConfigQuery(event, account, runtime, log, acknowledgeInteraction);
		return;
	}
	if (event.data?.type === INTERACTION_UPDATE) {
		await handleConfigUpdate(event, account, runtime, log);
		try {
			const adapters = getAdapters(runtime);
			const cfg = adapters.getConfig?.() ?? {};
			const groupOpenid = (event as any).group_openid ?? "";
			const updatedCfg = groupOpenid ? resolveGroupConfigFromAccount(account, groupOpenid) : null;
			const requireMention = updatedCfg?.requireMention ?? true;
			const clawCfg = buildClawCfg(
				requireMention,
				[],
				resolveGroupPolicy(cfg, account.accountId),
				account.config.clawType,
			);
			await acknowledgeInteraction(event.id, 0, { claw_cfg: clawCfg });
		} catch {
			try {
				await acknowledgeInteraction(event.id);
			} catch {
				/* ignore */
			}
		}
		return;
	}

	await handleApproval(event, account, runtime, log, acknowledgeInteraction);
}

// ── Interaction 子处理 ──

async function handleConfigQuery(
	event: InteractionEvent,
	account: ResolvedQQBotAccount,
	runtime: QQBotRuntime,
	log: PluginLogger,
	ack: (id: string, code?: number, data?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
	const groupOpenid = (event as any).group_openid ?? "";
	try {
		const adapters = getAdapters(runtime);
		const cfg = adapters.getConfig?.() ?? {};
		const groupCfg = groupOpenid ? resolveGroupConfigFromAccount(account, groupOpenid) : null;
		const requireMention = groupCfg?.requireMention ?? true;
		// mu 适配：原版按 resolveAgentRoute 取 agent 级 mentionPatterns；mu 只有一个 agent，读账户配置
		const mentionPatterns = resolveMentionPatterns(cfg, account.accountId);
		const clawCfg = buildClawCfg(
			requireMention,
			mentionPatterns,
			resolveGroupPolicy(cfg, account.accountId),
			account.config.clawType,
		);
		log.info(`interaction query: group=${groupOpenid} requireMention=${requireMention}`);
		await ack(event.id, 0, { claw_cfg: clawCfg });
	} catch (err) {
		log.warn(`interaction query failed: ${(err as Error)?.message ?? err}, ack without data`);
		try {
			await ack(event.id);
		} catch {
			/* ignore */
		}
	}
}

async function handleConfigUpdate(
	event: InteractionEvent,
	account: ResolvedQQBotAccount,
	runtime: QQBotRuntime,
	log: PluginLogger,
): Promise<void> {
	const resolved = (event.data as any)?.resolved;
	const update = resolved?.claw_cfg;
	const groupOpenid = (event as any).group_openid ?? "";

	if (update?.require_mention !== undefined && groupOpenid) {
		try {
			await setGroupRequireMention(runtime, account.accountId, groupOpenid, update.require_mention === "mention");
			log.info(`interaction: group=${groupOpenid} requireMention=${update.require_mention}`);
		} catch (err) {
			log.error(`interaction update failed: ${err}`);
		}
	}
}

async function handleApproval(
	event: InteractionEvent,
	account: ResolvedQQBotAccount,
	runtime: QQBotRuntime,
	log: PluginLogger,
	ack: (id: string) => Promise<void>,
): Promise<void> {
	try {
		await ack(event.id);
	} catch {
		/* ignore */
	}

	const parsed = parseChatButtonData(event.data?.resolved?.button_data);
	if (!parsed) return;

	const evt = event as InteractionEvent & { group_openid?: string; user_openid?: string };
	const conversation = evt.group_openid
		? { accountId: account.accountId, scope: "group" as const, peerId: evt.group_openid }
		: evt.user_openid
			? { accountId: account.accountId, scope: "c2c" as const, peerId: evt.user_openid }
			: null;
	if (!conversation) return;

	// 身份授权校验：操作者需在 allowFrom 白名单中（与原版一致，由会话宿主的 authorize 执行）
	const operatorId = resolveOperatorId(event);
	const outcome = runtime.host.answer(conversation, parsed.promptId, parsed.index, operatorId);
	if (outcome === "unauthorized") {
		log.warn(`[approval] unauthorized operator=${operatorId ?? "unknown"} account=${account.accountId}`);
		await sendText({
			to: `qqbot:${conversation.scope}:${conversation.peerId}`,
			text: "⚠️ 你没有权限处理这个审批。",
			account,
		}).catch(() => {});
	} else if (outcome === "unknown") {
		log.info(`[approval] prompt ${parsed.promptId} no longer pending`);
	}
}

// ── 审批授权校验 ──

/**
 * 从交互事件中提取操作者身份标识。
 * QQ Bot 按钮回调事件中，操作者 openid 通常在 `user_openid` 或 `data.resolved.user_id` 字段。
 */
function resolveOperatorId(event: InteractionEvent): string | undefined {
	const evt = event as any;
	// mu 修正：群聊按钮的操作者在 group_member_openid（原版遗漏，导致设置了 allowFrom 时群内审批总被拒）
	return (
		evt.group_member_openid ??
		evt.user_openid ??
		evt.data?.resolved?.user_id ??
		evt.data?.resolved?.user_openid ??
		evt.openid
	);
}

function buildClawCfg(
	requireMention: boolean,
	mentionPatterns: string[],
	groupPolicy: string,
	clawType?: string,
): Record<string, unknown> {
	return {
		channel_type: "qqbot",
		channel_ver: getPackageVersion(),
		// mu 适配：原版固定为 'openclaw'；移植后默认 'mu'，可用 channels.qqbot.clawType 改回
		claw_type: clawType?.trim() || "mu",
		claw_ver: getOpenClawVersion(),
		require_mention: requireMention ? "mention" : "always",
		group_policy: groupPolicy,
		mention_patterns: mentionPatterns.join(","),
		online_state: "online",
	};
}

// ── Config 写入 ──

function setGroupRequireMention(
	runtime: QQBotRuntime,
	accountId: string,
	groupOpenid: string,
	requireMention: boolean,
): Promise<void> {
	const adapters = getAdapters(runtime);
	return (
		adapters.persistConfig?.((cfg: any) => {
			const qqbot = cfg.channels?.qqbot ?? {};
			const owner = accountId !== "default" && qqbot.accounts?.[accountId] ? qqbot.accounts[accountId] : qqbot;
			owner.groups = { ...owner.groups };
			owner.groups[groupOpenid] = { ...owner.groups[groupOpenid], requireMention };
		}) ?? Promise.resolve()
	);
}
