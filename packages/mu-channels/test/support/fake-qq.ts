import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

/** One HTTP call the bot made to the (fake) QQ Open Platform. */
export interface RecordedCall {
	method: string;
	path: string;
	body: Record<string, unknown>;
	headers: Record<string, string | string[] | undefined>;
	/** What the fake answered (set once the response is sent). */
	response?: unknown;
}

export interface FakeQQOptions {
	/** Answer message sends with this HTTP status and body instead of success (per path prefix). */
	failures?: Array<{
		match: RegExp;
		/** Only fail calls whose JSON body passes this check. */
		when?: (body: Record<string, unknown>) => boolean;
		status: number;
		body: Record<string, unknown>;
	}>;
	/** Emit READY on identify. Default true. */
	autoReady?: boolean;
	/** Answer the first this many token requests with 503 (the platform briefly unreachable). */
	tokenFailures?: number;
}

/**
 * A local stand-in for the QQ Open Platform: the token endpoint, `GET /gateway`, a WebSocket gateway speaking the
 * QQ op-codes (HELLO / IDENTIFY / READY / HEARTBEAT / DISPATCH) and every REST endpoint the channel calls. The bot
 * under test is the real SDK pointed here with QQBOT_BASE_URL / QQBOT_TOKEN_BASE_URL; nothing in it is mocked.
 */
export class FakeQQ {
	readonly calls: RecordedCall[] = [];
	private server: Server | undefined;
	private wss: WebSocketServer | undefined;
	private sockets = new Set<WebSocket>();
	private seq = 1;
	private messageCounter = 0;
	private readyWaiters: Array<() => void> = [];
	private readyCount = 0;
	/** Token requests so far. */
	tokenRequests = 0;
	private options: FakeQQOptions;
	baseUrl = "";

	constructor(options: FakeQQOptions = {}) {
		this.options = options;
	}

	async start(): Promise<void> {
		this.server = createServer((req, res) => void this.handle(req, res));
		this.wss = new WebSocketServer({ noServer: true });
		this.server.on("upgrade", (req, socket, head) => {
			this.wss?.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
		});
		await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", () => resolve()));
		const { port } = this.server.address() as AddressInfo;
		this.baseUrl = `http://127.0.0.1:${port}`;
	}

	async stop(): Promise<void> {
		for (const ws of this.sockets) ws.terminate();
		this.wss?.close();
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}

	/** Resolves once the bot has identified and received READY `count` times in total. */
	waitForReady(count = 1): Promise<void> {
		if (this.readyCount >= count) return Promise.resolve();
		return new Promise((resolve) => {
			const check = () => {
				if (this.readyCount >= count) resolve();
				else this.readyWaiters.push(check);
			};
			this.readyWaiters.push(check);
		});
	}

	private onSocket(ws: WebSocket): void {
		this.sockets.add(ws);
		ws.on("close", () => this.sockets.delete(ws));
		ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
		ws.on("message", (raw) => {
			const payload = JSON.parse(String(raw)) as { op: number };
			if (payload.op === 2 || payload.op === 6) {
				if (this.options.autoReady === false) return;
				const t = payload.op === 2 ? "READY" : "RESUMED";
				ws.send(
					JSON.stringify({
						op: 0,
						s: this.seq++,
						t,
						d: { session_id: "fake-session", user: { id: "bot", username: "mu-bot", bot: true } },
					}),
				);
				this.readyCount++;
				const waiters = this.readyWaiters;
				this.readyWaiters = [];
				for (const waiter of waiters) waiter();
			} else if (payload.op === 1) {
				ws.send(JSON.stringify({ op: 11 }));
			}
		});
	}

	/** Pushes a gateway DISPATCH event to every connected bot. */
	push(t: string, d: Record<string, unknown>): void {
		const frame = JSON.stringify({ op: 0, s: this.seq++, t, d });
		for (const ws of this.sockets) ws.send(frame);
	}

	private nextMessageId(): string {
		return `bot-msg-${++this.messageCounter}`;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const text = Buffer.concat(chunks).toString("utf8");
		let body: Record<string, unknown> = {};
		try {
			body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		} catch {
			body = { raw: text };
		}
		const path = (req.url ?? "").split("?")[0] ?? "";
		const method = req.method ?? "GET";
		const call: RecordedCall = { method, path, body, headers: req.headers };
		const send = (status: number, payload: unknown) => {
			call.response = payload;
			res.statusCode = status;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify(payload));
		};

		if (path === "/app/getAppAccessToken") {
			this.tokenRequests++;
			if (this.tokenRequests <= (this.options.tokenFailures ?? 0)) {
				send(503, { message: "busy" });
				return;
			}
			send(200, { access_token: "fake-access-token-0123456789", expires_in: 7200 });
			return;
		}
		if (path === "/gateway") {
			send(200, { url: `${this.baseUrl.replace("http", "ws")}/ws` });
			return;
		}

		this.calls.push(call);
		const failure = this.options.failures?.find((f) => f.match.test(path) && (f.when?.(body) ?? true));
		if (failure) {
			send(failure.status, failure.body);
			return;
		}
		if (/\/files$/.test(path)) {
			send(200, { file_uuid: `file-${this.calls.length}`, file_info: `info-${this.calls.length}`, ttl: 3600 });
			return;
		}
		if (/\/stream_messages$/.test(path)) {
			send(200, {
				id: "stream-1",
				timestamp: Math.floor(Date.now() / 1000),
				ext_info: { ref_idx: `REFIDX_stream_${this.calls.length}` },
			});
			return;
		}
		if (/\/messages$/.test(path)) {
			send(200, {
				id: this.nextMessageId(),
				timestamp: Math.floor(Date.now() / 1000),
				ext_info: { ref_idx: `REFIDX_${this.messageCounter}` },
			});
			return;
		}
		send(200, {});
	}

	// ── Queries ──

	/** Message sends (text or media) to one target, in order; typing notifications (msg_type 6) are left out. */
	sentTo(scope: "c2c" | "group", id: string): RecordedCall[] {
		const prefix = scope === "c2c" ? `/v2/users/${id}/messages` : `/v2/groups/${id}/messages`;
		return this.calls.filter((call) => call.path === prefix && call.body.msg_type !== 6);
	}

	/** "Typing…" notifications (msg_type 6) sent to a user. */
	typingTo(openid: string): RecordedCall[] {
		return this.calls.filter((call) => call.path === `/v2/users/${openid}/messages` && call.body.msg_type === 6);
	}

	/** Text of plain (msg_type 0) and markdown (msg_type 2) messages to a target. */
	textsTo(scope: "c2c" | "group", id: string): string[] {
		return this.sentTo(scope, id)
			.map((call) => {
				const markdown = call.body.markdown as { content?: string } | undefined;
				return (markdown?.content ?? call.body.content ?? "") as string;
			})
			.filter((text) => text.length > 0);
	}

	streamCalls(openid: string): RecordedCall[] {
		return this.calls.filter((call) => call.path === `/v2/users/${openid}/stream_messages`);
	}

	async waitFor<T>(probe: () => T | undefined | false, timeoutMs = 10_000, what = "condition"): Promise<T> {
		const started = Date.now();
		for (;;) {
			const value = probe();
			if (value) return value;
			if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

let eventCounter = 0;

export function c2cMessage(
	openid: string,
	content: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: `user-msg-${++eventCounter}`,
		content,
		timestamp: new Date().toISOString(),
		author: { id: openid, user_openid: openid, union_openid: `union-${openid}` },
		...extra,
	};
}

export function groupMessage(
	groupOpenid: string,
	memberOpenid: string,
	content: string,
	options: { atBot?: boolean; nickname?: string; extra?: Record<string, unknown> } = {},
): Record<string, unknown> {
	return {
		id: `group-msg-${++eventCounter}`,
		content: options.atBot ? `<@!bot> ${content}` : content,
		timestamp: new Date().toISOString(),
		group_id: groupOpenid,
		group_openid: groupOpenid,
		author: { id: memberOpenid, member_openid: memberOpenid, username: options.nickname },
		mentions: options.atBot ? [{ id: "bot", member_openid: "bot", is_you: true, bot: true, nickname: "mu-bot" }] : [],
		...options.extra,
	};
}
