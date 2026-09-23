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

	// /stop：框架级命令（原版由 OpenClaw 处理），中止当前回合
	if ((assembled.rawBody ?? "").trim() === "/stop") {
		const stopped = await runtime.host.abort(conversation);
		await sendText({
			to: qualifiedTarget,
			text: stopped ? "⏹️ 已停止当前任务。" : "ℹ️ 当前没有正在进行的任务。",
			accountId: account.accountId,
			replyToId: envelope.messageId,
			account,
		});
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

	const images = loadInlineImages(ctx.state.processedAttachments as ProcessedAttachments | undefined, dlog);

	try {
		await runtime.host.runTurn(conversation, {
			text: assembled.agentBody,
			images,
			// Q5a：只有明确列在 allowFrom 中的用户，/xxx 才作为 mu 命令执行；其他人的 /xxx 作为普通文本交给模型
			allowCommands: isExplicitAdmin(account, envelope.senderId),
			signal: ctx.signal,
			onPartialText: streamingController
				? async (text) => {
						dlog?.debug(`onPartialReply textLen=${text.length}`);
						await streamingController.onPartialReply(text);
					}
				: undefined,
			deliver: (payload: DeliverPayload, info: DeliverInfo) =>
				deliverDispatchPayloadSafe(payload, info, deliverState),
			// 原 replyOptions 的 agent 事件监控：只记日志，工具名 / 参数不发到 QQ
			onEvent: createAgentEventMonitor(dlog),
		});
	} catch (err) {
		if (err instanceof SessionPoolFullError) {
			dlog?.warn(`session pool full: ${err.message}`);
			await sendText({
				to: qualifiedTarget,
				text: "⚠️ 当前会话数已达上限，请稍后再试。",
				accountId: account.accountId,
				replyToId: envelope.messageId,
				account,
			});
		} else {
			throw err;
		}
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
 * mu 的会话直接接收图片内容：本地图片（≤10MB）作为 ImageContent 附在本轮消息上；路径仍写在消息正文里。
 */
function loadInlineImages(processed: ProcessedAttachments | undefined, log?: PluginLogger): ImageContent[] | undefined {
	if (!processed?.localMediaPaths?.length) return undefined;
	const images: ImageContent[] = [];
	processed.localMediaPaths.forEach((p, i) => {
		const mimeType = processed.localMediaTypes?.[i] ?? "";
		if (!mimeType.startsWith("image/")) return;
		try {
			const stat = fs.statSync(p);
			if (stat.size > MAX_INLINE_IMAGE_BYTES) return;
			images.push({ type: "image", data: fs.readFileSync(p).toString("base64"), mimeType });
		} catch (err) {
			log?.warn(`image not readable: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
	return images.length > 0 ? images : undefined;
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
