import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { c2cMessage } from "./support/fake-qq.ts";
import { type ChannelTestEnv, startChannelTest } from "./support/harness.ts";

const ADMIN = "ADM1ADM1ADM1ADM1ADM1ADM1ADM1ADM1";
const OTHER = "0EE10EE10EE10EE10EE10EE10EE10EE1";

describe("basic slash commands and /stop (group 1)", () => {
	let env: ChannelTestEnv;
	beforeAll(async () => {
		env = await startChannelTest({ qqbot: { allowFrom: [ADMIN, OTHER], deliverDebounce: { enabled: false } } });
	});
	afterAll(async () => {
		await env.stop();
	});

	const ask = async (user: string, text: string, match: (reply: string) => boolean) => {
		const before = env.qq.textsTo("c2c", user).length;
		env.push("C2C_MESSAGE_CREATE", c2cMessage(user, text));
		return env.qq.waitFor(() => env.qq.textsTo("c2c", user).slice(before).find(match), 15_000, `reply to ${text}`);
	};

	it("/bot-ping answers pong without reaching the model", async () => {
		const requests = env.llm.requests.length;
		const reply = await ask(ADMIN, "/bot-ping", (t) => t.includes("pong"));
		expect(reply).toMatch(/延迟|pong/);
		expect(env.llm.requests.length).toBe(requests);
	});

	it("/bot-me tells the sender their OpenID", async () => {
		const reply = await ask(ADMIN, "/bot-me", (t) => t.includes("OpenID"));
		expect(reply).toContain(ADMIN);
	});

	it("/bot-help lists the commands with clickable inputs and the version", async () => {
		const reply = await ask(ADMIN, "/bot-help", (t) => t.includes("bot-ping"));
		expect(reply).toContain('<qqbot-cmd-input text="/bot-ping"');
		expect(reply).toContain("0.0.0-test");
	});

	it("/bot-version shows mu's version and survives an offline version check", async () => {
		const reply = await ask(ADMIN, "/bot-version", (t) => t.includes("版本"));
		expect(reply).toContain("0.0.0-test");
		expect(reply).toContain("版本检查失败");
	});

	it("/stop with nothing running says so, without the model", async () => {
		const requests = env.llm.requests.length;
		await ask(OTHER, "/stop", (t) => t.includes("没有正在进行的任务"));
		expect(env.llm.requests.length).toBe(requests);
	});
});

describe("mu slash commands in QQ are only for users listed in allowFrom (Q5a)", () => {
	let env: ChannelTestEnv;
	beforeAll(async () => {
		env = await startChannelTest({ qqbot: { allowFrom: ["*"], deliverDebounce: { enabled: false } } });
	});
	afterAll(async () => {
		await env.stop();
	});

	it('with allowFrom ["*"], a /command is sent to the model as plain text', async () => {
		env.llm.reply({ text: "收到" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(OTHER, "/permissions full"));
		await env.qq.waitFor(() => env.qq.textsTo("c2c", OTHER).find((t) => t.includes("收到")), 15_000, "model reply");
		expect(env.llm.userTexts().join("\n")).toContain("/permissions full");
	});
});
