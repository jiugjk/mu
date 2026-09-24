/**
 * 出站投递车道：static-blocks 与 native-stream 同时只跑一条。
 *
 * kind=block 文本在流未占用时立即发；流已占用则跳过。
 * kind=tool 只转发新媒体。
 * kind=final 与已发 block 去重；流占用时收尾后跳过静态文本。
 */

import type { DeliverContext, DeliverInfo, DeliverPayload } from "../outbound/deliver-pipeline.ts";
import { formatLogTextPreview } from "../utils/log-text-preview.ts";
import type { PluginLogger } from "../utils/plugin-logger.ts";

export type StreamTextOwner = {
	hasStarted: boolean;
	shouldFallbackToStatic: boolean;
	isTerminal: boolean;
	/** mu 修正：流中途失败；余下文本走静态发送 */
	failedMidway?: boolean;
	/** 失败前这条流里已显示的文本 */
	acceptedText?: string;
	finalize(): Promise<void>;
};

export type DispatchDeliverState = {
	ctx: DeliverContext;
	streamingController: StreamTextOwner | null;
	deliveredMediaUrls: Set<string>;
	deliveredTexts: Set<string>;
	log?: PluginLogger;
	deliverReply: (payload: DeliverPayload, info: DeliverInfo | undefined, ctx: DeliverContext) => Promise<void>;
};

export function streamOwnsText(controller: StreamTextOwner | null): boolean {
	return Boolean(controller?.hasStarted && !controller.shouldFallbackToStatic && !controller.failedMidway);
}

/** 流中途失败后，去掉已在流里显示的开头，只发余下的部分 */
function afterStreamed(text: string, controller: StreamTextOwner | null): string {
	const shown = controller?.failedMidway ? (controller.acceptedText ?? "") : "";
	return shown && text.startsWith(shown) ? text.slice(shown.length).trim() : text;
}

export async function deliverDispatchPayload(
	payload: DeliverPayload,
	info: DeliverInfo | undefined,
	state: DispatchDeliverState,
): Promise<void> {
	const kind = info?.kind;
	const text = payload.text?.trim() ?? "";
	const hasMedia = !!(payload.mediaUrl || payload.mediaUrls?.length);
	const sendReply = state.deliverReply;
	state.log?.debug(
		`deliver kind=${kind ?? "none"} textLen=${text.length} voice=${!!payload.audioAsVoice} media=${hasMedia}${formatLogTextPreview(text)}`,
	);

	if (kind === "tool") {
		await forwardMediaUrls(payload, state);
		return;
	}

	if (kind === "block") {
		if (payload.audioAsVoice) {
			await sendReply(payload, info, state.ctx);
			if (text) state.deliveredTexts.add(text);
			return;
		}
		await forwardMediaUrls(payload, state);
		if (streamOwnsText(state.streamingController) || !text || state.deliveredTexts.has(text)) {
			return;
		}
		const rest = afterStreamed(text, state.streamingController);
		if (rest) await sendReply({ text: rest }, info, state.ctx);
		state.deliveredTexts.add(text);
		return;
	}

	if (streamOwnsText(state.streamingController)) {
		if (state.streamingController && !state.streamingController.isTerminal) {
			await state.streamingController.finalize();
		}
		if (!state.streamingController?.shouldFallbackToStatic) {
			return;
		}
		state.log?.warn(`streaming fallback to static`);
	}

	if (text && state.deliveredTexts.has(text) && !hasMedia && !payload.audioAsVoice) {
		return;
	}

	const filteredPayload = filterDeliveredMedia(payload, state.deliveredMediaUrls);
	const rest = text ? afterStreamed(text, state.streamingController) : "";
	const payloadToSend =
		text && (state.deliveredTexts.has(text) || !rest)
			? { ...filteredPayload, text: undefined }
			: rest !== text
				? { ...filteredPayload, text: rest }
				: filteredPayload;
	await sendReply(payloadToSend, info, state.ctx);
	if (text) state.deliveredTexts.add(text);
	for (const u of payloadToSend.mediaUrls ?? []) state.deliveredMediaUrls.add(u);
	if (payloadToSend.mediaUrl) state.deliveredMediaUrls.add(payloadToSend.mediaUrl);
}

export async function deliverDispatchPayloadSafe(
	payload: DeliverPayload,
	info: DeliverInfo | undefined,
	state: DispatchDeliverState,
): Promise<void> {
	try {
		await deliverDispatchPayload(payload, info, state);
	} catch (err) {
		state.log?.error(`deliver error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function forwardMediaUrls(payload: DeliverPayload, state: DispatchDeliverState): Promise<void> {
	const urls: string[] = [];
	if (payload.mediaUrls?.length) urls.push(...payload.mediaUrls);
	if (payload.mediaUrl && !urls.includes(payload.mediaUrl)) urls.push(payload.mediaUrl);
	const newUrls = urls.filter((u) => !state.deliveredMediaUrls.has(u));
	for (const url of newUrls) {
		try {
			await state.ctx.sendMedia(state.ctx.qualifiedTarget, url, { text: "" });
			state.deliveredMediaUrls.add(url);
		} catch (err) {
			state.log?.error(`media forward failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

export function filterDeliveredMedia(payload: DeliverPayload, delivered: Set<string>): DeliverPayload {
	if (delivered.size === 0) return payload;
	return {
		...payload,
		mediaUrl: payload.mediaUrl && !delivered.has(payload.mediaUrl) ? payload.mediaUrl : undefined,
		mediaUrls: payload.mediaUrls?.filter((u) => !delivered.has(u)),
	};
}
