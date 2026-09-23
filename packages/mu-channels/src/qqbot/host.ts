/**
 * QQ 会话宿主（mu 移植新增）
 *
 * 原版把每条消息交给 OpenClaw 的 inbound.run / dispatchReplyWithBufferedBlockDispatcher，由框架按
 * resolveAgentRoute 的 sessionKey 找到会话。移植后每个会话（账户 × 私聊用户 / 群）对应一个 mu 会话，
 * 由通用渠道宿主（src/host）打开、复用、闲置回收；本文件只负责 QQ 相关的部分：
 *   - 会话键与目录隔离：每个私聊、每个群各有自己的 workspace、下载目录和会话记录目录；
 *   - 工具范围：私聊为完整工具；群按 toolPolicy（full / restricted=只读 / none）；
 *   - 系统提示：账户 systemPrompt、群名、群行为提示；
 *   - 问答界面：把 mu 的审批 / 选择问题发到 QQ（按钮 + 序号），只接受 allowFrom 中的人作答。
 */
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AnswerOutcome, ChatSurface, ChatUIBridge } from "../host/chat-ui.ts";
import type { ChannelLogger } from "../host/logger.ts";
import { safeSegment } from "../host/paths.ts";
import {
	type ChannelSession,
	type ChannelTurn,
	openChannelSession,
	runChannelTurn,
	type ToolAccess,
} from "../host/session.ts";
import { type Lease, SessionPool, SessionPoolFullError } from "../host/session-pool.ts";
import { resolveGroupConfigFromAccount } from "./config.ts";
import type { MuPermissionMode, ResolvedQQBotAccount } from "./types.ts";

export interface ConversationRef {
	accountId: string;
	scope: "c2c" | "group";
	/** 私聊为用户 openid，群为群 openid */
	peerId: string;
}

export function conversationKey(ref: ConversationRef): string {
	return `${ref.accountId}:${ref.scope}:${ref.peerId}`;
}

export function conversationTarget(ref: ConversationRef): string {
	return `qqbot:${ref.scope}:${ref.peerId}`;
}

export interface ConversationDirs {
	workspace: string;
	media: string;
	sessions: string;
}

/** 每个会话独立的目录：<root>/<账户>/<c2c|group>/<openid> */
export function conversationDirs(home: string, workspaceRoot: string, ref: ConversationRef): ConversationDirs {
	const parts = [safeSegment(ref.accountId), ref.scope, safeSegment(ref.peerId)];
	return {
		workspace: join(workspaceRoot, ...parts),
		media: join(home, "media", ...parts),
		sessions: join(home, "sessions", ...parts),
	};
}

/** 群 toolPolicy → mu 工具范围。偏离原行为：原版 restricted 在 OpenClaw 中实际不限制（空 allow 列表 = 全部允许）。 */
export function toolAccessFor(account: ResolvedQQBotAccount, ref: ConversationRef): ToolAccess {
	if (ref.scope !== "group") return "full";
	const policy = resolveGroupConfigFromAccount(account, ref.peerId).toolPolicy;
	return policy === "full" ? "full" : policy === "none" ? "none" : "readonly";
}

/** restricted（只读）群里仍可用的 QQ 工具：它们只发消息，不改动主机 */
export const READONLY_QQBOT_TOOLS = ["qqbot_send_media", "qqbot_remind"] as const;

/**
 * 审批授权：allowFrom 为空或含 "*" → 所有人；否则操作者须在 allowFrom 中（与原版 isApprovalAuthorized 一致）。
 */
export function isOperatorAuthorized(account: ResolvedQQBotAccount, operatorId: string | undefined): boolean {
	if (!operatorId) return false;
	const allowFrom = (account.config?.allowFrom ?? []).map((id) => String(id));
	if (!allowFrom.length || allowFrom.includes("*")) return true;
	return allowFrom.includes(operatorId);
}

/** 明确列在 allowFrom 中（不含 "*"）的用户：可以在 QQ 里执行 mu 的斜杠命令（Q5a） */
export function isExplicitAdmin(account: ResolvedQQBotAccount, senderId: string | undefined): boolean {
	if (!senderId) return false;
	return (account.config?.allowFrom ?? []).map((id) => String(id)).includes(senderId);
}

/** 每个会话的系统提示补充：通道说明 + 账户 systemPrompt + 群名 + 群行为提示（Q6b） */
export function buildChannelPrompt(account: ResolvedQQBotAccount, ref: ConversationRef): string {
	const lines = [
		ref.scope === "group"
			? "你正在通过 QQ 机器人在 QQ 群聊中回复消息。群消息以「[昵称 (openid)] 内容」的形式给出，被 @ 时带 (@you)。"
			: "你正在通过 QQ 机器人在 QQ 私聊中回复消息。",
		"你的回复会以 QQ Markdown 发送给对方。要发送图片、语音、视频或文件，调用 qqbot_send_media 工具。",
	];
	const systemPrompt = account.systemPrompt?.trim();
	if (systemPrompt) lines.push(systemPrompt);
	if (ref.scope === "group") {
		const group = resolveGroupConfigFromAccount(account, ref.peerId);
		if (group.name) lines.push(`当前群: ${group.name}`);
		if (group.prompt?.trim()) lines.push(group.prompt.trim());
	}
	return lines.join("\n");
}

export interface QQBotHostOptions {
	/** ~/.mu/qqbot */
	home: string;
	agentDir: string;
	extensionPaths: readonly string[];
	skillPaths: readonly string[];
	log: ChannelLogger;
	/** 当前账户配置（每次打开会话时读取，热更新后生效） */
	getAccount(accountId: string): ResolvedQQBotAccount;
	/** 本会话的 QQ 工具 */
	createTools(ref: ConversationRef): ToolDefinition[];
	/** 把 mu 的问题发到 QQ */
	createSurface(ref: ConversationRef): ChatSurface;
	/** 默认工作目录根 */
	defaultWorkspaceRoot: string;
}

export type HostTurn = Omit<ChannelTurn, "log">;

export class QQBotHost {
	private readonly options: QQBotHostOptions;
	private readonly pools = new Map<string, SessionPool<ChannelSession>>();

	constructor(options: QQBotHostOptions) {
		this.options = options;
	}

	dirsFor(ref: ConversationRef): ConversationDirs {
		const account = this.options.getAccount(ref.accountId);
		return conversationDirs(this.options.home, account.config.workspace || this.options.defaultWorkspaceRoot, ref);
	}

	private poolFor(accountId: string): SessionPool<ChannelSession> {
		let pool = this.pools.get(accountId);
		if (!pool) {
			const sessions = this.options.getAccount(accountId).config.sessions;
			const log = this.options.log.child(`sessions:${accountId}`);
			pool = new SessionPool<ChannelSession>({
				idleMs: (sessions?.idleMinutes ?? 30) * 60_000,
				maxSessions: sessions?.maxSessions ?? 32,
				log,
				create: (key) => this.open(key),
				dispose: (value) => value.dispose(),
				// 有问题在等人回答时不关闭，否则回答就丢了
				canClose: (value) => !value.ui.hasPending && !value.session.isStreaming,
			});
			pool.start();
			this.pools.set(accountId, pool);
		}
		return pool;
	}

	private async open(key: string): Promise<ChannelSession> {
		const [accountId, scope, ...rest] = key.split(":");
		const ref: ConversationRef = { accountId, scope: scope as ConversationRef["scope"], peerId: rest.join(":") };
		const account = this.options.getAccount(accountId);
		const dirs = this.dirsFor(ref);
		const log = this.options.log.child(`session:${scope}:${ref.peerId.slice(0, 8)}`);
		log.info(`opening session (cwd=${dirs.workspace})`);
		return openChannelSession({
			cwd: dirs.workspace,
			sessionDir: dirs.sessions,
			agentDir: this.options.agentDir,
			extensionPaths: this.options.extensionPaths,
			skillPaths: this.options.skillPaths,
			toolAccess: toolAccessFor(account, ref),
			customTools: this.options.createTools(ref),
			readonlyCustomTools: READONLY_QQBOT_TOOLS,
			model: account.config.model,
			permissionMode: account.config.permissions ?? "jev",
			systemPrompt: () => buildChannelPrompt(this.options.getAccount(accountId), ref),
			surface: this.options.createSurface(ref),
			authorize: (operatorId) => isOperatorAuthorized(this.options.getAccount(accountId), operatorId),
			uiTimeoutMs: (account.config.approvalTimeoutSeconds ?? 600) * 1000,
			log,
		});
	}

	/**
	 * 在会话里跑一轮。会话数已达上限且全部在用时抛 SessionPoolFullError（调用方提示用户稍后再试）。
	 */
	async runTurn(ref: ConversationRef, turn: HostTurn): Promise<void> {
		let lease: Lease<ChannelSession>;
		try {
			lease = await this.poolFor(ref.accountId).acquire(conversationKey(ref));
		} catch (error) {
			if (error instanceof SessionPoolFullError) throw error;
			throw new Error(`无法打开会话: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			await runChannelTurn(lease.value.session, { ...turn, log: this.options.log.child("turn") });
		} finally {
			lease.release();
		}
	}

	/** /stop：中止正在进行的回合，并给等待中的问题默认答案 */
	async abort(ref: ConversationRef): Promise<boolean> {
		const open = this.pools.get(ref.accountId)?.peek(conversationKey(ref));
		if (!open) return false;
		const wasBusy = open.session.isStreaming || open.ui.hasPending;
		open.ui.cancelAll();
		if (open.session.isStreaming) await open.session.abort();
		return wasBusy;
	}

	bridge(ref: ConversationRef): ChatUIBridge | undefined {
		return this.pools.get(ref.accountId)?.peek(conversationKey(ref))?.ui;
	}

	/** 按钮点击 */
	answer(ref: ConversationRef, promptId: string, index: number, operatorId: string | undefined): AnswerOutcome {
		return this.bridge(ref)?.answer(promptId, index, operatorId) ?? "unknown";
	}

	/** 有问题等待回答时，一条文字消息是否是回答 */
	answerText(ref: ConversationRef, text: string, senderId: string | undefined): AnswerOutcome {
		return this.bridge(ref)?.answerText(text, senderId) ?? "unknown";
	}

	/** /bot-approve：已打开的会话立即切换权限模式（新会话从配置读取） */
	async applyPermissionMode(accountId: string, mode: MuPermissionMode): Promise<void> {
		const pool = this.pools.get(accountId);
		if (!pool) return;
		for (const key of pool.keys()) {
			const open = pool.peek(key);
			if (!open || open.session.isStreaming) continue;
			if (!open.session.extensionRunner.getCommand("permissions")) continue;
			await open.session.prompt(`/permissions ${mode} --here`, { source: "extension" });
		}
	}

	/** 当前打开的会话数（诊断用） */
	openSessions(accountId?: string): number {
		if (accountId) return this.pools.get(accountId)?.size ?? 0;
		let total = 0;
		for (const pool of this.pools.values()) total += pool.size;
		return total;
	}

	async closeAccount(accountId: string): Promise<void> {
		await this.pools.get(accountId)?.closeAll();
		this.pools.delete(accountId);
	}

	async closeAll(): Promise<void> {
		for (const accountId of [...this.pools.keys()]) await this.closeAccount(accountId);
	}
}

export { SessionPoolFullError };
