/**
 * 消息转发 — 入站消息 → mu 会话
 *
 * 出站两条车道，同时只跑一条：
 *   native-stream  C2C 且开启 QQ 原生流式 → StreamingController 拥有文本
 *   static-blocks  其余情况 → 只有 deliver(kind=block|final) 发送文本
 *
 * mu 适配：原版通过 OpenClaw 的 inbound.run / dispatchReplyWithBufferedBlockDispatcher 把消息交给 AI，
 * 框架回调 deliver(payload, {kind}) 与 replyOptions.onPartialReply。移植后由 QQ 会话宿主在该会话的
 * mu 会话里跑一轮（runTurn），宿主把 mu 的事件按同样的语义回调：
 *   - 助手消息写作中的全文 → onPartialText（等价 onPartialReply）
 *   - 每条写完的助手消息 → deliver(kind=block)
 *   - 回合结束时的最后一条助手文本 → deliver(kind=final)
 * 车道逻辑（dispatch-deliver.ts）、合并发送、流式控制器均原样保留。
 */

import * as fs from "node:fs";
import type { ImageContent } from "@earendil-works/pi-ai";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import type { MiddlewareContext, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { sendChunkedText } from "../channel.ts";
import { clearGroupHistory } from "../features/history-store.ts";
import { type ConversationRef, isExplicitAdmin, SessionPoolFullError } from "../host.ts";
import type { ProcessedAttachments } from "../middleware/attachment.ts";
import { DeliverDebouncer } from "../outbound/debounce.ts";
import {
	type DeliverContext,
	type DeliverInfo,
	type DeliverPayload,
	deliverReply,
} from "../outbound/deliver-pipeline.ts";
import { sendMedia } from "../outbound/media-send.ts";
import { getGateway, sendText } from "../outbound/outbound-service.ts";
import { sanitizeQQBotText } from "../outbound/sanitize.ts";
import { StreamingController, shouldUseStreaming } from "../outbound/streaming-controller.ts";
import type { QQBotRuntime } from "../runtime.ts";
import type { ResolvedQQBotAccount } from "../types.ts";
import type { PluginLogger } from "../utils/plugin-logger.ts";
import { createAgentEventMonitor } from "./agent-events.ts";
import { type AssembledBody, assembleBody } from "./body-assembler.ts";
import { type DispatchDeliverState, deliverDispatchPayloadSafe } from "./dispatch-deliver.ts";
import { buildEnvelope } from "./envelope-builder.ts";

/** 模型直接看图时单张图片上限（超过则只给路径） */
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 将经过中间件处理的入站消息转发给 mu（原 dispatchToOpenClaw）
 */
export async function dispatchToMu(
	ctx: MiddlewareContext,
	msg: QQBotInboundMessage,
	account: ResolvedQQBotAccount,
	runtime: QQBotRuntime,
	log?: PluginLogger,
): Promise<void> {
	const dlog = log?.child("dispatch");
	const envelope = buildEnvelope(ctx, msg, account);

	dlog?.debug(`received sender=${envelope.senderId} scope=${envelope.chatScope} msgId=${envelope.messageId}`);

	const assembled: AssembledBody =
		((ctx.state as Record<string, unknown>).assembledBody as AssembledBody | undefined) ??
		assembleBody(ctx, msg, account);

	const conversation: ConversationRef = {
		accountId: account.accountId,
		scope: envelope.chatScope === "group" ? "group" : "c2c",
		peerId: envelope.chatScope === "group" ? (envelope.groupId ?? envelope.senderId) : envelope.senderId,
	};
	const qualifiedTarget = envelope.targetId;

	const reply = (text: string) =>
		sendText({ to: qualifiedTarget, text, accountId: account.accountId, replyToId: envelope.messageId, account });

	// /stop：框架级命令（原版由 OpenClaw 处理），中止当前回合
	if ((assembled.rawBody ?? "").trim() === "/stop") {
		// mu 修正：群里只有运维者或正在进行的回合的发送者能停止，其他成员不能中止别人的任务
		if (!runtime.host.canStop(conversation, envelope.senderId)) {
			await reply("你不能停止别人发起的任务。");
			return;
		}
		const stopped = await runtime.host.abort(conversation);
		await reply(stopped ? "⏹️ 已停止当前任务。" : "ℹ️ 当前没有正在进行的任务。");
		return;
	}

	// 合并批次的全部发送者：只有全部是运维者，这一轮才可信（斜杠命令、越出会话目录的工具）
	const mergedMessages = (ctx.state as Record<string, unknown>).mergedMessages as MiddlewareContext[] | undefined;
	const senders = mergedMessages?.length
		? [...new Set(mergedMessages.map((each) => String(each.message.senderId)))]
		: [envelope.senderId];
	const allowCommands = senders.every((id) => isExplicitAdmin(account, id));

	// mu 修正：mu 的 /permissions 会绕过 /bot-approve off 的私聊与二次确认限制，不带 --here 时还会改写
	// 终端里 mu 的默认模式（~/.mu/agent/mu/permissions.json），所以在 QQ 里不执行，改用 /bot-approve
	if (allowCommands && /^\/permissions(\s|$)/.test((assembled.rawBody ?? "").trim())) {
		await reply("在 QQ 里请用 /bot-approve 切换审批模式（/bot-approve on | always | off | reset）。");
		return;
	}

	const debounceConfig = account.config?.deliverDebounce;
	const debouncer =
		debounceConfig?.enabled !== false
			? new DeliverDebouncer(debounceConfig, (targetId, mergedText) =>
					sendChunkedText({ to: targetId, text: mergedText, replyToId: envelope.messageId, account }).then(
						() => {},
					),
				)
			: undefined;

	const deliverCtx: DeliverContext = {
		qualifiedTarget,
		accountId: account.accountId,
		replyToId: envelope.messageId,
		chatScope: envelope.chatScope === "group" ? "group" : "direct",
		cfg: runtime.getConfig(),
		debouncer: debouncer?.enabled ? debouncer : undefined,
		// mu 适配：sanitize + 切分（原版由 OpenClaw 在发送前调用 outbound.sanitizeText / chunker）
		sendText: (to, text) => sendChunkedText({ to, text, replyToId: envelope.messageId, account }),
		sendMedia: (to, source, opts) =>
			sendMedia({
				to,
				source,
				text: opts?.text ?? "",
				mediaKind: opts?.mediaKind,
				replyToId: envelope.messageId,
				accountId: account.accountId,
				conversation,
				log: deliverCtx.log,
			}),
		// mu 无 TTS：textToSpeech / audioFileToSilkBase64 留空，audioAsVoice 走原版降级（发文本）
		textToSpeech: undefined,
		audioFileToSilkBase64: undefined,
		log: log?.child("deliver"),
		conversation,
	};

	const streamingEnabled = shouldUseStreaming(account, envelope.chatScope === "group" ? "group" : "c2c");

	const streamingController = streamingEnabled
		? createStreamingController(envelope, account, log?.child("streaming"))
		: null;

	if (streamingController) {
		dlog?.debug(`streaming enabled for ${envelope.senderId}`);
	}

	const deliverState: DispatchDeliverState = {
		ctx: deliverCtx,
		streamingController,
		deliveredMediaUrls: new Set<string>(),
		deliveredTexts: new Set<string>(),
		log: dlog,
		deliverReply,
	};

	const inline = await loadInlineImages(ctx.state.processedAttachments as ProcessedAttachments | undefined, dlog);
	const images = inline.images.length > 0 ? inline.images : undefined;
	const text = inline.notes.length > 0 ? `${assembled.agentBody}\n${inline.notes.join("\n")}` : assembled.agentBody;

	try {
		await runtime.host.runTurn(conversation, {
			text,
			images,
			senders,
			// Q5a：只有明确列在 allowFrom 中的用户，/xxx 才作为 mu 命令执行；其他人的 /xxx 作为普通文本交给模型
			allowCommands,
			signal: ctx.signal,
			onPartialText: streamingController
				? async (text) => {
						dlog?.debug(`onPartialReply textLen=${text.length}`);
						const clean = sanitizeStreamingText(text);
						if (clean) await streamingController.onPartialReply(clean);
					}
				: undefined,
			deliver: async (payload: DeliverPayload, info: DeliverInfo) => {
				// 一条助手消息写完：下一条（工具调用之后）另开一条流
				if (info.kind === "block" && streamingController && !streamingController.isTerminal) {
					await streamingController.endMessage();
				}
				await deliverDispatchPayloadSafe(payload, info, deliverState);
			},
			// 原 replyOptions 的 agent 事件监控：只记日志，工具名 / 参数不发到 QQ
			onEvent: createAgentEventMonitor(dlog),
		});
	} catch (err) {
		if (err instanceof SessionPoolFullError) {
			dlog?.warn(`session pool full: ${err.message}`);
			await reply("⚠️ 当前会话数已达上限，请稍后再试。");
		} else {
			// mu 修正：打开会话失败时原先只记日志，用户收不到任何回复
			dlog?.error(`turn failed: ${err instanceof Error ? err.message : String(err)}`);
			await reply("⚠️ 处理这条消息时出错了，请稍后再试。").catch(() => {});
		}
	}

	// processingTimeoutMs 到时，SDK 中止了这一轮：告诉用户，而不是一言不发
	const abortReason = ctx.signal?.aborted ? String(ctx.signal.reason ?? "") : "";
	if (abortReason.includes("timeout")) {
		await reply("处理超时，本轮已中止。").catch(() => {});
	}

	dlog?.debug(`turn completed conversation=${conversation.scope}:${conversation.peerId}`);

	if (envelope.chatScope === "group") {
		clearGroupHistory(account.accountId, envelope.groupId ?? envelope.senderId);
	}

	if (streamingController && !streamingController.isTerminal) {
		await streamingController.finalize();
	}

	if (debouncer) {
		await debouncer.flushAll();
	}
}

/**
 * mu 适配：原版把下载的图片路径作为 MediaPaths 交给 OpenClaw，由框架决定是否给模型看图。
 * mu 的会话直接接收图片内容：本地图片作为 ImageContent 附在本轮消息上；路径仍写在消息正文里。
 * mu 修正：图片按内容判断格式，并像 pi 自己的图片入口一样缩放到 2000 px / 4.5 MB 以内；原先原样附上，
 * 超出模型限制的图片会让这个会话以后的每一轮都失败（图片留在会话记录里，每轮重发）。
 */
async function loadInlineImages(
	processed: ProcessedAttachments | undefined,
	log?: PluginLogger,
): Promise<{ images: ImageContent[]; notes: string[] }> {
	const images: ImageContent[] = [];
	const notes: string[] = [];
	const paths = processed?.localMediaPaths ?? [];
	for (const [i, p] of paths.entries()) {
		if (!(processed?.localMediaTypes?.[i] ?? "").startsWith("image/")) continue;
		try {
			if (fs.statSync(p).size > MAX_INLINE_IMAGE_BYTES) continue;
			const bytes = fs.readFileSync(p);
			const mimeType = sniffImageType(bytes);
			if (!mimeType) {
				notes.push(`[图片 ${p} 的格式不能直接给模型看]`);
				continue;
			}
			const resized = await resizeImage(bytes, mimeType);
			if (!resized) {
				notes.push(`[图片 ${p} 太大，无法直接给模型看]`);
				continue;
			}
			images.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
			const note = formatDimensionNote(resized);
			if (note) notes.push(note);
		} catch (err) {
			log?.warn(`image not readable: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { images, notes };
}

/**
 * 流式通道的清洗（mu 修正：原先流式直接发送模型原文，<think> / <thinking> / <system-reminder> 块会出现在
 * 私聊里；静态通道一直经 sanitizeQQBotText）。流式时闭合标签可能还没到：从尚未闭合的内部块起截掉，
 * 其余与静态通道一样清洗。
 */
function sanitizeStreamingText(text: string): string {
	const open = /<\s*(think|thinking|system-reminder|previous_response)\b[^>]*>|`think`/gi;
	let cut = text.length;
	for (let match = open.exec(text); match; match = open.exec(text)) {
		if (match[0].endsWith("/>")) continue;
		const rest = text.slice(match.index + match[0].length);
		const closed = match[1] ? new RegExp(`<\\s*/\\s*${match[1]}\\s*>`, "i").test(rest) : rest.includes("`/think`");
		if (!closed) {
			cut = match.index;
			break;
		}
	}
	return sanitizeQQBotText(text.slice(0, cut));
}

/** 按文件头判断图片格式（QQ 给的 content_type 不可靠）；只认模型接受的四种 */
function sniffImageType(bytes: Buffer): string | undefined {
	if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6 && bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
		bytes.subarray(8, 12).toString("latin1") === "WEBP"
	)
		return "image/webp";
	return undefined;
}

function createStreamingController(
	envelope: ReturnType<typeof buildEnvelope>,
	account: ResolvedQQBotAccount,
	log?: PluginLogger,
): StreamingController | null {
	const gw = getGateway(account.accountId);
	if (!gw) {
		log?.error(`cannot enable streaming — gateway not running`);
		return null;
	}
	return new StreamingController({
		gateway: gw,
		target: {
			scope: "c2c",
			targetId: envelope.senderId,
			msgId: envelope.messageId,
		},
		accountId: account.accountId,
		replyToId: envelope.messageId,
		log,
	});
}
