import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient, type LspClientOptions } from "../src/lsp/client.ts";
import { uriStyleFor } from "../src/lsp/uri.ts";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp-server.mjs");

const body = (count: number, marks: Record<number, string> = {}) =>
	Array.from({ length: count }, (_, index) => `line ${index} ${marks[index] ?? ""}`.trimEnd()).join("\n");

describe("lsp client against the fake server", () => {
	const clients: LspClient[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		await Promise.all(clients.splice(0).map((client) => client.stop()));
		// A server that was killed on Windows goes through taskkill, which takes a moment: until it has, the folder the
		// server runs in cannot be removed.
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	function setup(config: Record<string, unknown> = {}, options: Partial<LspClientOptions> = {}) {
		const root = mkdtempSync(join(tmpdir(), "mu-lsp-"));
		dirs.push(root);
		const log = join(root, "server.log");
		const client = new LspClient({
			command: process.execPath,
			args: [FAKE_SERVER, JSON.stringify({ log, ...config })],
			root,
			uriStyle: uriStyleFor({ platform: process.platform }),
			languageId: () => "fake",
			quietMs: 40,
			baselineMs: 2000,
			...options,
		});
		clients.push(client);
		const received = () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line && !line.startsWith("response"));
		return { client, root, log, received, file: (name: string) => join(root, name) };
	}

	it("takes what the server says about the pre-edit text as the base and reports only what the edit added", async () => {
		const { client, file } = setup();
		await client.start();
		const before = body(12, { 8: "!error E1 old problem 你好 🙂" });
		const after = `added a\nadded b\nadded c !error E2 new problem\n${before}`;

		client.setText(file("a.fake"), before, true);
		expect(await client.waitSettled(3000)).toBe(true);
		expect(client.fresh()).toEqual([]);
		expect(client.current(file("a.fake"))).toMatchObject([{ code: "E1", line: 8, message: "old problem 你好 🙂" }]);

		expect(client.checkpoint()).toEqual([]);
		client.setText(file("a.fake"), after);
		expect(await client.waitSettled(3000)).toBe(true);
		// The old problem moved from line 8 to line 11 and is still not new.
		expect(client.current(file("a.fake"))?.map((diagnostic) => diagnostic.line)).toEqual([2, 11]);
		expect(client.fresh()).toMatchObject([{ path: file("a.fake"), diagnostics: [{ code: "E2", line: 2 }] }]);
		// Once the next edit begins, this one's problems are part of the base.
		expect(client.checkpoint()).toHaveLength(1);
		expect(client.fresh()).toEqual([]);
	});

	it("keeps the edit back until a slow, cold server has said what was wrong before it", async () => {
		const { client, file, received } = setup({ delayMs: 250 });
		const before = body(6, { 2: "!error E1 old problem" });
		const after = before.replace("line 4", "line 4 !warn W1 new warning");
		// Both states are known before the server is even up.
		client.setText(file("a.fake"), before, true);
		client.setText(file("a.fake"), after);
		void client.start();

		expect(await client.waitSettled(50)).toBe(false);
		expect(await client.waitSettled(5000)).toBe(true);
		expect(client.fresh()).toMatchObject([{ diagnostics: [{ code: "W1", severity: 2, line: 4 }] }]);
		const order = received().filter((method) => method.startsWith("textDocument/"));
		expect(order).toEqual(["textDocument/didOpen", "textDocument/didChange", "textDocument/didSave"]);
	});

	it("reports what an edit broke in another open document, and sees it fixed again", async () => {
		const { client, file } = setup({ versioned: false });
		await client.start();
		client.setText(file("lib.fake"), "export !provides helper", true);
		client.setText(file("app.fake"), "import\nuse !needs helper", true);
		expect(await client.waitSettled(3000)).toBe(true);
		expect(client.current(file("app.fake"))).toEqual([]);

		client.checkpoint();
		client.setText(file("lib.fake"), "export nothing");
		expect(await client.waitSettled(3000)).toBe(true);
		expect(client.fresh()).toMatchObject([
			{ path: file("app.fake"), diagnostics: [{ code: "E_NEEDS", message: "Missing helper", line: 1 }] },
		]);

		client.checkpoint();
		client.setText(file("lib.fake"), "export !provides helper again");
		expect(await client.waitSettled(3000)).toBe(true);
		expect(client.current(file("app.fake"))).toEqual([]);
		expect(client.fresh()).toEqual([]);
	});

	it("pulls diagnostics when the server offers that, for the edited document and the other open ones", async () => {
		const { client, file, received } = setup({ pull: true });
		await client.start();
		expect(client.usesPull).toBe(true);
		client.setText(file("lib.fake"), "export !provides helper", true);
		client.setText(file("app.fake"), "use !needs helper", true);
		expect(await client.waitSettled(3000)).toBe(true);

		client.checkpoint();
		client.setText(file("lib.fake"), "export nothing !error E9 broken too");
		expect(await client.waitSettled(3000)).toBe(true);
		const fresh = client.fresh();
		expect(fresh.map((entry) => [entry.path, entry.diagnostics.map((diagnostic) => diagnostic.code)])).toEqual([
			[file("lib.fake"), ["E9"]],
			[file("app.fake"), ["E_NEEDS"]],
		]);
		expect(received()).toContain("textDocument/diagnostic");
	});

	it("counts everything in a file that did not exist before as new", async () => {
		const { client, file } = setup();
		await client.start();
		client.setText(file("new.fake"), undefined, true);
		expect(await client.waitSettled(1000)).toBe(true);
		client.setText(file("new.fake"), "fresh file !error E1 broken from the start");
		expect(await client.waitSettled(3000)).toBe(true);
		expect(client.fresh()).toMatchObject([{ diagnostics: [{ code: "E1" }] }]);
	});

	it("does not call new what a change from outside brought in", async () => {
		const { client, file } = setup();
		await client.start();
		client.setText(file("a.fake"), "clean", true);
		expect(await client.waitSettled(3000)).toBe(true);
		// A shell command rewrote the file; then the agent edits it.
		client.checkpoint();
		client.setText(file("a.fake"), "clean !error E1 made by sed", true);
		client.setText(file("a.fake"), "clean !error E1 made by sed\nmore !warn W2 made by the agent");
		expect(await client.waitSettled(3000)).toBe(true);
		expect(client.fresh()).toMatchObject([{ diagnostics: [{ code: "W2" }] }]);
	});

	it("takes a silent, idle server that reports its work at its word: the file was clean", async () => {
		const { client, file } = setup({ quietWhenClean: true, progressMs: 60 }, { baselineMs: 200 });
		await client.start();
		client.setText(file("a.fake"), "clean", true);
		client.setText(file("a.fake"), "clean no more !error E1 broken");
		expect(await client.waitSettled(5000)).toBe(true);
		expect(client.fresh()).toMatchObject([{ diagnostics: [{ code: "E1" }] }]);
	});

	it("takes the first word of a silent server that never reports work as the base, and calls none of it new", async () => {
		const { client, file } = setup({ quietWhenClean: true }, { baselineMs: 150 });
		await client.start();
		client.setText(file("a.fake"), "clean", true);
		client.setText(file("a.fake"), "clean no more !error E1 maybe old");
		expect(await client.waitSettled(5000)).toBe(true);
		expect(client.current(file("a.fake"))).toHaveLength(1);
		expect(client.fresh()).toEqual([]);
	});

	it("answers the server's own requests, with the configured settings", async () => {
		const { client, log } = setup({}, { settings: { fake: { strict: true } } });
		await client.start();
		await expect.poll(() => readFileSync(log, "utf8")).toContain('response [{"strict":true}]');
	});

	it("fails the start when the server never answers, and says why", async () => {
		const { client } = setup(
			{ hang: "initialize", stderr: "loading plugins\nfatal: no licence\n" },
			{ startTimeoutMs: 300 },
		);
		await expect(client.start()).rejects.toThrow("initialize was not answered in time");
		expect(client.state).toBe("failed");
		expect(client.lastError).toContain("fatal: no licence");
	});

	it("fails the start when the executable cannot be run", async () => {
		const { root } = setup();
		const client = new LspClient({
			command: join(root, "no-such-server"),
			args: [],
			root,
			uriStyle: uriStyleFor({ platform: process.platform }),
			languageId: () => "fake",
		});
		clients.push(client);
		await expect(client.start()).rejects.toThrow("could not be started");
		expect(client.state).toBe("failed");
	});

	it("notices a crash at once, releases whoever was waiting, and reports the exit", async () => {
		let exit = "";
		const { client, file } = setup(
			{},
			{
				onExit: (reason) => {
					exit = reason;
				},
			},
		);
		await client.start();
		client.setText(file("a.fake"), "fine", true);
		expect(await client.waitSettled(3000)).toBe(true);
		client.checkpoint();
		client.setText(file("a.fake"), "boom !crash");
		const startedAt = Date.now();
		await client.waitSettled(5000);
		expect(Date.now() - startedAt).toBeLessThan(2000);
		expect(client.state).toBe("failed");
		expect(exit).toContain("code 7");
		expect(client.fresh()).toEqual([]);
	});

	it("shuts the server down in order: shutdown, exit, and the process is gone", async () => {
		const { client, received } = setup();
		await client.start();
		await client.stop();
		expect(client.state).toBe("stopped");
		expect(received().slice(-2)).toEqual(["shutdown", "exit"]);
	});

	it("closes a document whose file is gone", async () => {
		const { client, file, received } = setup();
		await client.start();
		client.setText(file("a.fake"), "text !error E1 x", true);
		expect(await client.waitSettled(3000)).toBe(true);
		client.setText(file("a.fake"), undefined);
		expect(client.openDocuments).toBe(0);
		await expect.poll(received).toContain("textDocument/didClose");
	});
});
