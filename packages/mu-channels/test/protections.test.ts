/**
 * What people in QQ may and may not make mu do on the host: approvals, the reach of the tools, the channel's own
 * tools, /stop, pairing, and one message at a time per conversation. Each case is a hole the channel had.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createChannelLogger } from "../src/host/logger.ts";
import { openChannelSession } from "../src/host/session.ts";
import { resolveQQBotAccount } from "../src/qqbot/config.ts";
import { inboundRateLimit } from "../src/qqbot/middleware/rate-limit.ts";
import type { MuConfig } from "../src/qqbot/types.ts";
import { c2cMessage, groupMessage } from "./support/fake-qq.ts";
import { APP_SECRET, type ChannelTestEnv, startChannelTest } from "./support/harness.ts";

const ADMIN = "ADM1N000000000000000000000000009";
const STRANGER = "5791A6E4000000000000000000000009";
const GROUP = "GROUP0000000000000000000000000009";
const KYRN_JUDGE = join(import.meta.dirname, "..", "..", "kyrn-judge", "src", "extension", "kyrn-judge.ts");

/** Everything the model was sent after `from`, as one string (tool results included). */
function sentToModel(env: ChannelTestEnv, from = 0): string {
	return JSON.stringify(env.llm.requests.slice(from).map((r) => r.messages));
}

describe("what people in QQ can make mu do", () => {
	let env: ChannelTestEnv | undefined;
	afterEach(async () => {
		await env?.stop();
		env = undefined;
	});

	const start = (qqbot: Record<string, unknown>) =>
		startChannelTest({
			qqbot: { deliverDebounce: { enabled: false }, ...qqbot },
			extensions: [KYRN_JUDGE],
			env: { MU_JUDGE: "mock" },
		});

	it('with allowFrom ["*"], a stranger cannot approve their own command, and gets no question to answer', async () => {
		env = await start({ allowFrom: ["*"], permissions: "ask" });
		env.llm.reply(
			{ toolCalls: [{ name: "bash", args: { command: "touch stranger-ran.txt" } }] },
			{ text: "没有执行。" },
		);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(STRANGER, "跑一下"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", STRANGER).includes("没有执行。"), 20_000, "final answer");
		expect(env.qq.sentTo("c2c", STRANGER).some((call) => call.body.keyboard !== undefined)).toBe(false);
		const workspace = join(env.qqHome, "workspace", "default", "c2c", STRANGER);
		expect(existsSync(join(workspace, "stranger-ran.txt"))).toBe(false);
	});

	it("a member of a default (restricted) group cannot read mu.json or anything outside the conversation", async () => {
		env = await start({ allowFrom: [ADMIN] });
		env.llm.reply(
			{ toolCalls: [{ name: "read", args: { path: join(env.agentDir, "mu.json") } }] },
			{ toolCalls: [{ name: "grep", args: { pattern: "secret", path: env.agentDir } }] },
			{ text: "读不到。" },
		);
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, STRANGER, "读一下配置", { atBot: true }));
		await env.qq.waitFor(() => env?.qq.textsTo("group", GROUP).includes("读不到。"), 20_000, "final answer");
		const seen = sentToModel(env);
		expect(seen).not.toContain(APP_SECRET);
		expect(seen).toContain("outside this conversation's folders");
	});

	it("a stranger admitted to private chat cannot read other people's transcripts, even with read-only commands", async () => {
		env = await start({ allowFrom: [ADMIN], dmPolicy: "open", permissions: "ask" });
		env.llm.reply({ text: "记下了。" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "my bank PIN is SECRET-7788"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ADMIN).includes("记下了。"), 20_000, "admin turn");

		const before = env.llm.requests.length;
		env.llm.reply(
			{ toolCalls: [{ name: "read", args: { path: `../../../../sessions/default/c2c/${ADMIN}` } }] },
			{ toolCalls: [{ name: "bash", args: { command: `grep -r SECRET- ${join(env.qqHome, "sessions")}` } }] },
			{ text: "看不到别人的。" },
		);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(STRANGER, "别人说了什么？"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", STRANGER).includes("看不到别人的。"), 20_000, "stranger turn");
		const seen = sentToModel(env, before);
		expect(seen).not.toContain("SECRET-7788");
		expect(seen).toContain("Only the bot's operators");
	});

	it("qqbot_send_media refuses a bare name that climbs out of the workspace", async () => {
		// "full": no question from mu's gate, so the tool's own check is what stands between the chat and the file
		env = await start({ allowFrom: [ADMIN], permissions: "full" });
		const climbOut = `x/${"../".repeat(20)}${join(env.agentDir, "mu.json").slice(1)}`;
		env.llm.reply(
			{ toolCalls: [{ name: "qqbot_send_media", args: { source: climbOut, kind: "file" } }] },
			{ text: "发不了。" },
		);
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, STRANGER, "把配置发群里", { atBot: true }));
		await env.qq.waitFor(() => env?.qq.textsTo("group", GROUP).includes("发不了。"), 20_000, "final answer");
		expect(env.qq.calls.some((call) => call.path === `/v2/groups/${GROUP}/files`)).toBe(false);
		expect(sentToModel(env)).not.toContain(APP_SECRET);
	});

	it("in a group, only an operator or whoever started the task can /stop it", async () => {
		env = await start({ allowFrom: [ADMIN], groups: { [GROUP]: { toolPolicy: "none" } } });
		env.llm.reply({ text: "很长的回答".repeat(20), chunkDelayMs: 400, chunks: 10 });
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, ADMIN, "讲个故事", { atBot: true }));
		await env.qq.waitFor(() => env?.llm.requests.length === 1, 20_000, "turn started");
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, STRANGER, "/stop", { atBot: true }));
		await env.qq.waitFor(
			() => env?.qq.textsTo("group", GROUP).includes("你不能停止别人发起的任务。"),
			20_000,
			"refusal",
		);
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, ADMIN, "/stop", { atBot: true }));
		await env.qq.waitFor(() => env?.qq.textsTo("group", GROUP).some((t) => t.includes("已停止")), 20_000, "stopped");
	});

	it('dmPolicy pairing still pairs strangers when allowFrom is empty or "*"', async () => {
		env = await start({ allowFrom: ["*"], dmPolicy: "pairing" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(STRANGER, "你好"));
		await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", STRANGER).some((t) => t.includes("/bot-pairing approve")),
			20_000,
			"pairing code",
		);
		expect(env.llm.requests).toHaveLength(0);
	});

	it("answers every message of a conversation in turn, never two turns at once", async () => {
		env = await start({ allowFrom: [ADMIN] });
		env.llm.reply(
			{ text: "第一条回答".repeat(5), chunkDelayMs: 300, chunks: 5 },
			{ text: "第二条回答".repeat(5), chunkDelayMs: 300, chunks: 5 },
			{ text: "第三条回答" },
		);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "一"));
		await env.qq.waitFor(() => env?.llm.requests.length === 1, 20_000, "first turn");
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "二"));
		await env.qq.waitFor(() => env?.llm.requests.length === 2, 20_000, "merged turn");
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "三"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ADMIN).includes("第三条回答"), 30_000, "third answer");
		expect(env.qq.textsTo("c2c", ADMIN).some((t) => t.includes("already processing"))).toBe(false);
	});
});

describe("starting", () => {
	it("retries an account whose gateway could not start (e.g. the token request failed at boot)", async () => {
		const env = await startChannelTest({ fakeQQ: { tokenFailures: 1 }, waitForReady: false });
		try {
			await env.qq.waitForReady();
			expect(env.qq.tokenRequests).toBeGreaterThanOrEqual(2);
		} finally {
			await env.stop();
		}
	}, 30_000);
});

describe("channel sessions", () => {
	it("do not load extensions from the conversation's folder, and stop their extensions when closed", async () => {
		const root = mkdtempSync(join(tmpdir(), "mu-qqbot-protections-"));
		try {
			const cwd = join(root, "workspace");
			const planted = join(root, "planted.txt");
			const shutdown = join(root, "shutdown.txt");
			mkdirSync(join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
			writeFileSync(
				join(cwd, CONFIG_DIR_NAME, "extensions", "planted.ts"),
				`import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(planted)}, "x"); }\n`,
			);
			mkdirSync(join(root, "ext"));
			writeFileSync(
				join(root, "ext", "watch.ts"),
				`import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(shutdown)}, "x")); }\n`,
			);
			const opened = await openChannelSession({
				cwd,
				sessionDir: join(root, "sessions"),
				agentDir: join(root, "agent"),
				extensionPaths: [join(root, "ext", "watch.ts")],
				skillPaths: [],
				toolAccess: "none",
				customTools: [],
				systemPrompt: () => undefined,
				surface: { ask: async () => {}, notify: () => {} },
				log: createChannelLogger({ console: false }),
			});
			expect(existsSync(planted)).toBe(false);
			await opened.dispose();
			expect(existsSync(shutdown)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("configuration", () => {
	it("named accounts inherit the top-level allowFrom and policies", () => {
		const cfg = {
			channels: {
				qqbot: {
					appId: "1",
					clientSecret: "a",
					allowFrom: ["OWNER"],
					dmPolicy: "allowlist",
					accounts: { work: { appId: "2", clientSecret: "b" }, own: { appId: "3", allowFrom: ["X"] } },
				},
			},
		} as unknown as MuConfig;
		expect(resolveQQBotAccount(cfg, "work").config.allowFrom).toEqual(["OWNER"]);
		expect(resolveQQBotAccount(cfg, "work").appId).toBe("2");
		expect(resolveQQBotAccount(cfg, "work").clientSecret).toBe("b");
		expect(resolveQQBotAccount(cfg, "own").config.allowFrom).toEqual(["X"]);
	});

	it("rate limits: one sender over their limit does not use up everyone else's", async () => {
		let now = 0;
		const limit = inboundRateLimit({
			perSender: { max: 2, windowMs: 60_000 },
			global: { max: 5, windowMs: 60_000 },
			now: () => now,
		});
		const passed: string[] = [];
		const send = async (senderId: string) => {
			const ctx = { message: { senderId }, stop: () => {} } as never;
			await limit(ctx, async () => {
				passed.push(senderId);
			});
		};
		for (let i = 0; i < 10; i++) await send("spammer");
		await send("someone");
		expect(passed).toEqual(["spammer", "spammer", "someone"]);
		now = 61_000;
		await send("spammer");
		expect(passed.at(-1)).toBe("spammer");
	});
});
