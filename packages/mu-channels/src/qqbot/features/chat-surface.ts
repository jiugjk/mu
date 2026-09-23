/**
 * QQ 问答界面 — 把 mu 会话里的问题（审批、选择、确认、文字输入）发到 QQ。
 *
 * mu 适配：替代原版 features/approval-handler.ts。原版通过 OpenClaw 网关（gateway-runtime）监听
 * exec.approval.requested / plugin.approval.requested，发出带 Inline Keyboard 的审批消息，点击后调用
 * exec.approval.resolve。mu 的审批不走网关，而是扩展（权限模式、风险命令守卫、MCP、checkpoint）调用
 * ctx.ui.select / confirm；渠道宿主（src/host/chat-ui.ts）把这些调用交给本文件发到 QQ。
 *
 * 保留原版的按钮形态：回调型按钮（type=1），同组互斥（group_id），每人点一次（click_limit=1），
 * 所有人可见可点（permission.type=2），点击后在服务端校验操作者是否在 allowFrom 中。
 * 另外在正文里列出序号：平台未开通按钮时，回复序号同样可以作答。
 */
import type { ChatPrompt, ChatSurface } from "../../host/chat-ui.ts";
import type { ConversationRef } from "../host.ts";
import { sendText, sendTextWithKeyboard } from "../outbound/outbound-service.ts";
import { getRequestContext } from "../request-context.ts";
import type { InlineKeyboard, KeyboardButton, ResolvedQQBotAccount } from "../types.ts";
import type { PluginLogger } from "../utils/plugin-logger.ts";
import { getCachedMsgId } from "./msgid-cache.ts";

const BUTTON_PREFIX = "mu:";
const MAX_BUTTONS_PER_ROW = 3;
const MAX_ROWS = 5;
const MAX_LABEL = 20;

/** 按钮 data：mu:<promptId>:<选项序号> */
export function buildChatButtonData(promptId: string, index: number): string {
	return `${BUTTON_PREFIX}${promptId}:${index}`;
}

export function parseChatButtonData(data: string | undefined): { promptId: string; index: number } | null {
	if (!data?.startsWith(BUTTON_PREFIX)) return null;
	const [promptId, index] = data.slice(BUTTON_PREFIX.length).split(":");
	const n = Number(index);
	if (!promptId || !Number.isInteger(n) || n < 0) return null;
	return { promptId, index: n };
}

function clipLabel(label: string): string {
	const oneLine = label.replace(/\s+/g, " ").trim();
	return oneLine.length > MAX_LABEL ? `${oneLine.slice(0, MAX_LABEL - 1)}…` : oneLine;
}

/** 拒绝 / 取消类选项用灰色，其余蓝色（对齐原版：允许为 1，拒绝为 0） */
function styleFor(option: string): 0 | 1 {
	return /拒绝|取消|不允许|deny|cancel|no\b/i.test(option) ? 0 : 1;
}

/** 与原版 buildApprovalKeyboard 同形态，选项数不定（最多 15 个按钮，超出只用序号作答） */
export function buildChatKeyboard(prompt: ChatPrompt): InlineKeyboard | undefined {
	if (prompt.options.length === 0 || prompt.options.length > MAX_BUTTONS_PER_ROW * MAX_ROWS) return undefined;
	const buttons: KeyboardButton[] = prompt.options.map((option, index) => ({
		id: `${prompt.id}-${index}`,
		render_data: { label: clipLabel(option), visited_label: `已选: ${clipLabel(option)}`, style: styleFor(option) },
		action: {
			type: 1,
			data: buildChatButtonData(prompt.id, index),
			permission: { type: 2 },
			click_limit: 1,
		},
		group_id: `mu-${prompt.id}`,
	}));
	const rows = [];
	for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
		rows.push({ buttons: buttons.slice(i, i + MAX_BUTTONS_PER_ROW) });
	}
	return { content: { rows } };
}

/** 问题正文：标题、说明、带序号的选项、作答提示 */
export function buildChatPromptText(prompt: ChatPrompt, timeoutSeconds: number): string {
	const lines = [`🔐 ${prompt.title}`];
	if (prompt.message?.trim()) lines.push("", prompt.message.trim());
	if (prompt.kind === "input") {
		lines.push("", "请直接回复文字作答。");
	} else {
		lines.push("");
		for (const [index, option] of prompt.options.entries()) lines.push(`${index + 1}. ${option}`);
		lines.push("", "点击按钮或回复序号作答。");
	}
	const minutes = Math.round(timeoutSeconds / 60);
	if (timeoutSeconds > 0)
		lines.push(`⏱️ ${minutes >= 1 ? `${minutes} 分钟` : `${timeoutSeconds} 秒`}内未作答按拒绝处理。`);
	return lines.join("\n");
}

export function createQQChatSurface(params: {
	ref: ConversationRef;
	getAccount: () => ResolvedQQBotAccount;
	log: PluginLogger;
}): ChatSurface {
	const { ref, log } = params;
	const to = `qqbot:${ref.scope}:${ref.peerId}`;
	const replyToId = () => {
		const ctx = getRequestContext();
		return ctx?.target === to ? ctx.messageId : getCachedMsgId(ref.scope, ref.peerId);
	};

	return {
		async ask(prompt) {
			const account = params.getAccount();
			const text = buildChatPromptText(prompt, account.config.approvalTimeoutSeconds ?? 600);
			const keyboard = buildChatKeyboard(prompt);
			if (keyboard) {
				const sent = await sendTextWithKeyboard({ to, text, keyboard, replyToId: replyToId(), account });
				if (!sent.error) {
					log.info(`sent prompt ${prompt.id} with keyboard to ${ref.scope}:${ref.peerId}`);
					return;
				}
				// 按钮需平台开通；失败时退回纯文本（序号作答）
				log.warn(`keyboard send failed (${sent.error}), falling back to text`);
			}
			const result = await sendText({ to, text, replyToId: replyToId(), account });
			if (result.error) throw new Error(result.error);
		},
		notify(message) {
			const account = params.getAccount();
			void sendText({ to, text: message, replyToId: replyToId(), account }).then((result) => {
				if (result.error) log.warn(`notify failed: ${result.error}`);
			});
		},
		settled(prompt, answer, by) {
			log.info(`prompt ${prompt.id} settled answer=${answer ?? "(default)"} by=${by ?? "-"}`);
		},
	};
}
