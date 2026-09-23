import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { c2cMessage, groupMessage } from "./support/fake-qq.ts";
import { APP_ID, APP_SECRET, type ChannelTestEnv, startChannelTest } from "./support/harness.ts";

const ALICE = "A11CE00000000000000000000000000A";
const BOB = "B0B0000000000000000000000000000A";
const GROUP = "GROUP000000000000000000000000000A";
const quiet = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the rest of the inventory (acceptance)", () => {
	let env: ChannelTestEnv | undefined;
	afterEach(async () => {
		await env?.stop();
		env = undefined;
	});

	it("F15 answers a message QQ delivers twice only once, and turns face tags into text", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		const face = Buffer.from(JSON.stringify({ text: "[微笑]" })).toString("base64");
		const message = c2cMessage(ALICE, `你好 <faceType=1,faceId="14",ext="${face}">`);
		env.push("C2C_MESSAGE_CREATE", message);
		env.push("C2C_MESSAGE_CREATE", message);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE)[0], 15_000, "reply");
		await quiet();
		expect(env.llm.requests).toHaveLength(1);
		const user = env.llm.userTexts(0).join("\n");
		expect(user).toContain("【表情: [微笑]】");
		expect(user).not.toContain("faceType");
	});

	it("F7 F8 F18 F23 writes the run status, sends as mu's user agent, shows typing, and records the user", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		const status = JSON.parse(readFileSync(join(env.qqHome, "data", "status.json"), "utf8"));
		expect(status.default).toMatchObject({ accountId: "default", appId: APP_ID, running: true, pid: process.pid });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "在吗"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE)[0], 15_000, "reply");
		expect(env.qq.typingTo(ALICE).length).toBeGreaterThan(0);
		const sent = env.qq.sentTo("c2c", ALICE)[0];
		expect(String(sent?.headers["user-agent"])).toMatch(/^QQBotPlugin\/\S+ \(.*mu\/0\.0\.0-test\)/);
		const known = readFileSync(join(env.qqHome, "data", "known-users.json"), "utf8");
		expect(known).toContain(ALICE);
		expect(readFileSync(join(env.qqHome, "data", "status.json"), "utf8")).not.toContain(APP_SECRET);
	});

	it("F17 gives up on a turn after processingTimeoutMs and serves the next message", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false }, processingTimeoutMs: 1500 } });
		env.llm.reply({ text: "这个回答太慢了，".repeat(6), chunks: 10, chunkDelayMs: 600 }, { text: "第二条正常。" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "慢慢说"));
		await quiet(2500);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "下一条"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("第二条正常。"), 20_000, "second reply");
		expect(env.qq.textsTo("c2c", ALICE).join("")).not.toContain(
			"这个回答太慢了，这个回答太慢了，这个回答太慢了，这个回答太慢了，这个回答太慢了，这个回答太慢了，",
		);
	});

	it("F52 applies mu.json edits while running: policies at once, new credentials by reconnecting", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.writeQQBotConfig({ deliverDebounce: { enabled: false }, dmPolicy: "disabled" });
		// mu.json is polled every 2 s
		await quiet(3000);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "还理我吗"));
		await quiet();
		expect(env.llm.requests).toHaveLength(0);

		env.writeQQBotConfig({ deliverDebounce: { enabled: false }, clientSecret: "rotated-secret-7a1e" });
		await env.qq.waitForReady(2);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "现在呢"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE)[0], 15_000, "reply after reconnect");
	});

	it("says so when every session is busy and the pool is full (sessions.maxSessions)", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false }, sessions: { maxSessions: 1 } } });
		env.llm.reply({ text: "慢慢回答，".repeat(4), chunks: 8, chunkDelayMs: 300 });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "先来"));
		await env.qq.waitFor(() => env?.llm.requests.length, 10_000, "first turn");
		env.push("C2C_MESSAGE_CREATE", c2cMessage(BOB, "后到"));
		await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", BOB).includes("⚠️ 当前会话数已达上限，请稍后再试。"),
			15_000,
			"pool full notice",
		);
	});

	it("F24 answers a group without the message id in hand through the cached one (a reminder right after a chat)", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		const at = groupMessage(GROUP, ALICE, "提醒大家开会", { atBot: true });
		env.push("GROUP_AT_MESSAGE_CREATE", at);
		await env.qq.waitFor(() => env?.qq.sentTo("group", GROUP)[0], 15_000, "reply");
		const job = env.bot.runtime.reminders?.add({
			accountId: "default",
			to: `qqbot:group:${GROUP}`,
			content: "开会",
			name: "开会",
			schedule: { kind: "at", atMs: Date.now() },
		});
		expect(job).toBeDefined();
		env.llm.reply({ text: "📅 开会时间到啦！" });
		await env.bot.runtime.reminders?.runDue();
		const reminder = await env.qq.waitFor(
			() => env?.qq.sentTo("group", GROUP).find((call) => JSON.stringify(call.body).includes("开会时间到啦")),
			15_000,
			"reminder",
		);
		expect(reminder.body.msg_id).toBe(at.id);
	});

	it("F38-F48 shows a command's usage with `?`", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "/bot-streaming ?"));
		const usage = await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", ALICE).find((t) => t.includes("/bot-streaming")),
			15_000,
			"usage",
		);
		expect(usage).toContain("流式消息仅支持 C2C");
		expect(env.llm.requests).toHaveLength(0);
	});

	it("F1 keeps the gateway session for resuming", async () => {
		env = await startChannelTest({});
		await env.qq.waitFor(
			() => existsSync(join(env?.qqHome ?? "", "default", "session.json")),
			10_000,
			"session.json",
		);
	});
});
