import { afterEach, describe, expect, it } from "vitest";
import { c2cMessage } from "./support/fake-qq.ts";
import { APP_SECRET, type ChannelTestEnv, readLog, startChannelTest } from "./support/harness.ts";

const USER = "A1B2C3D4E5F60718293A4B5C6D7E8F90";

describe("QQ private chat, text (group 1)", () => {
	let env: ChannelTestEnv | undefined;
	afterEach(async () => {
		await env?.stop();
		env = undefined;
	});

	it("answers a private message in a mu session, as a passive reply to that message", async () => {
		env = await startChannelTest({ qqbot: { allowFrom: ["*"], deliverDebounce: { enabled: false } } });
		env.llm.reply({ text: "你好，我是 mu。" });
		const inbound = c2cMessage(USER, "你好");
		env.push("C2C_MESSAGE_CREATE", inbound);

		const sent = await env.qq.waitFor(
			() => env?.qq.sentTo("c2c", USER).find((call) => JSON.stringify(call.body).includes("你好，我是 mu")),
			15_000,
			"reply",
		);
		expect(sent.body.msg_id).toBe(inbound.id);
		expect(env.llm.userTexts(0).join("\n")).toContain("你好");
		// The QQ channel's own prompt reaches the model.
		expect(env.llm.systemPrompt(0)).toContain("QQ 私聊");
	});

	it("keeps one mu session per conversation: the second message sees the first exchange", async () => {
		env = await startChannelTest({ qqbot: { allowFrom: ["*"], deliverDebounce: { enabled: false } } });
		env.llm.reply({ text: "记住了，你叫小明。" }, { text: "你叫小明。" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(USER, "我叫小明"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", USER).some((t) => t.includes("记住了")), 15_000, "first reply");
		env.push("C2C_MESSAGE_CREATE", c2cMessage(USER, "我叫什么"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", USER).some((t) => t === "你叫小明。"), 15_000, "second reply");

		const second = JSON.stringify(env.llm.requests[1]?.messages);
		expect(second).toContain("我叫小明");
		expect(second).toContain("记住了，你叫小明。");
		expect(second).toContain("我叫什么");
	});

	it("strips thinking and system-reminder blocks before sending", async () => {
		env = await startChannelTest({ qqbot: { allowFrom: ["*"], deliverDebounce: { enabled: false } } });
		env.llm.reply({ text: "<thinking>内部推理</thinking>最终答案<system-reminder>x</system-reminder>" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(USER, "问题"));
		const text = await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", USER).find((t) => t.includes("最终答案")),
			15_000,
			"reply",
		);
		expect(text).not.toContain("内部推理");
		expect(text).not.toContain("system-reminder");
	});

	it("splits a long answer into 5000-character messages; after 4 passive replies the rest go out proactively", async () => {
		env = await startChannelTest({ qqbot: { allowFrom: ["*"], deliverDebounce: { enabled: false } } });
		const paragraph = (n: number) => `${String(n).repeat(10)}${"字".repeat(4900)}`;
		const long = [1, 2, 3, 4, 5, 6].map(paragraph).join("\n");
		env.llm.reply({ text: long, chunks: 12 });
		const inbound = c2cMessage(USER, "写长文");
		env.push("C2C_MESSAGE_CREATE", inbound);

		const calls = await env.qq.waitFor(
			() => {
				const sent = env?.qq.sentTo("c2c", USER) ?? [];
				return sent.length >= 6 ? sent : undefined;
			},
			20_000,
			"six chunks",
		);
		for (const call of calls) {
			const text = JSON.stringify(call.body);
			expect(text.length).toBeLessThan(5400);
		}
		const passive = calls.filter((call) => call.body.msg_id === inbound.id);
		const proactive = calls.filter((call) => call.body.msg_id === undefined);
		expect(passive).toHaveLength(4);
		expect(proactive.length).toBeGreaterThanOrEqual(2);
	});

	it("never writes the AppSecret or the access token to its log", async () => {
		env = await startChannelTest({ qqbot: { allowFrom: ["*"], deliverDebounce: { enabled: false } } });
		env.llm.reply({ text: "ok" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(USER, "hi"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", USER).length, 15_000, "reply");
		const log = readLog(env);
		expect(log.length).toBeGreaterThan(0);
		expect(log).not.toContain(APP_SECRET);
		expect(log).not.toContain("fake-access-token-0123456789");
	});
});
