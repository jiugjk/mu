import * as crypto from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandLogin, main, parseArgs } from "../src/qqbot/cli.ts";
import { buildConnectUrl, decryptSecret, generateBindKey } from "../src/qqbot/setup/qr-connect.ts";
import { FakeQQ } from "./support/fake-qq.ts";

const SECRET = "scanned-app-secret-9f3c";

function encrypt(plain: string, keyBase64: string): string {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
	const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64");
}

/** q.qq.com's bind API as onboard.py uses it: create_bind_task, then poll_bind_result until done. */
class FakePortal {
	readonly calls: Array<{ path: string; body: Record<string, unknown>; ua: string | undefined }> = [];
	key = "";
	/** Poll answers in order; the last one repeats. */
	polls: Array<(key: string) => Record<string, unknown>> = [];
	baseUrl = "";
	private server: Server | undefined;

	async start(): Promise<void> {
		this.server = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
			this.calls.push({ path: req.url ?? "", body, ua: req.headers["user-agent"] });
			res.setHeader("Content-Type", "application/json");
			if (req.url === "/lite/create_bind_task") {
				this.key = String(body.key);
				res.end(JSON.stringify({ retcode: 0, data: { task_id: "task-42" } }));
				return;
			}
			if (req.url === "/lite/poll_bind_result") {
				const answer = (this.polls.length > 1 ? this.polls.shift() : this.polls[0]) ?? (() => ({ status: 1 }));
				res.end(JSON.stringify({ retcode: 0, data: answer(this.key) }));
				return;
			}
			res.statusCode = 404;
			res.end("{}");
		});
		await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", () => resolve()));
		this.baseUrl = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}
}

describe("mu qqbot login / send (group 6)", () => {
	let root = "";
	let muJson = "";
	const saved = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string | undefined) => {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	let portal: FakePortal;
	let out: string[];

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "mu-qqbot-cli-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		muJson = join(agentDir, "mu.json");
		writeFileSync(muJson, JSON.stringify({ tiers: ["jev"] }));
		setEnv("PI_CODING_AGENT_DIR", agentDir);
		setEnv("MU_QQBOT_HOME", join(root, "qqbot"));
		setEnv("QQBOT_APP_ID", undefined);
		setEnv("QQBOT_CLIENT_SECRET", undefined);
		portal = new FakePortal();
		await portal.start();
		setEnv("MU_QQBOT_CONNECT_URL", portal.baseUrl);
		out = [];
	});
	afterEach(async () => {
		await portal.stop();
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		saved.clear();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	const qqbotConfig = () =>
		(JSON.parse(readFileSync(muJson, "utf8")) as { channels?: { qqbot?: Record<string, any> } }).channels?.qqbot;
	const login = (...argv: string[]) =>
		commandLogin(parseArgs(["login", ...argv]), { pollIntervalMs: 20, out: (line) => out.push(line) });

	it("binds by QR code: shows the code and link, decrypts the secret locally, writes mu.json owner-only", async () => {
		portal.polls = [
			() => ({ status: 0 }),
			() => ({ status: 1 }),
			(key) => ({
				status: 2,
				bot_appid: 102999888,
				bot_encrypt_secret: encrypt(SECRET, key),
				user_openid: "SCANNER01",
			}),
		];
		expect(await login()).toBe(0);
		expect(portal.calls[0]).toMatchObject({ path: "/lite/create_bind_task" });
		expect(Buffer.from(portal.key, "base64")).toHaveLength(32);
		expect(
			portal.calls.slice(1).every((c) => c.path === "/lite/poll_bind_result" && c.body.task_id === "task-42"),
		).toBe(true);
		const printed = out.join("\n");
		expect(printed).toContain("https://q.qq.com/qqbot/openclaw/connect.html?task_id=task-42&_wv=2&source=mu");
		expect(printed).toContain("已扫码");
		expect(printed).toContain("绑定成功：账户 default，AppID 102999888");
		expect(printed).not.toContain(SECRET);
		expect(qqbotConfig()).toMatchObject({
			enabled: true,
			appId: "102999888",
			clientSecret: SECRET,
			allowFrom: ["SCANNER01"],
			dmPolicy: "allowlist",
			streaming: { mode: "partial" },
		});
		expect((JSON.parse(readFileSync(muJson, "utf8")) as { tiers: string[] }).tiers).toEqual(["jev"]);
		if (process.platform !== "win32") expect(statSync(muJson).mode & 0o777).toBe(0o600);
	});

	it("uses the configured clawType as the QR source, and --source overrides it", async () => {
		writeFileSync(muJson, JSON.stringify({ channels: { qqbot: { clawType: "openclaw" } } }));
		portal.polls = [() => ({ status: 3 })];
		await login();
		expect(out.join("\n")).toContain("&source=openclaw");
		out = [];
		await login("--source", "custom");
		expect(out.join("\n")).toContain("&source=custom");
	});

	it("fails without writing anything when the code expires or the secret cannot be decrypted", async () => {
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((line: string) => errors.push(line));
		portal.polls = [() => ({ status: 3 })];
		expect(await login()).toBe(1);
		expect(errors.join("\n")).toContain("二维码已过期");
		portal.polls = [() => ({ status: 2, bot_appid: "1", bot_encrypt_secret: encrypt(SECRET, generateBindKey()) })];
		expect(await login()).toBe(1);
		expect(errors.join("\n")).toContain("无法解密 AppSecret");
		expect(qqbotConfig()).toBeUndefined();
	});

	it("--token AppID:AppSecret binds default first, refreshes the same AppID, and adds another as its own account", async () => {
		expect(await login("--token", "1001:secret-a")).toBe(0);
		expect(await login("--token", "1001:secret-b")).toBe(0);
		expect(await login("--token", "2002:secret-c")).toBe(0);
		const cfg = qqbotConfig();
		expect(cfg).toMatchObject({ appId: "1001", clientSecret: "secret-b", allowFrom: ["*"], dmPolicy: "allowlist" });
		expect(cfg?.accounts?.["2002"]).toMatchObject({ appId: "2002", clientSecret: "secret-c" });
		expect(out.join("\n")).not.toMatch(/secret-[abc]/);
		expect(await login("--token", "no-colon")).toBe(1);
	});

	it("--use-env leaves the secret in the environment", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await login("--use-env")).toBe(1);
		setEnv("QQBOT_APP_ID", "3003");
		setEnv("QQBOT_CLIENT_SECRET", "env-secret");
		expect(await login("--use-env")).toBe(0);
		expect(qqbotConfig()).toMatchObject({ enabled: true, dmPolicy: "allowlist" });
		expect(JSON.stringify(qqbotConfig())).not.toContain("env-secret");
	});

	it("mu qqbot logout removes the AppSecret from mu.json and keeps the rest", async () => {
		expect(await login("--token", "5005:logout-secret")).toBe(0);
		vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await main(["logout"])).toBe(0);
		const cfg = qqbotConfig();
		expect(cfg?.appId).toBe("5005");
		expect(cfg?.clientSecret).toBeUndefined();
		expect(readFileSync(muJson, "utf8")).not.toContain("logout-secret");
	});

	it("mu qqbot send sends a proactive text and a local file, without the bot running", async () => {
		const qq = new FakeQQ();
		await qq.start();
		try {
			setEnv("QQBOT_BASE_URL", qq.baseUrl);
			setEnv("QQBOT_TOKEN_BASE_URL", qq.baseUrl);
			writeFileSync(muJson, JSON.stringify({ channels: { qqbot: { appId: "4004", clientSecret: "send-secret" } } }));
			vi.spyOn(console, "log").mockImplementation(() => {});
			expect(await main(["send", "qqbot:c2c:ALICE01", "定时提醒：开会"])).toBe(0);
			const text = qq.sentTo("c2c", "ALICE01")[0];
			expect(text?.body.msg_id).toBeUndefined();
			expect(qq.textsTo("c2c", "ALICE01")).toEqual(["定时提醒：开会"]);

			const file = join(root, "report.txt");
			writeFileSync(file, "hello");
			expect(await main(["send", "qqbot:group:GROUP01", "日报", "--media", file])).toBe(0);
			expect(qq.calls.find((c) => c.path === "/v2/groups/GROUP01/files")?.body.file_type).toBe(4);

			vi.spyOn(console, "error").mockImplementation(() => {});
			expect(await main(["send", "not-a-target", "x"])).toBe(1);
		} finally {
			await qq.stop();
		}
	});
});

describe("QR bind helpers", () => {
	it("decrypts IV | ciphertext | tag with the local key and rejects another key", () => {
		const key = generateBindKey();
		expect(decryptSecret(encrypt("abc", key), key)).toBe("abc");
		expect(() => decryptSecret(encrypt("abc", key), generateBindKey())).toThrow();
	});

	it("builds the connect link", () => {
		expect(buildConnectUrl("t 1")).toBe("https://q.qq.com/qqbot/openclaw/connect.html?task_id=t+1&_wv=2");
		expect(buildConnectUrl("t", "mu")).toContain("&source=mu");
	});
});
