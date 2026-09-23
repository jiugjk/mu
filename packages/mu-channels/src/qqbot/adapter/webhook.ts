/**
 * Webhook 服务适配 — 将 QQ 回调接入 SDK 的 WebhookServerAdapter。
 *
 * mu 适配：原版挂在 OpenClaw 网关的 HTTP 路由上（openclaw/plugin-sdk/webhook-ingress 提供 target
 * registry、限流、并发限制、body 读取）。mu 没有 HTTP 服务，改为由本文件启动 node:http 服务
 * （channels.qqbot.webhook.port / host，默认 8787 / 0.0.0.0），并保留原版行为：
 *   - 多账号同路径：op:0 事件按 Ed25519 签名匹配账号，op:13（回调地址校验）交给第一个账号；
 *   - 只收 application/json，body 上限 1MB、读取超时 30s；
 *   - 每路径每分钟 600 次（固定窗口）、同时处理不超过 8 个。
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
	inFlight: number;
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
			const host = account.config.webhook?.host ?? "0.0.0.0";
			const webhookPath = path && path !== "/" ? path : (account.config.webhook?.path ?? DEFAULT_WEBHOOK_PATH);
			const key = `${host}:${port}`;

			let shared = servers.get(key);
			if (!shared) {
				const paths = new Map<string, PathState>();
				const server = http.createServer((req, res) => {
					void handleRequest(req, res, paths, log);
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
			await shared.listening;

			let state = shared.paths.get(webhookPath);
			if (!state) {
				state = { targets: [], windowStart: 0, windowCount: 0, inFlight: 0 };
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

	// 固定窗口限流 + 并发限制（对齐原版 webhook-ingress 参数）
	const now = Date.now();
	if (now - state.windowStart >= RATE_WINDOW_MS) {
		state.windowStart = now;
		state.windowCount = 0;
	}
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

		let payload: { op?: number };
		try {
			payload = JSON.parse(rawBody.toString("utf8")) as { op?: number };
		} catch (err) {
			log.warn(`[webhook] invalid json: ${(err as Error).message}`);
			reply(res, 400, { error: "invalid json" });
			return;
		}

		const targets = state.targets;
		// op:13 → 用第一个 target 的 SDK handler（无需签名）
		if (payload.op === 13) {
			const t = targets[0];
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
		const matched = targets.find((t) =>
			verifyWebhookSignature({ body: rawBody, timestamp, signature, botSecret: t.clientSecret }),
		);
		if (!matched) {
			log.warn(`[webhook] signature mismatch on ${path} (${targets.length} target(s))`);
			reply(res, 401, { error: "invalid signature" });
			return;
		}
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
