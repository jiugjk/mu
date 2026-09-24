/**
 * Webhook 服务适配 — 将 QQ 回调接入 SDK 的 WebhookServerAdapter。
 *
 * mu 适配：原版挂在 OpenClaw 网关的 HTTP 路由上（openclaw/plugin-sdk/webhook-ingress 提供 target
 * registry、限流、并发限制、body 读取）。mu 没有 HTTP 服务，改为由本文件启动 node:http 服务
 * （channels.qqbot.webhook.port / host，默认 8787 / 127.0.0.1），并保留原版行为：
 *   - 多账号同路径：op:0 事件按 Ed25519 签名匹配账号，op:13（回调地址校验）按 X-Bot-Appid 选账号（缺省第一个）；
 *   - 只收 application/json，body 上限 1MB、读取超时 30s；
 *   - 每路径每分钟 600 次（固定窗口）、同时处理不超过 8 个。
 *
 * mu 修正：
 *   - op:13 会用机器人的 Ed25519 密钥对 event_ts + plain_token 签名，而 op:0 验证的正是「时间戳 + 请求体」的签名：
 *     把伪造事件的 JSON 当作 plain_token 发来，就能拿到任意事件的合法签名。现在 op:13 只接受数字 event_ts 与
 *     短的字母数字 plain_token（JSON 一定含 `{`，不可能再被签名）；
 *   - op:0 的签名时间戳须在当前时间 ±5 分钟内，同一签名只接受一次（防重放）；
 *   - 限流与并发上限只计验签通过的请求：原先未认证的请求就能占满额度，挡住 QQ 的真实回调；
 *   - 默认只监听 127.0.0.1（文档要求前面有 HTTPS 反向代理）。
 */
import * as http from "node:http";
import type { WebhookRequestHandler, WebhookServerAdapter } from "@tencent-connect/qqbot-nodejs";
import { verifyWebhookSignature } from "@tencent-connect/qqbot-nodejs/protocol";
import type { ResolvedQQBotAccount } from "../types.ts";
import type { PluginLogger } from "../utils/plugin-logger.ts";

export const DEFAULT_WEBHOOK_PORT = 8787;
export const DEFAULT_WEBHOOK_PATH = "/qqbot/webhook";
const MAX_BODY_BYTES = 1_048_576;
const BODY_TIMEOUT_MS = 30_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 600;
const MAX_IN_FLIGHT = 8;
/** op:0 签名时间戳允许的偏差（秒） */
const MAX_CLOCK_SKEW_S = 300;
/** op:13 每路径每分钟上限（未认证请求） */
const VALIDATION_MAX_REQUESTS = 30;
const PLAIN_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_TS = /^\d{1,20}$/;

interface WebhookTarget {
	path: string;
	accountId: string;
	appId: string;
	clientSecret: string;
	handler: WebhookRequestHandler;
}

interface PathState {
	targets: WebhookTarget[];
	windowStart: number;
	windowCount: number;
	validationCount: number;
	inFlight: number;
	/** 已接受的签名 → 时间（秒），用于拒绝重放 */
	seen: Map<string, number>;
}

interface SharedServer {
	server: http.Server;
	paths: Map<string, PathState>;
	listening: Promise<void>;
}

// ── 模块级共享状态（按 host:port 共享一个 HTTP 服务） ──
const servers = new Map<string, SharedServer>();

export function createWebhookServerAdapter(params: {
	account: ResolvedQQBotAccount;
	log: PluginLogger;
}): WebhookServerAdapter {
	const { account, log } = params;
	let registered: { key: string; path: string } | null = null;

	return {
		async listen(_port: number, path: string, handler: WebhookRequestHandler): Promise<void> {
			const port = account.config.webhook?.port ?? DEFAULT_WEBHOOK_PORT;
			const host = account.config.webhook?.host ?? "127.0.0.1";
			const webhookPath = path && path !== "/" ? path : (account.config.webhook?.path ?? DEFAULT_WEBHOOK_PATH);
			const key = `${host}:${port}`;

			let shared = servers.get(key);
			if (!shared) {
				const paths = new Map<string, PathState>();
				const server = http.createServer((req, res) => {
					handleRequest(req, res, paths, log).catch((err: unknown) => {
						log.error(`Webhook handler error: ${err instanceof Error ? err.message : String(err)}`);
						reply(res, 500, { error: "internal error" });
					});
				});
				const listening = new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(port, host, () => {
						server.off("error", reject);
						resolve();
					});
				});
				shared = { server, paths, listening };
				servers.set(key, shared);
			}
			try {
				await shared.listening;
			} catch (err) {
				// mu 修正：监听失败的服务原先留在表里，同一 host:port 以后每次启动都拿到这个失败结果
				if (servers.get(key) === shared) servers.delete(key);
				throw err;
			}

			let state = shared.paths.get(webhookPath);
			if (!state) {
				state = { targets: [], windowStart: 0, windowCount: 0, validationCount: 0, inFlight: 0, seen: new Map() };
				shared.paths.set(webhookPath, state);
			}
			const target: WebhookTarget = {
				path: webhookPath,
				accountId: account.accountId,
				appId: account.appId,
				clientSecret: account.clientSecret,
				handler,
			};
			// 去重：重启同一账号时替换原 target
			const dup = state.targets.findIndex((t) => t.accountId === account.accountId);
			if (dup >= 0) state.targets[dup] = target;
			else state.targets.push(target);
			registered = { key, path: webhookPath };
			log.info(`Webhook target added on ${host}:${port}${webhookPath} (${state.targets.length} account(s))`);
		},

		close(): void {
			if (!registered) return;
			const shared = servers.get(registered.key);
			const state = shared?.paths.get(registered.path);
			if (state) {
				state.targets = state.targets.filter((t) => t.accountId !== account.accountId);
				if (state.targets.length === 0) shared?.paths.delete(registered.path);
			}
			if (shared && shared.paths.size === 0) {
				shared.server.close();
				servers.delete(registered.key);
				log.info(`Last webhook target removed, server on ${registered.key} closed`);
			}
			registered = null;
		},
	};
}

function reply(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
	if (res.headersSent) return;
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	paths: Map<string, PathState>,
	log: PluginLogger,
): Promise<void> {
	const path = (req.url ?? "").split("?")[0] ?? "";
	const state = paths.get(path);
	if (req.method !== "POST" || !state) {
		reply(res, 404, { error: "not found" });
		return;
	}

	const ct = String(req.headers["content-type"] ?? "");
	if (!ct.includes("application/json")) {
		reply(res, 415, { error: "unsupported content type" });
		return;
	}
	const rawBody = await readBody(req);
	if (!rawBody) {
		log.warn(`[webhook] body rejected`);
		reply(res, 413, { error: "body too large or timed out" });
		return;
	}

	let payload: { op?: number; d?: { plain_token?: unknown; event_ts?: unknown } };
	try {
		payload = JSON.parse(rawBody.toString("utf8")) as typeof payload;
	} catch (err) {
		log.warn(`[webhook] invalid json: ${(err as Error).message}`);
		reply(res, 400, { error: "invalid json" });
		return;
	}

	// 固定窗口（对齐原版 webhook-ingress 参数）
	const now = Date.now();
	if (now - state.windowStart >= RATE_WINDOW_MS) {
		state.windowStart = now;
		state.windowCount = 0;
		state.validationCount = 0;
	}

	const targets = state.targets;
	// op:13 → 回调地址校验（无签名）。只接受 QQ 校验请求的形状，否则它就是一台替任何内容签名的机器
	if (payload.op === 13) {
		const plainToken = payload.d?.plain_token;
		const eventTs = payload.d?.event_ts;
		if (
			typeof plainToken !== "string" ||
			!PLAIN_TOKEN.test(plainToken) ||
			typeof eventTs !== "string" ||
			!EVENT_TS.test(eventTs)
		) {
			log.warn(`[webhook] malformed validation request on ${path}`);
			reply(res, 400, { error: "invalid validation request" });
			return;
		}
		if (++state.validationCount > VALIDATION_MAX_REQUESTS) {
			reply(res, 429, { error: "too many requests" });
			return;
		}
		const appId = getHeader(req, "x-bot-appid");
		const t = targets.find((each) => appId && each.appId === appId) ?? targets[0];
		if (!t) {
			reply(res, 500, { error: "no target" });
			return;
		}
		await delegateToHandler(t.handler, req, res, rawBody);
		return;
	}

	// op:0 → 签名匹配 target → SDK handler 处理事件
	const timestamp = getHeader(req, "x-signature-timestamp") ?? "";
	const signature = getHeader(req, "x-signature-ed25519") ?? "";
	if (!timestamp || !signature) {
		log.warn(`[webhook] missing signature headers on ${path}`);
		reply(res, 401, { error: "missing signature" });
		return;
	}
	const nowSeconds = Math.floor(now / 1000);
	if (!EVENT_TS.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > MAX_CLOCK_SKEW_S) {
		log.warn(`[webhook] stale or invalid signature timestamp on ${path}`);
		reply(res, 401, { error: "stale timestamp" });
		return;
	}
	const matched = targets.find((t) =>
		verifyWebhookSignature({ body: rawBody, timestamp, signature, botSecret: t.clientSecret }),
	);
	if (!matched) {
		log.warn(`[webhook] signature mismatch on ${path} (${targets.length} target(s))`);
		reply(res, 401, { error: "invalid signature" });
		return;
	}
	for (const [sig, at] of state.seen) if (nowSeconds - at > MAX_CLOCK_SKEW_S * 2) state.seen.delete(sig);
	if (state.seen.has(signature)) {
		log.warn(`[webhook] replayed event on ${path}`);
		reply(res, 401, { error: "replayed" });
		return;
	}
	state.seen.set(signature, nowSeconds);

	// 限流 + 并发限制：只计验签通过的请求
	if (++state.windowCount > RATE_MAX_REQUESTS) {
		reply(res, 429, { error: "too many requests" });
		return;
	}
	if (state.inFlight >= MAX_IN_FLIGHT) {
		reply(res, 429, { error: "too many in flight" });
		return;
	}
	state.inFlight++;
	try {
		await delegateToHandler(matched.handler, req, res, rawBody);
	} catch (err) {
		log.error(`Webhook handler error: ${(err as Error).message}`);
		reply(res, 500, { error: "internal error" });
	} finally {
		state.inFlight--;
	}
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let done = false;
		const finish = (value: Buffer | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(null), BODY_TIMEOUT_MS);
		req.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				finish(null);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => finish(Buffer.concat(chunks)));
		req.on("error", () => finish(null));
	});
}

async function delegateToHandler(
	handler: WebhookRequestHandler,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	rawBody: Buffer,
) {
	const headers: Record<string, string | string[]> = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (v !== undefined) headers[k.toLowerCase()] = v;
	}
	const resp = await handler({ body: rawBody, headers });
	res.statusCode = resp.status;
	if (resp.headers) {
		for (const [k, v] of Object.entries(resp.headers)) res.setHeader(k, v as string);
	}
	res.end(resp.body);
}

function getHeader(req: http.IncomingMessage, key: string): string | undefined {
	const val = req.headers[key];
	return Array.isArray(val) ? val[0] : val;
}
