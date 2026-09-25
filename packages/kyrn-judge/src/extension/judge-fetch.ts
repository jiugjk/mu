import { EventEmitter } from "node:events";
import * as undici from "undici";
import { muEnv } from "../naming.ts";

/** How long an idle connection to a judge stays open. Between two tool calls the model thinks for longer than Node's 4 s. */
export const JUDGE_KEEP_ALIVE_MS = 60_000;

/** Judge calls in a row that get no answer (a timeout, a failed connection) before the connections are replaced. */
export const JUDGE_FAILURES_BEFORE_RECONNECT = 2;

export interface JudgeFetch {
	readonly fetch: typeof fetch;
	/** Whether HTTP/2 is offered to the judge. `MU_JUDGE_HTTP2=off` keeps to HTTP/1.1, for a proxy that cannot carry it. */
	readonly http2: boolean;
	close(): Promise<void>;
}

/** A call that got no answer: its time ran out, or the connection failed. The caller's own cancel is neither. */
const unanswered = (error: unknown): boolean =>
	error instanceof Error && (error.name === "TimeoutError" || error.name === "TypeError");

/**
 * A `fetch` for judge calls that keeps its connections open between calls.
 *
 * Node keeps an idle connection for 4 s, and the agent thinks for longer than
 * that between two tool calls, so nearly every judge call paid for a new TLS
 * handshake. Measured from the user's network on 2026-09-22 (api.typesafe.ai,
 * one tiny question, 8 s between calls): 0.7-1.9 s per call on the default
 * dispatcher, 0.25-0.36 s on one that keeps the connection. Proxies from the
 * environment are honoured, as pi honours them for the model.
 *
 * HTTP/2 where the judge speaks it (api.typesafe.ai does): the questions asked
 * before a turn then share one connection instead of each opening its own.
 * Measured 2026-09-23, five questions at once on cold connections: 3.9 s over
 * HTTP/1.1, 1.7 s over HTTP/2; warm, 0.5 s against 0.3 s per question.
 *
 * The price of that one connection: when it goes silent, every later call
 * waits on it too, and nothing replaces it (undici's pings never time out).
 * Seen 2026-09-24: sessions whose first calls hit a slow minute of Jev got no
 * answer for the rest of their life (7 and 26 minutes, every decision a
 * fallback) while other sessions recovered within seconds. So after
 * `failuresBeforeReconnect` unanswered calls in a row the connections are
 * dropped, and the next call opens a new one. A call answered in between, even
 * with an error status, shows the connection works and starts the count again.
 * `h2c`: speak HTTP/2 without TLS, for a local test server.
 */
export function createJudgeFetch(
	options: { keepAliveMs?: number; http2?: boolean; failuresBeforeReconnect?: number; h2c?: boolean } = {},
): JudgeFetch {
	const keepAliveMs = options.keepAliveMs ?? JUDGE_KEEP_ALIVE_MS;
	const http2 = options.http2 ?? muEnv("JUDGE_HTTP2") !== "off";
	const failuresBeforeReconnect = options.failuresBeforeReconnect ?? JUDGE_FAILURES_BEFORE_RECONNECT;
	const connect = (): undici.Dispatcher => {
		const dispatcher = new undici.EnvHttpProxyAgent({
			keepAliveTimeout: keepAliveMs,
			keepAliveMaxTimeout: Math.max(keepAliveMs, 600_000),
			// Judge calls are small and short: a few connections per origin cover what a turn asks at once.
			connections: 4,
			allowH2: http2,
			...(options.h2c ? { useH2c: true } : {}),
		});
		// A connection that dies while idle raises an "error" event on the dispatcher; without a listener it would crash the host.
		if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", () => {});
		return dispatcher;
	};
	let dispatcher = connect();
	let failures = 0;
	const withDispatcher = undici.fetch as unknown as typeof fetch;
	const judgeFetch: typeof fetch = async (input, init) => {
		const used = dispatcher;
		try {
			const response = await withDispatcher(input, { ...(init ?? {}), dispatcher: used } as unknown as RequestInit);
			if (used === dispatcher) failures = 0;
			return response;
		} catch (error) {
			// Calls still waiting on connections already replaced count for nothing.
			if (used === dispatcher && unanswered(error) && ++failures >= failuresBeforeReconnect) {
				dispatcher = connect();
				failures = 0;
				// Whatever still waits on the silent connections would only wait out its own timeout.
				void used.destroy().catch(() => {});
			}
			throw error;
		}
	};
	return { fetch: judgeFetch, http2, close: () => dispatcher.close() };
}
