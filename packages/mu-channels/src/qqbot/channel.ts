/**
 * QQ Bot 通道出站文本处理
 *
 * mu 适配：原版此文件定义 OpenClaw 的 ChannelPlugin 对象（meta / config / setup / outbound / gateway / status 等
 * 钩子），由框架调用。移植后这些钩子分别对应：
 *   - config / setup / auth / gateway.login*        → `mu qqbot login|logout|status`（cli.ts）
 *   - gateway.startAccount / stopAccount            → `mu qqbot start`（cli.ts → gateway/lifecycle.ts）
 *   - groups.resolveRequireMention / resolveToolPolicy / resolveGroupIntroHint → policy-injector.ts、host.ts
 *   - outbound.sanitizeText + chunker + textChunkLimit → 本文件 sendChunkedText（原版由框架在发送前调用）
 *   - messaging.normalizeTarget                     → outbound/target.ts（`mu qqbot send` 使用）
 * 表格感知切分为原版 outbound.chunker 的降级实现（框架 chunkMarkdownText 不可用时使用），原样保留。
 */

import { getAdapters } from "./adapter/resolve.ts";
import { type SendResult, sendText } from "./outbound/outbound-service.ts";
import { sanitizeQQBotText } from "./outbound/sanitize.ts";
import { getQQBotRuntime } from "./runtime.ts";
import type { ResolvedQQBotAccount } from "./types.ts";

/** QQ Bot 单条消息文本长度上限 */
export const TEXT_CHUNK_LIMIT = 5000;

// ── GFM 表格检测 ──

/** GFM 表格数据行: | col1 | col2 | */
const GFM_TABLE_DATA_RE = /^\|.+\|.*\|/;
/** GFM 表格分隔行: |---|:---:|---| (1 个或多于 1 个破折号，支持对齐冒号) */
const GFM_TABLE_SEP_RE = /^\|[\s:-]+\|/;

/**
 * 判断一行是否为 GFM 表格行（数据行或分隔行）。
 * 保障 table-aware chunker 不会在表格内部切分。
 */
function isGfmTableLine(line: string): boolean {
	return GFM_TABLE_DATA_RE.test(line) || GFM_TABLE_SEP_RE.test(line);
}

/** 原版 outbound.chunker */
export function chunkText(text: string, limit: number): string[] {
	const adapters = getAdapters(tryRuntime());
	if (adapters.chunkMarkdownText) return adapters.chunkMarkdownText(text, limit);
	// fallback（低版本降级）: 按换行边界切分，保留 Markdown 表格完整性
	const lines = text.split("\n");
	const chunks: string[] = [];
	let current = "";
	let tableBuffer: string[] = [];

	const flushTable = () => {
		if (tableBuffer.length === 0) return;
		const tableBlock = tableBuffer.join("\n");
		const candidate = current ? `${current}\n${tableBlock}` : tableBlock;
		if (candidate.length > limit && current) {
			chunks.push(current);
			current = tableBlock;
		} else {
			current = candidate;
		}
		tableBuffer = [];
	};

	for (const line of lines) {
		if (isGfmTableLine(line)) {
			tableBuffer.push(line);
			continue;
		}

		// 遇到非表格行，先刷新缓冲的表格
		flushTable();

		const candidate = current ? `${current}\n${line}` : line;
		if (candidate.length > limit && current) {
			chunks.push(current);
			current = line;
		} else {
			current = candidate;
		}
	}
	// 处理末尾的表格缓冲
	flushTable();
	if (current) chunks.push(current);
	return chunks.length > 0 ? chunks : [text];
}

/** Room kept in each piece for the fence lines fitChunks may add. */
const FENCE_ROOM = 32;

/**
 * mu 修正：原版的降级切分只在换行处切，超过上限的单行或表格原样发出（QQ 拒收），切在代码块中间时两段都失去
 * 代码格式。这里对切分结果补一道：仍超限的段按上限硬切（尽量在换行处、不拆 UTF-16 代理对），被切开的
 * 代码块在前一段末尾闭合、在后一段开头按原语言重新打开。
 */
export function fitChunks(chunks: readonly string[], limit: number): string[] {
	const pieces: string[] = [];
	for (const chunk of chunks) {
		let rest = chunk;
		const max = Math.max(1, limit - FENCE_ROOM);
		while (rest.length > max) {
			let cut = rest.lastIndexOf("\n", max);
			if (cut < max / 2) cut = max;
			const code = rest.charCodeAt(cut);
			if (code >= 0xdc00 && code <= 0xdfff) cut--;
			pieces.push(rest.slice(0, cut));
			rest = rest.slice(cut).replace(/^\n/, "");
		}
		if (rest) pieces.push(rest);
	}
	const out: string[] = [];
	let openFence: string | undefined;
	for (const piece of pieces) {
		let text = openFence !== undefined ? `${openFence}\n${piece}` : piece;
		for (const line of piece.split("\n")) {
			const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);
			if (!fence) continue;
			openFence = openFence === undefined ? `${fence[1]}${fence[2]?.trim() ?? ""}` : undefined;
		}
		if (openFence !== undefined) text += `\n${openFence.replace(/[^`~].*$/, "")}`;
		out.push(text);
	}
	return out;
}

function tryRuntime() {
	try {
		return getQQBotRuntime();
	} catch {
		return null;
	}
}

/**
 * 发送文本：sanitize → 按 TEXT_CHUNK_LIMIT 切分 → 逐段发送（对应原版框架对 outbound.sanitizeText / chunker 的调用）。
 * 返回最后一段的结果；任一段失败即停止并返回该错误。
 */
export async function sendChunkedText(params: {
	to: string;
	text: string;
	replyToId?: string;
	account: ResolvedQQBotAccount;
}): Promise<SendResult> {
	const clean = sanitizeQQBotText(params.text);
	if (!clean) return {};
	let last: SendResult = {};
	for (const chunk of fitChunks(chunkText(clean, TEXT_CHUNK_LIMIT), TEXT_CHUNK_LIMIT)) {
		last = await sendText({ to: params.to, text: chunk, replyToId: params.replyToId, account: params.account });
		if (last.error) return last;
	}
	return last;
}

// Re-export for backward compatibility
export { detectWasMentioned, stripMentionText } from "./utils/mention.ts";
