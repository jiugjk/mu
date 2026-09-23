import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MuConfigFile } from "../src/host/config-store.ts";
import { createChannelLogger, Redactor } from "../src/host/logger.ts";
import { safeSegment } from "../src/host/paths.ts";
import { SessionPool, SessionPoolFullError } from "../src/host/session-pool.ts";

function fakePool(options: {
	idleMs?: number;
	maxSessions?: number;
	canClose?: (value: { key: string; pending: boolean }) => boolean;
}) {
	let now = 0;
	const opened: string[] = [];
	const closed: string[] = [];
	const pool = new SessionPool<{ key: string; pending: boolean }>({
		idleMs: options.idleMs,
		maxSessions: options.maxSessions,
		now: () => now,
		create: async (key) => {
			opened.push(key);
			return { key, pending: false };
		},
		dispose: (value) => {
			closed.push(value.key);
		},
		canClose: options.canClose,
	});
	return {
		pool,
		opened,
		closed,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("session pool", () => {
	it("reuses one session per key", async () => {
		const { pool, opened } = fakePool({});
		(await pool.acquire("a")).release();
		(await pool.acquire("a")).release();
		expect(opened).toEqual(["a"]);
	});

	it("opens a key once even when two messages race for it", async () => {
		const { pool, opened } = fakePool({});
		const [one, two] = await Promise.all([pool.acquire("a"), pool.acquire("a")]);
		one.release();
		two.release();
		expect(opened).toEqual(["a"]);
	});

	it("closes sessions idle for longer than idleMs (default 30 minutes), keeping busy ones", async () => {
		const { pool, closed, advance } = fakePool({});
		(await pool.acquire("idle")).release();
		const busy = await pool.acquire("busy");
		advance(29 * 60_000);
		expect(await pool.reclaimIdle()).toEqual([]);
		advance(2 * 60_000);
		expect(await pool.reclaimIdle()).toEqual(["idle"]);
		expect(closed).toEqual(["idle"]);
		expect(pool.keys()).toEqual(["busy"]);
		busy.release();
	});

	it("does not close a session that cannot close yet (a question is waiting)", async () => {
		const { pool, advance } = fakePool({ idleMs: 1000, canClose: (value) => !value.pending });
		const lease = await pool.acquire("q");
		lease.value.pending = true;
		lease.release();
		advance(5000);
		expect(await pool.reclaimIdle()).toEqual([]);
		lease.value.pending = false;
		expect(await pool.reclaimIdle()).toEqual(["q"]);
	});

	it("at the limit, closes the least recently used idle session before opening another", async () => {
		const { pool, closed, advance } = fakePool({ maxSessions: 2 });
		(await pool.acquire("a")).release();
		advance(10);
		(await pool.acquire("b")).release();
		advance(10);
		(await pool.acquire("a")).release(); // a is now newer than b
		advance(10);
		(await pool.acquire("c")).release();
		expect(closed).toEqual(["b"]);
		expect(pool.keys().sort()).toEqual(["a", "c"]);
	});

	it("refuses a new conversation when every open session is busy", async () => {
		const { pool } = fakePool({ maxSessions: 1 });
		const busy = await pool.acquire("a");
		await expect(pool.acquire("b")).rejects.toBeInstanceOf(SessionPoolFullError);
		busy.release();
		(await pool.acquire("b")).release();
		expect(pool.keys()).toEqual(["b"]);
	});
});

describe("mu.json store", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps keys it does not own, writes atomically and owner-only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-config-"));
		dirs.push(dir);
		const path = join(dir, "mu.json");
		writeFileSync(path, JSON.stringify({ tiers: ["jev"], modes: { default: "shadow" } }));
		const file = new MuConfigFile(path);
		await file.update((cfg) => {
			cfg.channels = { qqbot: { appId: "1" } };
		});
		const written = JSON.parse(readFileSync(path, "utf8"));
		expect(written).toEqual({ tiers: ["jev"], modes: { default: "shadow" }, channels: { qqbot: { appId: "1" } } });
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("serializes concurrent updates", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-config-"));
		dirs.push(dir);
		const file = new MuConfigFile(join(dir, "mu.json"));
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				file.update((cfg) => {
					cfg[`k${i}`] = i;
				}),
			),
		);
		expect(Object.keys(file.read())).toHaveLength(10);
	});

	it("refuses a file that is not JSON instead of treating it as empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-config-"));
		dirs.push(dir);
		const path = join(dir, "mu.json");
		writeFileSync(path, "{ half");
		expect(() => new MuConfigFile(path).read()).toThrow();
	});
});

describe("log redaction", () => {
	it("masks registered secrets and credential-shaped fields", () => {
		const redactor = new Redactor();
		redactor.add("s3cr3t-app-secret");
		expect(redactor.redact("secret is s3cr3t-app-secret here")).toBe("secret is *** here");
		expect(redactor.redact("Authorization: QQBot abcdefghijklmnop")).toBe("Authorization: QQBot ***");
		expect(redactor.redact('{"access_token":"tok123456","expires_in":7200}')).toBe(
			'{"access_token":"***","expires_in":7200}',
		);
		expect(redactor.redact('{"clientSecret":"xyz12345"}')).toBe('{"clientSecret":"***"}');
		expect(redactor.redact("appSecret=abc123456")).toBe("appSecret=***");
	});

	it("writes redacted lines to the log file", () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-log-"));
		try {
			const redactor = new Redactor();
			redactor.add("super-secret-value");
			const file = join(dir, "logs", "x.log");
			const log = createChannelLogger({ file, console: false, redactor, level: "debug" });
			log.child("a").info("token super-secret-value used", { clientSecret: "zzzzzzzz" });
			const text = readFileSync(file, "utf8");
			expect(text).toContain("[a] token *** used");
			expect(text).not.toContain("super-secret-value");
			expect(text).not.toContain("zzzzzzzz");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("paths", () => {
	it("never lets an id from outside become a path", () => {
		expect(safeSegment("../../etc")).not.toContain("/");
		expect(safeSegment("..")).not.toMatch(/^\./);
		expect(safeSegment("E7A8F3B2C1D4")).toBe("E7A8F3B2C1D4");
		expect(safeSegment("a/b\\c")).toBe("a_b_c");
	});
});
