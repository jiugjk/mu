/**
 * 扫码绑定 QQ 机器人（q.qq.com create_bind_task / poll_bind_result）
 *
 * mu 适配：原版通过 @tencent-connect/qqbot-connector 的 qrConnect / startQrConnect 完成扫码绑定。
 * 移植时按 tencent-connect/qqbot-agent-sdk 的 src/qqbot_agent_sdk/onboard.py（MIT）用 TypeScript 重新实现同一协议，
 * 不依赖 qqbot-connector：
 *   1. 本地生成 32 字节随机 AES 密钥（base64），POST /lite/create_bind_task {key} → data.task_id
 *   2. 二维码内容为 https://q.qq.com/qqbot/openclaw/connect.html?task_id=…&_wv=2[&source=…]，手机 QQ 扫码
 *   3. 每 2 秒 POST /lite/poll_bind_result {task_id}：status 0 无 / 1 等待 / 2 完成 / 3 过期
 *   4. 完成时返回 bot_appid、bot_encrypt_secret（AES-256-GCM：IV 12 字节 | 密文 | Tag 16 字节）与扫码者 user_openid，
 *      用本地密钥解密得到 AppSecret —— 密钥只在本机，AppSecret 不以明文经过网络。
 * 请求 / 响应均为 JSON，retcode 非 0 为错误。
 *
 * MU_QQBOT_CONNECT_URL 可改接口地址（调试 / 测试用），二维码链接始终指向 q.qq.com。
 */
import * as crypto from "node:crypto";

const PORTAL = "https://q.qq.com";
const CREATE_PATH = "/lite/create_bind_task";
const POLL_PATH = "/lite/poll_bind_result";
const CONNECT_PAGE = "https://q.qq.com/qqbot/openclaw/connect.html";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 15_000;

export const BindStatus = { NONE: 0, PENDING: 1, COMPLETED: 2, EXPIRED: 3 } as const;

export interface QrConnectCredentials {
	appId: string;
	appSecret: string;
	/** 扫码者的 openid（写入 allowFrom） */
	userOpenid?: string;
}

export interface QrConnectOptions {
	/** 二维码内容就绪（手机 QQ 扫这个链接） */
	onQrReady(url: string): void;
	/** 用户已扫码、等待在手机上确认时调用一次 */
	onScanned?(): void;
	/** 二维码链接里的 source（来源标识） */
	source?: string;
	signal?: AbortSignal;
	pollIntervalMs?: number;
	timeoutMs?: number;
	/** 接口地址，默认 https://q.qq.com（MU_QQBOT_CONNECT_URL 覆盖） */
	baseUrl?: string;
	userAgent?: string;
}

export class QrConnectError extends Error {
	readonly retcode: number | undefined;
	constructor(message: string, retcode?: number) {
		super(message);
		this.name = "QrConnectError";
		this.retcode = retcode;
	}
}

/** 32 字节随机 AES-256 密钥，base64 */
export function generateBindKey(): string {
	return crypto.randomBytes(32).toString("base64");
}

/** 解密 bot_encrypt_secret：base64(IV 12 | 密文 | Tag 16)，AES-256-GCM */
export function decryptSecret(encryptedBase64: string, keyBase64: string): string {
	const key = Buffer.from(keyBase64, "base64");
	const raw = Buffer.from(encryptedBase64, "base64");
	if (key.length !== 32) throw new QrConnectError("bind key must be 32 bytes");
	if (raw.length < 12 + 16) throw new QrConnectError("encrypted secret is too short");
	const iv = raw.subarray(0, 12);
	const tag = raw.subarray(raw.length - 16);
	const ciphertext = raw.subarray(12, raw.length - 16);
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** 二维码链接 */
export function buildConnectUrl(taskId: string, source?: string): string {
	const params = new URLSearchParams({ task_id: taskId, _wv: "2" });
	if (source) params.set("source", source);
	return `${CONNECT_PAGE}?${params.toString()}`;
}

async function call<T>(
	baseUrl: string,
	path: string,
	body: Record<string, unknown>,
	userAgent: string,
	signal?: AbortSignal,
): Promise<T> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const res = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": userAgent },
		body: JSON.stringify(body),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!res.ok) throw new QrConnectError(`${path}: HTTP ${res.status}`);
	const json = (await res.json()) as { retcode?: number; msg?: string; data?: T };
	const retcode = json.retcode ?? -1;
	if (retcode !== 0) throw new QrConnectError(`${path}: ${json.msg ?? "request failed"} (${retcode})`, retcode);
	return (json.data ?? {}) as T;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 扫码绑定：生成二维码、等待扫码确认，返回解密后的凭据。
 * 过期、超时、接口错误时抛出 QrConnectError；signal 中止时抛出其 reason。
 */
export async function qrConnect(options: QrConnectOptions): Promise<QrConnectCredentials[]> {
	const baseUrl = (options.baseUrl ?? process.env.MU_QQBOT_CONNECT_URL ?? PORTAL).replace(/\/+$/, "");
	const userAgent = options.userAgent ?? "mu-qqbot";
	const key = generateBindKey();
	const created = await call<{ task_id?: string }>(baseUrl, CREATE_PATH, { key }, userAgent, options.signal);
	const taskId = created.task_id;
	if (!taskId) throw new QrConnectError("create_bind_task: missing task_id");
	options.onQrReady(buildConnectUrl(taskId, options.source));

	const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	let scanned = false;
	while (Date.now() < deadline) {
		await sleep(interval, options.signal);
		const result = await call<{
			status?: number;
			bot_appid?: string | number;
			bot_encrypt_secret?: string;
			user_openid?: string;
		}>(baseUrl, POLL_PATH, { task_id: taskId }, userAgent, options.signal);
		const status = result.status ?? BindStatus.NONE;
		if (status === BindStatus.PENDING && !scanned) {
			scanned = true;
			options.onScanned?.();
		}
		if (status === BindStatus.EXPIRED) throw new QrConnectError("二维码已过期，请重新运行 mu qqbot login");
		if (status === BindStatus.COMPLETED) {
			const appId = String(result.bot_appid ?? "");
			if (!appId || !result.bot_encrypt_secret) throw new QrConnectError("poll_bind_result: missing credentials");
			let appSecret: string;
			try {
				appSecret = decryptSecret(result.bot_encrypt_secret, key);
			} catch (error) {
				throw new QrConnectError(`无法解密 AppSecret: ${error instanceof Error ? error.message : String(error)}`);
			}
			return [{ appId, appSecret, userOpenid: result.user_openid || undefined }];
		}
	}
	throw new QrConnectError("等待扫码超时，请重新运行 mu qqbot login");
}
