/**
 * qqbot_send_media — AI 主动发送图片 / 语音 / 视频 / 文件（mu 移植新增）
 *
 * 原版中 AI 发富媒体的入口在 OpenClaw 框架里：message 工具 / 回复里的 MEDIA 指令，框架把它们变成
 * deliver 的 mediaUrl(s)，再由插件的 outbound.sendMedia / deliver-pipeline 发出。mu 没有这两者，
 * 因此提供这个工具，调用链走原版的统一富媒体入口 outbound/media-send.ts：
 * 类型推断、本地路径白名单（本会话的 workspace 与下载目录、临时目录）、SSRF 防护、语音失败改发文件，全部不变。
 * 发送失败时与原版 deliver-pipeline 一样通知用户「⚠️ 媒体发送失败」，同时把错误返回给模型。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ConversationRef } from "../host.ts";
import { conversationTarget } from "../host.ts";
import { sendMedia } from "../outbound/media-send.ts";
import { type MediaKind, sendText } from "../outbound/outbound-service.ts";
import { getRequestContext } from "../request-context.ts";
import type { ResolvedQQBotAccount } from "../types.ts";
import { createPluginLogger } from "../utils/plugin-logger.ts";

const SendMediaSchema = Type.Object({
	source: Type.String({
		description: "要发送的媒体：公网 URL（http/https）、本地文件路径（相对路径按当前工作目录解析），或 data URL。",
	}),
	kind: Type.Optional(
		Type.Union([Type.Literal("image"), Type.Literal("voice"), Type.Literal("video"), Type.Literal("file")], {
			description:
				"媒体类型；省略时按扩展名推断（图片 jpg/png/gif/webp，语音 mp3/wav/silk，视频 mp4 等，其余为文件）。",
		}),
	),
	text: Type.Optional(Type.String({ description: "随媒体附带的文字（可选）。" })),
});

export function createSendMediaTool(
	ref: ConversationRef,
	getAccount: (accountId: string) => ResolvedQQBotAccount,
): ToolDefinition {
	const log = createPluginLogger({ prefix: `[${ref.accountId}]` }).child("send-media");
	const tool: ToolDefinition<typeof SendMediaSchema> = {
		name: "qqbot_send_media",
		label: "QQBot 发送媒体",
		description:
			"把图片、语音、视频或文件发送到当前 QQ 会话（私聊或群）。" +
			"本地文件须位于当前工作目录或本会话的下载目录内。",
		promptSnippet: "qqbot_send_media: 把图片/语音/视频/文件发到当前 QQ 会话",
		parameters: SendMediaSchema,
		async execute(_toolCallId, params) {
			const to = conversationTarget(ref);
			const ctx = getRequestContext();
			const replyToId = ctx?.target === to ? ctx.messageId : undefined;
			const result = await sendMedia({
				to,
				source: params.source,
				text: params.text,
				mediaKind: params.kind as MediaKind | undefined,
				replyToId,
				accountId: ref.accountId,
				conversation: ref,
				log,
			});
			if (result.error) {
				log.error(`[media] ${result.error}`);
				// 与原版 sendMediaUrls 相同的失败通知
				const notice = await sendText({
					to,
					text: "⚠️ 媒体发送失败（1 个），请重试",
					replyToId,
					account: getAccount(ref.accountId),
				});
				if (notice.error) log.error(`[media] failed to send failure notification: ${notice.error}`);
			}
			const details = {
				ok: !result.error,
				messageId: result.messageId,
				error: result.error,
				fallback: result.fallback,
			};
			const text = result.error
				? `发送失败：${result.error}`
				: result.fallback
					? "语音发送失败，已改为以文件形式发送。"
					: "已发送。";
			return { content: [{ type: "text", text }], details };
		},
	};
	return tool as unknown as ToolDefinition;
}
