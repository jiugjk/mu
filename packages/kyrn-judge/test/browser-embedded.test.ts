import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../coding-agent/test/suite/harness.ts";
import { runBrowserTask } from "../src/browser/agent.ts";
import { CdpConnection } from "../src/browser/cdp.ts";
import { ADVERT_FILE, EmbeddedBrowser, findEmbeddedEndpoint, loopbackSocket } from "../src/browser/embedded.ts";
import { BrowserSession, type PageAction, type PageState, StalePage } from "../src/browser/session.ts";
import { parseConfig } from "../src/config.ts";
import { DecisionEngine } from "../src/decision.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { Judge } from "../src/judge.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

type Reply = Record<string, unknown> | Error;

/** A WebSocket server small enough to read: text frames only, which is all the DevTools protocol sends. */
function bridge(answer: (method: string, params: Record<string, unknown>) => Reply) {
	const calls: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
	const sockets: Duplex[] = [];
	const server: Server = createServer();
	server.on("upgrade", (request, socket) => {
		sockets.push(socket);
		const accept = createHash("sha1")
			.update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 6) {
				let length = buffered[1] & 0x7f;
				let offset = 2;
				if (length === 126) {
					length = buffered.readUInt16BE(2);
					offset = 4;
				}
				if (buffered.length < offset + 4 + length) return;
				const mask = buffered.subarray(offset, offset + 4);
				const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
				for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
				const opcode = buffered[0] & 0x0f;
				buffered = buffered.subarray(offset + 4 + length);
				if (opcode !== 1) continue;
				const message = JSON.parse(payload.toString("utf8")) as {
					id: number;
					method: string;
					params: Record<string, unknown>;
					sessionId?: string;
				};
				calls.push({ method: message.method, params: message.params, sessionId: message.sessionId });
				const reply = answer(message.method, message.params);
				const body = Buffer.from(
					JSON.stringify(
						reply instanceof Error
							? { id: message.id, error: { message: reply.message } }
							: { id: message.id, result: reply },
					),
				);
				const header =
					body.length < 126
						? Buffer.from([0x81, body.length])
						: Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
				socket.write(Buffer.concat([header, body]));
			}
		});
	});
	return {
		calls,
		listen: () =>
			new Promise<string>((resolve) =>
				server.listen(0, "127.0.0.1", () =>
					resolve(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/token`),
				),
			),
		close: () => {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}

describe("the desktop app's browser", () => {
	const open: { close(): void }[] = [];
	afterEach(() => {
		while (open.length > 0) open.pop()?.close();
	});

	async function connected(answer: Parameters<typeof bridge>[0]) {
		const fake = bridge(answer);
		open.push(fake);
		const cdp = await CdpConnection.connect(await fake.listen());
		open.push(cdp);
		return { fake, cdp };
	}

	it("is only ever a loopback socket", () => {
		expect(loopbackSocket("ws://127.0.0.1:9000/abc")).toBe(true);
		expect(loopbackSocket("ws://localhost:9000/abc")).toBe(true);
		expect(loopbackSocket("ws://192.168.1.5:9000/abc")).toBe(false);
		expect(loopbackSocket("wss://example.com/abc")).toBe(false);
		expect(loopbackSocket("http://127.0.0.1:9000/abc")).toBe(false);
		expect(loopbackSocket("not a url")).toBe(false);
	});

	it("is found through the variable or the app's advert, and not when that app has quit", () => {
		const advert = (value: unknown) => ({
			home: "/home/u/.mu",
			env: {},
			readFile: (path: string) => {
				expect(path.endsWith(ADVERT_FILE)).toBe(true);
				return JSON.stringify(value);
			},
		});
		const url = "ws://127.0.0.1:41000/secret";

		expect(findEmbeddedEndpoint({ env: { MU_BROWSER_ENDPOINT: url } })).toEqual({ url });
		expect(findEmbeddedEndpoint({ env: { KYRN_BROWSER_ENDPOINT: url } })).toEqual({ url });
		expect(findEmbeddedEndpoint({ env: { MU_BROWSER_ENDPOINT: "ws://10.0.0.2:1/x" } })).toBeUndefined();
		expect(findEmbeddedEndpoint({ ...advert({ url, pid: 7 }), isRunning: () => true })).toEqual({ url, pid: 7 });
		expect(findEmbeddedEndpoint({ ...advert({ url, pid: 7 }), isRunning: () => false })).toBeUndefined();
		expect(findEmbeddedEndpoint(advert({ url: "ws://evil.example/x", pid: 7 }))).toBeUndefined();
		expect(
			findEmbeddedEndpoint({
				home: "/home/u/.mu",
				env: {},
				readFile: () => {
					throw new Error("ENOENT");
				},
			}),
		).toBeUndefined();
	});

	it("tells the app from a plain browser, which does not know the Mu methods", async () => {
		const app = await connected((method) => (method === "Mu.hello" ? { embedded: true, version: 1 } : {}));
		expect(await EmbeddedBrowser.handshake(app.cdp)).toBeInstanceOf(EmbeddedBrowser);

		const chrome = await connected((method) => new Error(`'${method}' wasn't found`));
		expect(await EmbeddedBrowser.handshake(chrome.cdp)).toBeUndefined();

		const newer = await connected(() => ({ embedded: true, version: 2 }));
		expect(await EmbeddedBrowser.handshake(newer.cdp)).toBeUndefined();

		// An app with no conversation on screen has nowhere to show a page.
		const nowhere = await connected(() => ({ embedded: false, version: 1 }));
		expect(await EmbeddedBrowser.handshake(nowhere.cdp)).toBeUndefined();
	});

	it("says which conversation it serves, so the page opens beside it", async () => {
		const hello = (method: string) => (method === "Mu.hello" ? { embedded: true, version: 1 } : {});
		const named = await connected(hello);
		await EmbeddedBrowser.handshake(named.cdp, { MU_DESKTOP_SESSION: "conv_42" });
		expect(named.fake.calls[0]).toEqual({ method: "Mu.hello", params: { version: 1, session: "conv_42" } });

		const terminal = await connected(hello);
		await EmbeddedBrowser.handshake(terminal.cdp, {});
		expect(terminal.fake.calls[0]).toEqual({ method: "Mu.hello", params: { version: 1 } });
	});

	it("speaks about one tab, because several runs can share the connection", async () => {
		const shared = await connected((method) =>
			method === "Mu.hello"
				? { embedded: true, version: 1 }
				: method === "Mu.confirm"
					? { allowed: true }
					: { paused: false, stop: false },
		);
		const app = (await EmbeddedBrowser.handshake(shared.cdp, {})) as EmbeddedBrowser;
		const tab = app.forTab("session-7");

		tab.run({ state: "started", goal: "find the price", url: "https://example.com/" });
		expect(await tab.control()).toEqual({ paused: false, stop: false });
		expect(await tab.confirm("Pay now", "https://example.com/pay")).toBe(true);
		tab.step({ step: 1, kind: "click", action: "Search" });
		tab.run({ state: "finished", status: "blocked", reason: "three actions in a row changed nothing" });
		await expect.poll(() => shared.fake.calls.filter((call) => call.method === "Mu.run")).toHaveLength(2);

		const aboutTheTab = shared.fake.calls.filter((call) => call.method !== "Mu.hello");
		expect(aboutTheTab.map((call) => call.method).sort()).toEqual(
			["Mu.confirm", "Mu.control", "Mu.run", "Mu.run", "Mu.step"].sort(),
		);
		expect(aboutTheTab.every((call) => call.sessionId === "session-7")).toBe(true);
		expect(shared.fake.calls.filter((call) => call.method === "Mu.run").map((call) => call.params)).toEqual([
			{ state: "started", goal: "find the price", url: "https://example.com/" },
			{ state: "finished", status: "blocked", reason: "three actions in a row changed nothing" },
		]);
	});

	it("takes keys the app would not deliver as a page to look at again, and other failures as failures", async () => {
		const field: PageAction = { id: "a1", kind: "fill", label: "Search", node: 5 };
		const page: PageState = {
			url: "https://example.com/",
			title: "Example",
			text: "hello",
			actions: [field],
			marker: 1,
			page_key: 1,
			guards: {},
			omitted_actions: 0,
			fingerprint: "f",
		};
		let keyboard: Error = new Error("The page does not hold the keyboard, so nothing was typed");
		const pageOf = (expression: string) =>
			expression.includes("document.readyState")
				? "complete"
				: expression.includes("state?.marker")
					? 1
					: expression.includes("getBoundingClientRect(), x =")
						? { x: 10, y: 10 }
						: null;
		const app = await connected((method, params) => {
			if (method === "Target.createTarget") return { targetId: "tab-1" };
			if (method === "Target.attachToTarget") return { sessionId: "session-1" };
			if (method === "Runtime.evaluate") return { result: { value: pageOf(String(params.expression)) } };
			if (method === "Input.dispatchKeyEvent") return keyboard;
			return {};
		});
		const session = await BrowserSession.open(app.cdp, "https://example.com/");
		expect(session.id).toBe("session-1");

		await expect(session.act(field, page, "shoes")).rejects.toBeInstanceOf(StalePage);
		// The click went to the page by its coordinates; only the typing was held back.
		expect(app.fake.calls.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(true);
		expect(app.fake.calls.some((call) => call.method === "Input.insertText")).toBe(false);

		keyboard = new Error("Target closed");
		const failure = await session.act(field, page, "shoes").catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(StalePage);
	});

	it("waits while the person has the run paused, and ends it when they stop it", async () => {
		const states = [
			{ paused: true, stop: false },
			{ paused: true, stop: false },
			{ paused: false, stop: false },
		];
		const pausing = await connected((method) =>
			method === "Mu.hello" ? { embedded: true, version: 1 } : (states.shift() ?? { paused: false, stop: false }),
		);
		const app = (await EmbeddedBrowser.handshake(pausing.cdp)) as EmbeddedBrowser;
		expect(await app.mayContinue(undefined, 5)).toBe(true);
		expect(pausing.fake.calls.filter((call) => call.method === "Mu.control")).toHaveLength(3);

		const stopping = await connected((method) =>
			method === "Mu.hello" ? { embedded: true, version: 1 } : { paused: true, stop: true },
		);
		const stopped = (await EmbeddedBrowser.handshake(stopping.cdp)) as EmbeddedBrowser;
		expect(await stopped.mayContinue(undefined, 5)).toBe(false);

		const aborted = new AbortController();
		aborted.abort();
		expect(await app.mayContinue(aborted.signal, 5)).toBe(false);
	});

	it("asks the person at the app before an irreversible action, and a panel that is gone means no", async () => {
		const asking = await connected((method, params) =>
			method === "Mu.hello" ? { embedded: true, version: 1 } : { allowed: params.label === "Delete draft" },
		);
		const app = (await EmbeddedBrowser.handshake(asking.cdp)) as EmbeddedBrowser;
		expect(await app.confirm("Delete draft", "https://example.com/mail")).toBe(true);
		expect(await app.confirm("Pay now", "https://example.com/pay")).toBe(false);
		expect(asking.fake.calls.at(-1)).toEqual({
			method: "Mu.confirm",
			params: { label: "Pay now", url: "https://example.com/pay" },
		});

		app.step({ step: 1, kind: "click", action: "Search" });
		await expect.poll(() => asking.fake.calls.some((call) => call.method === "Mu.step")).toBe(true);

		asking.cdp.close();
		expect(await app.confirm("Delete draft", "https://example.com/mail")).toBe(false);
		expect(await app.control()).toEqual({ paused: false, stop: false });
	});

	it("browse without a goal reads nothing of a page the address sent to this computer", async () => {
		const snapshot = {
			url: "http://127.0.0.1:8500/v1/kv/?recurse",
			title: "Consul",
			text: "DATABASE_PASSWORD=hunter2",
			actions: [],
			marker: 1,
			page_key: 1,
			guards: {},
			omitted_actions: 0,
		};
		const app = bridge((method, params) => {
			if (method === "Mu.hello") return { embedded: true, version: 1 };
			if (method === "Target.createTarget") return { targetId: "tab-1" };
			if (method === "Target.attachToTarget") return { sessionId: "session-1" };
			if (method === "Runtime.evaluate")
				return {
					result: { value: String(params.expression).includes("document.readyState") ? "complete" : snapshot },
				};
			return {};
		});
		open.push(app);
		vi.stubEnv("MU_BROWSER_ENDPOINT", await app.listen());
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(),
					mode: "active",
					config: parseConfig({ features: { memory: false } }),
					only: ["browser"],
				}),
			],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("browse", { url: "https://93.184.216.34/" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Nothing to read."),
			]);
			await harness.session.prompt("What does that page say?");
			const result = JSON.stringify(harness.session.messages.filter((message) => message.role === "toolResult"));
			expect(result).toContain("a page sent the browser to http://127.0.0.1:8500 (this computer)");
			expect(result).not.toContain("hunter2");
			expect(result).not.toContain("recurse");
		} finally {
			harness.cleanup();
			vi.unstubAllEnvs();
		}
	});

	it("a writer that never answers ends the run, instead of holding the turn", async () => {
		const search: PageAction = { id: "e1", kind: "fill", node: 1, role: "textbox", label: "Search", value: "" };
		const snapshot = {
			url: "https://93.184.216.34/",
			title: "Search",
			text: "Search the site",
			actions: [search],
			marker: 1,
			page_key: 1,
			guards: {},
			omitted_actions: 0,
		};
		const app = bridge((method, params) => {
			if (method === "Mu.hello") return { embedded: true, version: 1 };
			if (method === "Mu.control") return { paused: false, stop: false };
			if (method === "Target.createTarget") return { targetId: "tab-1" };
			if (method === "Target.attachToTarget") return { sessionId: "session-1" };
			if (method === "Runtime.evaluate") {
				const expression = String(params.expression);
				if (expression.includes("document.readyState")) return { result: { value: "complete" } };
				return { result: { value: expression.includes("state?.marker") ? 1 : snapshot } };
			}
			return {};
		});
		open.push(app);
		vi.stubEnv("MU_BROWSER_ENDPOINT", await app.listen());
		const choose = (choice: string): Answer => ({ type: "choice", choice, probabilities: { [choice]: 0.97 } });
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(
						(request): Record<string, Answer> =>
							"operation" in request.questions
								? { operation: choose("TYPE_TEXT"), type_text_target: choose("1") }
								: {},
					),
					mode: "active",
					config: parseConfig({ features: { memory: false, browser: { writeTimeoutMs: 200 } } }),
					only: ["browser"],
				}),
			],
		});
		let stoppedWaiting = false;
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("browse", { url: "https://93.184.216.34/", goal: "Search for shoes" })],
					{
						stopReason: "toolUse",
					},
				),
				// The field's value is asked of the model, which never answers until the call is given up.
				(_context, options) =>
					new Promise((resolve) => {
						options?.signal?.addEventListener(
							"abort",
							() => {
								stoppedWaiting = true;
								resolve(fauxAssistantMessage("too late"));
							},
							{ once: true },
						);
					}),
				fauxAssistantMessage("Could not fill it in."),
			]);
			await harness.session.prompt("Find shoes on that site.");
			const result = JSON.stringify(harness.session.messages.filter((message) => message.role === "toolResult"));
			expect(stoppedWaiting).toBe(true);
			expect(result).toContain('no value could be produced for \\"Search\\"');
		} finally {
			harness.cleanup();
			vi.unstubAllEnvs();
		}
	});

	it("ends a run before its next step when the person watching says stop", async () => {
		const page: PageState = {
			url: "https://example.com/",
			title: "Example",
			text: "hello",
			actions: [],
			marker: 1,
			page_key: 1,
			guards: {},
			omitted_actions: 0,
			fingerprint: "f",
		};
		const session = {
			start: "https://example.com/",
			observe: async () => page,
			fresh: async () => true,
		} as unknown as BrowserSession;
		let asked = 0;
		const engine = new DecisionEngine({
			judge: new Judge({
				provider: new MockJudgeProvider(() => {
					asked++;
					return {};
				}),
			}),
			ledger: new MemoryLedger(),
			defaultMode: "active",
		});

		const result = await runBrowserTask({
			session,
			engine,
			goal: "anything",
			writeText: async () => undefined,
			beforeStep: async () => false,
		});

		expect(result.status).toBe("aborted");
		expect(result.reason).toContain("stopped");
		expect(asked).toBe(0);
	});
});
