import { createServer, type Server } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import { type AddressInfo, connect, createServer as createNetServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJudgeFetch, type JudgeFetch } from "../src/extension/judge-fetch.ts";

describe("judge fetch", () => {
	const servers: Server[] = [];
	const closers: (() => Promise<void>)[] = [];
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const close of closers.splice(0)) await close();
		for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
	});

	it("offers HTTP/2 to the judge unless told not to", () => {
		const offered = createJudgeFetch();
		closers.push(offered.close);
		expect(offered.http2).toBe(true);
		const declined = createJudgeFetch({ http2: false });
		closers.push(declined.close);
		expect(declined.http2).toBe(false);
		// A proxy that cannot carry HTTP/2 is switched off from the environment, without a config file.
		vi.stubEnv("MU_JUDGE_HTTP2", "off");
		const fromEnv = createJudgeFetch();
		closers.push(fromEnv.close);
		expect(fromEnv.http2).toBe(false);
	});

	it("keeps the connection to the judge open between calls, so only the first call pays for a handshake", async () => {
		let connections = 0;
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ answers: {} }));
		});
		server.on("connection", () => connections++);
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;

		const judge = createJudgeFetch({ keepAliveMs: 30_000 });
		closers.push(judge.close);
		for (let call = 0; call < 3; call++) {
			const response = await judge.fetch(url, { method: "POST", body: "{}" });
			expect(await response.json()).toEqual({ answers: {} });
			// Between two judge calls the agent thinks for a while; the socket is idle by then, and stays open.
			await new Promise((resolve) => setTimeout(resolve, call === 1 ? 60 : 20));
		}
		expect(connections).toBe(1);
	});

	/**
	 * A cleartext HTTP/2 judge behind a TCP relay. `silence()` makes the relay drop every byte of the connections it
	 * has (the network black hole of 2026-09-24); connections opened after that work. A request with `x-slow` is
	 * answered only after 400 ms.
	 */
	async function relayedJudge() {
		const judgeServer = createHttp2Server();
		judgeServer.on("stream", (stream, headers) => {
			const answer = () => {
				if (stream.destroyed) return;
				stream.respond({ ":status": 200, "content-type": "application/json" });
				stream.end(JSON.stringify({ answers: {} }));
			};
			if (headers["x-slow"]) setTimeout(answer, 400);
			else answer();
		});
		const links: { silent: boolean; client: Socket; upstream: Socket }[] = [];
		const relay = createNetServer((client) => {
			const upstream = connect((judgeServer.address() as AddressInfo).port, "127.0.0.1");
			const link = { silent: false, client, upstream };
			links.push(link);
			client.on("data", (data) => link.silent || upstream.write(data));
			upstream.on("data", (data) => link.silent || client.write(data));
			for (const socket of [client, upstream]) socket.on("error", () => {});
			client.on("close", () => upstream.destroy());
		});
		await new Promise<void>((resolve) => judgeServer.listen(0, "127.0.0.1", resolve));
		await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
		closers.push(async () => {
			for (const link of links) link.client.destroy();
			await new Promise((resolve) => relay.close(resolve));
			await new Promise((resolve) => judgeServer.close(resolve));
		});
		return {
			url: `http://127.0.0.1:${(relay.address() as AddressInfo).port}/v1/systemone`,
			connections: () => links.length,
			silence: () => {
				for (const link of links) link.silent = true;
			},
		};
	}

	/** One judge call, as the kernel makes it: its own time limit, the caller's cancel on top. */
	async function ask(
		judge: JudgeFetch,
		url: string,
		options: { ms?: number; slow?: boolean; cancel?: AbortSignal } = {},
	) {
		const timeout = AbortSignal.timeout(options.ms ?? 250);
		try {
			const response = await judge.fetch(url, {
				method: "POST",
				body: "{}",
				headers: options.slow ? { "x-slow": "1" } : {},
				signal: options.cancel ? AbortSignal.any([timeout, options.cancel]) : timeout,
			});
			await response.json();
			return "answered";
		} catch (error) {
			return (error as Error).name;
		}
	}

	it("drops a connection that went silent after two unanswered calls, so the next call opens a new one", async () => {
		const { url, connections, silence } = await relayedJudge();
		const fetcher = createJudgeFetch({ h2c: true });
		closers.push(fetcher.close);
		expect(await ask(fetcher, url)).toBe("answered");
		expect(connections()).toBe(1);
		silence();
		expect(await ask(fetcher, url)).toBe("TimeoutError");
		expect(await ask(fetcher, url)).toBe("TimeoutError");
		// Before the fix every later call went to the silent connection too (seen for 26 minutes in one session).
		expect(await ask(fetcher, url)).toBe("answered");
		expect(connections()).toBe(2);
	});

	it("keeps a working connection through a slow answer now and then, and through the caller's own cancels", async () => {
		const { url, connections } = await relayedJudge();
		const fetcher = createJudgeFetch({ h2c: true });
		closers.push(fetcher.close);
		expect(await ask(fetcher, url)).toBe("answered");
		for (let round = 0; round < 3; round++) {
			expect(await ask(fetcher, url, { slow: true })).toBe("TimeoutError");
			expect(await ask(fetcher, url)).toBe("answered");
		}
		const cancelled = AbortSignal.abort();
		for (let round = 0; round < 3; round++) expect(await ask(fetcher, url, { cancel: cancelled })).toBe("AbortError");
		expect(await ask(fetcher, url)).toBe("answered");
		expect(connections()).toBe(1);
	});
});
