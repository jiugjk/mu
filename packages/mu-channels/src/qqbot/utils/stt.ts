/**
 * STT (Speech-to-Text) 语音转文字服务
 *
 * 支持 OpenAI 兼容的 /audio/transcriptions 接口。
 * 配置优先级：
 *   1. channels.qqbot.stt（插件级）
 *   2. 框架级 audio model 配置
 *
 * mu 适配：mu.json 中没有 OpenClaw 的 models.providers / tools.media.audio，第 2 步改为
 * 使用 mu 自己的 provider 凭据（stt.provider，默认 openai）：由 resolveSTTConfigWithProvider 通过
 * QQBotRuntime.providerAuth 从 mu 的 auth.json / 环境变量 / models.json 取 apiKey 与 baseUrl。
 * 凭据只来自配置或环境变量，不写日志。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface STTConfig {
	enabled: boolean;
	baseUrl: string;
	apiKey: string;
	model: string;
}

/**
 * 从 OpenClaw 配置中解析 STT 设置
 */
export function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
	const channels = asRecord(cfg.channels);
	const qqbot = asRecord(channels?.qqbot);
	const sttCfg = asRecord(qqbot?.stt);

	// 显式禁用
	if (sttCfg?.enabled === false) {
		return null;
	}

	const models = asRecord(cfg.models);
	const providers = asRecord(models?.providers);

	// 1. 插件级 STT 配置
	if (sttCfg) {
		const providerId = readString(sttCfg, "provider") ?? "openai";
		const providerCfg = asRecord(providers?.[providerId]);
		const baseUrl = readString(sttCfg, "baseUrl") ?? readString(providerCfg, "baseUrl");
		const apiKey = readString(sttCfg, "apiKey") ?? readString(providerCfg, "apiKey");
		const model = readString(sttCfg, "model") ?? "whisper-1";
		if (baseUrl && apiKey) {
			return { enabled: true, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
		}
	}

	// 2. 框架级 audio model fallback
	const tools = asRecord(cfg.tools);
	const media = asRecord(tools?.media);
	const audio = asRecord(media?.audio);
	const audioModels = audio?.models;
	const audioModelEntry = Array.isArray(audioModels) ? asRecord(audioModels[0]) : undefined;
	if (audioModelEntry) {
		const providerId = readString(audioModelEntry, "provider") ?? "openai";
		const providerCfg = asRecord(providers?.[providerId]);
		const baseUrl = readString(audioModelEntry, "baseUrl") ?? readString(providerCfg, "baseUrl");
		const apiKey = readString(audioModelEntry, "apiKey") ?? readString(providerCfg, "apiKey");
		const model = readString(audioModelEntry, "model") ?? "whisper-1";
		if (baseUrl && apiKey) {
			return { enabled: true, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
		}
	}

	return null;
}

/** mu provider 的凭据（见 QQBotRuntime.providerAuth） */
export type ProviderAuthResolver = (provider: string) => Promise<{ apiKey?: string; baseUrl?: string } | undefined>;

/**
 * mu 适配：先按原版解析 channels.qqbot.stt；缺 baseUrl / apiKey 时用 mu provider 的凭据补齐。
 * stt.enabled === false 或 channels.qqbot.stt 未配置时不启用（与原版一致：不配置不转写）。
 */
export async function resolveSTTConfigWithProvider(
	cfg: Record<string, unknown>,
	providerAuth: ProviderAuthResolver | undefined,
): Promise<STTConfig | null> {
	const direct = resolveSTTConfig(cfg);
	if (direct) return direct;
	const sttCfg = asRecord(asRecord(asRecord(cfg.channels)?.qqbot)?.stt);
	if (!sttCfg || sttCfg.enabled === false || !providerAuth) return null;
	const providerId = readString(sttCfg, "provider") ?? "openai";
	const auth = await providerAuth(providerId).catch(() => undefined);
	const baseUrl = readString(sttCfg, "baseUrl") ?? auth?.baseUrl?.trim();
	const apiKey = readString(sttCfg, "apiKey") ?? auth?.apiKey?.trim();
	if (!baseUrl || !apiKey) return null;
	return {
		enabled: true,
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey,
		model: readString(sttCfg, "model") ?? "whisper-1",
	};
}

/**
 * 调用 STT 服务转录音频文件
 */
export async function transcribeAudio(audioPath: string, cfg: Record<string, unknown>): Promise<string | null> {
	const sttCfg = resolveSTTConfig(cfg);
	if (!sttCfg) {
		return null;
	}

	const fileBuffer = fs.readFileSync(audioPath);
	const fileName = sanitizeFileName(path.basename(audioPath));
	const mime = guessMimeType(fileName);

	const form = new FormData();
	form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
	form.append("model", sttCfg.model);

	const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${sttCfg.apiKey}` },
		body: form,
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => "");
		throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
	}

	const result = (await resp.json()) as { text?: string };
	return result.text?.trim() || null;
}

// ── 内部工具函数 ──

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function readString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
	const val = obj?.[key];
	if (typeof val === "string" && val.trim()) {
		return val.trim();
	}
	return undefined;
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function guessMimeType(fileName: string): string {
	const ext = path.extname(fileName).toLowerCase();
	const mimeMap: Record<string, string> = {
		".wav": "audio/wav",
		".mp3": "audio/mpeg",
		".ogg": "audio/ogg",
		".flac": "audio/flac",
		".m4a": "audio/mp4",
		".aac": "audio/aac",
		".silk": "audio/silk",
		".amr": "audio/amr",
		".pcm": "audio/pcm",
	};
	return mimeMap[ext] ?? "application/octet-stream";
}
