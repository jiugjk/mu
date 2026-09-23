/**
 * 统一富媒体发送入口
 *
 * 职责：
 *   1. 路径安全校验（只允许白名单目录下的本地文件）
 *   2. 类型推断（扩展名 / MIME / 显式指定）
 *   3. 路由分发（image / voice / video / file）
 *   4. 语音发送失败 fallback 到文件
 *
 * 所有出站媒体发送（channel.outbound.sendMedia / deliver pipeline / Message 工具）
 * 统一经过此入口。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import type { QQBotGateway } from "../gateway/index.ts";
import type { ConversationRef } from "../host.ts";
import { tryGetQQBotRuntime } from "../runtime.ts";
import type { PluginLogger } from "../utils/plugin-logger.ts";
import { validateRemoteUrl } from "../utils/ssrf-guard.ts";
import {
	inferMediaKind,
	inferMediaKindFromMime,
	isDataUrl,
	isLocalFilePath,
	isPathInAllowedRoots,
	normalizePath,
} from "./local-file-router.ts";
import type { MediaKind } from "./outbound-service.ts";
import { getGateway } from "./outbound-service.ts";
import { parseTarget } from "./target.ts";

// ── 类型 ──

export interface SendMediaParams {
	/** 目标 (qqbot:c2c:xxx / qqbot:group:xxx) */
	to: string;
	/** 媒体源（URL / 本地路径 / data URL） */
	source: string;
	/** 附带文本 */
	text?: string;
	/** 显式指定类型（优先级最高） */
	mediaKind?: MediaKind;
	/** MIME type 提示（优先级次于 mediaKind） */
	mimeType?: string;
	/** 被动回复 ID */
	replyToId?: string;
	/** 账户 ID */
	accountId: string;
	/** 日志 */
	log?: PluginLogger;
	/** 会话（mu 适配：原版为 agentId；用于解析该会话的工作区与允许发送的目录） */
	conversation?: ConversationRef;
	/**
	 * 本地路径由主机上的人直接给出（`mu qqbot send --media`），不受目录白名单限制。
	 * 白名单约束的是 AI 选择的路径；AI 调用的入口（工具、deliver）从不设置它。
	 */
	trustedLocalPath?: boolean;
}

export interface SendMediaResult {
	messageId?: string;
	error?: string;
	/** 是否走了 fallback 路径 */
	fallback?: boolean;
}

// ── 安全常量 ──

/** 收集临时目录根路径：os.tmpdir + Unix /tmp（处理 macOS /tmp→/private/tmp 符号链接） */
function resolveTempRoots(): string[] {
	const roots = new Set<string>();
	try {
		const tmp = os.tmpdir();
		roots.add(fs.existsSync(tmp) ? fs.realpathSync(tmp) : tmp);
	} catch {
		/* skip */
	}
	// Unix: 解析 /tmp 真实路径，覆盖 macOS 符号链接场景
	if (process.platform !== "win32") {
		try {
			roots.add(fs.realpathSync("/tmp"));
		} catch {
			/* skip */
		}
	}
	return [...roots];
}

/**
 * 构建动态白名单目录列表。
 *
 * mu 适配（按会话隔离）：原版允许 ~/.openclaw 下的 media / workspace / outbound 以及当前 agent 工作区；
 * 移植后只允许本会话自己的 workspace 与下载目录，以及系统临时目录（与原版一致）。
 * 其他私聊 / 群的目录不在白名单内。
 */
function buildDynamicAllowedRoots(dirs?: { workspace: string; media: string }): string[] {
	const roots: string[] = [];
	const added = new Set<string>();

	const addRoot = (p: string) => {
		try {
			const real = fs.existsSync(p) ? fs.realpathSync(p) : p;
			if (!added.has(real)) {
				added.add(real);
				roots.push(real);
			}
		} catch {
			/* skip */
		}
	};

	if (dirs) {
		addRoot(dirs.workspace);
		addRoot(dirs.media);
	}

	// 临时目录
	for (const t of resolveTempRoots()) addRoot(t);

	return roots;
}

/** 入站 Base64 / Data URL 最大字节数（10MB） */
const MAX_DATA_URL_BYTES = 10 * 1024 * 1024;

// ── 统一入口 ──

/**
 * 统一富媒体发送入口
 */
export async function sendMedia(params: SendMediaParams): Promise<SendMediaResult> {
	const { source, accountId, log } = params;
	const mlog = log?.child("media");

	if (!source) {
		mlog?.error("source is empty");
		return { error: "sendMedia: source is required" };
	}

	// 1. 安全校验 + 路径规范化
	const dirs = resolveConversationDirs(params.conversation);
	mlog?.debug(`resolveMediaPath source=${source} workspaceDir=${dirs?.workspace ?? "none"}`);
	const resolved = await resolveMediaPath(source, mlog, dirs, params.trustedLocalPath === true);
	if (!resolved.ok) {
		mlog?.error(`resolveMediaPath failed: ${resolved.error}`);
		return { error: resolved.error };
	}

	// 2. 推断类型
	const kind =
		params.mediaKind ??
		(params.mimeType ? inferMediaKindFromMime(params.mimeType) : undefined) ??
		inferMediaKind(resolved.path);

	// 3. 获取 gateway
	const gw = getGateway(accountId);
	if (!gw) {
		return { error: `Bot "${accountId}" not running` };
	}

	const target = parseTarget(params.to);

	// 4. 路由分发
	switch (kind) {
		case "voice":
			return sendVoiceMedia(gw, target, resolved.path, params);
		case "video":
			return sendVideoMedia(gw, target, resolved.path, params);
		case "file":
			return sendFileMedia(gw, target, resolved.path, params);
		default:
			return sendImageMedia(gw, target, resolved.path, params);
	}
}

// ── 路径安全校验 ──

interface ResolveResult {
	ok: true;
	path: string;
	isLocal: boolean;
}

interface ResolveError {
	ok: false;
	error: string;
}

async function resolveMediaPath(
	source: string,
	log?: SendMediaParams["log"],
	dirs?: { workspace: string; media: string },
	trusted = false,
): Promise<ResolveResult | ResolveError> {
	const workspaceDir = dirs?.workspace;
	const normalized = normalizePath(source);

	// Data URL → 大小限制检查
	if (isDataUrl(normalized)) {
		if (normalized.length > MAX_DATA_URL_BYTES) {
			const sizeMB = (normalized.length / (1024 * 1024)).toFixed(1);
			return { ok: false, error: `Data URL 过大（${sizeMB}MB，最大 10MB）` };
		}
		return { ok: true, path: normalized, isLocal: false };
	}

	// 远程 URL → SSRF 安全检查
	if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
		try {
			await validateRemoteUrl(normalized);
		} catch (err) {
			log?.warn(`SSRF blocked for media URL: ${normalized}`);
			return { ok: false, error: `媒体 URL 被 SSRF 防护拦截: ${err instanceof Error ? err.message : String(err)}` };
		}
		return { ok: true, path: normalized, isLocal: false };
	}

	// 纯文件名→工作区兜底查找
	if (!isLocalFilePath(normalized)) {
		const resolved = resolveWorkingFile(normalized, workspaceDir);
		if (resolved) {
			return { ok: true, path: resolved, isLocal: true };
		}
		return { ok: true, path: normalized, isLocal: false };
	}

	// 本地路径 → 安全校验
	// mu 适配：相对路径按会话工作区（模型的 cwd）解析，而不是宿主进程的 cwd
	const resolved = workspaceDir ? path.resolve(workspaceDir, normalized) : path.resolve(normalized);
	if (!fs.existsSync(resolved)) {
		return { ok: false, error: `File not found: ${resolved}` };
	}

	let real: string;
	try {
		real = fs.realpathSync(resolved);
	} catch {
		return { ok: false, error: `Cannot resolve path: ${resolved}` };
	}

	if (trusted) return { ok: true, path: real, isLocal: true };

	// 动态白名单：静态根目录 + 当前 agent 工作区
	const dynamicRoots = buildDynamicAllowedRoots(dirs);
	const allowed = isPathInAllowedRoots(real, dynamicRoots);

	if (!allowed) {
		log?.warn(`path blocked — not in allowed directory: ${real}`);
		return { ok: false, error: `文件路径不在允许的目录中` };
	}

	return { ok: true, path: real, isLocal: true };
}

/** 会话 → 工作区与下载目录（mu 适配：原版经 plugin-sdk/health 由 agentId 解析工作区） */
function resolveConversationDirs(conversation?: ConversationRef): { workspace: string; media: string } | undefined {
	if (!conversation) return undefined;
	const rt = tryGetQQBotRuntime();
	return rt?.host.dirsFor(conversation);
}

/** 纯文件名在工作区兜底查找（mu 适配：原版先查进程 cwd；按会话隔离后只查本会话工作区） */
function resolveWorkingFile(name: string, workspaceDir?: string): string | null {
	for (const p of [workspaceDir ? path.join(workspaceDir, name) : null]) {
		if (p && fs.existsSync(p)) return p;
	}
	return null;
}

// ── 各类型 sender ──

async function sendImageMedia(
	gw: QQBotGateway,
	target: ReplyTarget,
	source: string,
	params: SendMediaParams,
): Promise<SendMediaResult> {
	try {
		const result = await gw.sendMedia(target, source, {
			text: params.text,
			msgId: params.replyToId,
		});
		return { messageId: result.id };
	} catch (err) {
		return { error: formatErr(err) };
	}
}

async function sendVoiceMedia(
	gw: QQBotGateway,
	target: ReplyTarget,
	source: string,
	params: SendMediaParams,
): Promise<SendMediaResult> {
	// 语音源路由：本地 → { localPath }，URL → { url }，其他 → { base64 }
	const voiceSource = resolveVoiceSource(source);

	try {
		const result = await gw.sendVoice(target, voiceSource, {
			msgId: params.replyToId,
		});
		return { messageId: result.id };
	} catch (err) {
		// 语音失败 → fallback 到文件发送
		params.log?.child("media")?.warn(`sendVoice failed (${formatErr(err)}), falling back to sendFile`);
		try {
			const fileName = path.basename(source);
			const fallback = await gw.sendFile(target, source, {
				text: params.text,
				msgId: params.replyToId,
				fileName,
			});
			return { messageId: fallback.id, fallback: true };
		} catch (fallbackErr) {
			return { error: `voice: ${formatErr(err)} | fallback file: ${formatErr(fallbackErr)}` };
		}
	}
}

async function sendVideoMedia(
	gw: QQBotGateway,
	target: ReplyTarget,
	source: string,
	params: SendMediaParams,
): Promise<SendMediaResult> {
	try {
		const result = await gw.sendVideo(target, source, {
			text: params.text,
			msgId: params.replyToId,
		});
		return { messageId: result.id };
	} catch (err) {
		return { error: formatErr(err) };
	}
}

async function sendFileMedia(
	gw: QQBotGateway,
	target: ReplyTarget,
	source: string,
	params: SendMediaParams,
): Promise<SendMediaResult> {
	try {
		const fileName = path.basename(source);
		const result = await gw.sendFile(target, source, {
			text: params.text,
			msgId: params.replyToId,
			fileName,
		});
		return { messageId: result.id };
	} catch (err) {
		return { error: formatErr(err) };
	}
}

// ── 辅助 ──

function resolveVoiceSource(source: string): { url?: string; base64?: string; localPath?: string } {
	if (source.startsWith("http://") || source.startsWith("https://")) {
		return { url: source };
	}
	if (
		source.startsWith("data:") ||
		(!source.startsWith("/") && !source.startsWith("./") && !source.startsWith("../") && !source.startsWith("~"))
	) {
		// data URL 或纯 base64 字符串
		const commaIdx = source.indexOf(",");
		return { base64: commaIdx > 0 ? source.slice(commaIdx + 1) : source };
	}
	return { localPath: source };
}

function formatErr(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
