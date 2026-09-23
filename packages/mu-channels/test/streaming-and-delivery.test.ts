import { afterEach, describe, expect, it } from "vitest";
import { DeliverDebouncer } from "../src/qqbot/outbound/debounce.ts";
import { c2cMessage, groupMessage } from "./support/fake-qq.ts";
import { type ChannelTestEnv, readLog, startChannelTest } from "./support/harness.ts";

const ALICE = "A11CE000000000000000000000000002";
const GROUP = "GROUP0000000000000000000000000002";

const LONG_ANSWER = "流式输出：第一句已经写好，第二句正在路上，第三句收尾。";

describe("streaming and delivery lanes (group 3)", () => {
	let env: ChannelTestEnv | undefined;
	afterEach(async () => {
		await env?.stop();
		env = undefined;
	});

	it("streams a private answer through stream_messages and sends no static copy", async () => {
		env = await startChannelTest({ qqbot: { streaming: true, deliverDebounce: { enabled: false } } });
		env.llm.reply({ text: LONG_ANSWER, chunks: 5, chunkDelayMs: 250 });
		const message = c2cMessage(ALICE, "讲一段");
		env.push("C2C_MESSAGE_CREATE", message);
		const done = await env.qq.waitFor(
			() => env?.qq.streamCalls(ALICE).find((call) => call.body.input_state === 10),
			20_000,
			"DONE frame",
		);
		const frames = env.qq.streamCalls(ALICE);
		expect(frames.length).toBeGreaterThanOrEqual(2);
		expect(frames[0]?.body).toMatchObject({ msg_id: message.id, input_mode: "replace", index: 0 });
		expect(frames.every((frame) => frame.body.msg_seq === frames[0]?.body.msg_seq)).toBe(true);
		expect(done.body.content_raw).toBe(LONG_ANSWER);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(env.qq.textsTo("c2c", ALICE)).toEqual([]);
	});

	it("uses normal messages in groups even with streaming on (stream_messages is C2C only)", async () => {
		env = await startChannelTest({ qqbot: { streaming: true, deliverDebounce: { enabled: false } } });
		env.llm.reply({ text: "群里不流式。" });
		const at = groupMessage(GROUP, ALICE, "说点什么", { atBot: true });
		env.push("GROUP_AT_MESSAGE_CREATE", at);
		const sent = await env.qq.waitFor(() => env?.qq.sentTo("group", GROUP)[0], 15_000, "group reply");
		expect(sent.body.msg_id).toBe(at.id);
		expect(env.qq.calls.some((call) => call.path.endsWith("/stream_messages"))).toBe(false);
	});

	it("falls back to a static message when the stream API fails", async () => {
		env = await startChannelTest({
			qqbot: { streaming: true, deliverDebounce: { enabled: false } },
			fakeQQ: { failures: [{ match: /stream_messages$/, status: 500, body: { code: 500, message: "boom" } }] },
		});
		env.llm.reply({ text: "流式失败后改发普通消息。" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "试试"));
		await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", ALICE).includes("流式失败后改发普通消息。"),
			15_000,
			"static fallback",
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(env.qq.textsTo("c2c", ALICE)).toEqual(["流式失败后改发普通消息。"]);
	});

	it("streams each assistant message of a tool-using turn as its own stream", async () => {
		env = await startChannelTest({ qqbot: { streaming: true, deliverDebounce: { enabled: false } } });
		env.llm.reply(
			{ text: "我先看一下目录里有什么。", toolCalls: [{ name: "ls", args: { path: "." } }] },
			{ text: "看完了。" },
		);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "目录里有啥"));
		await env.qq.waitFor(
			() => (env?.qq.streamCalls(ALICE).filter((call) => call.body.input_state === 10).length ?? 0) >= 2,
			20_000,
			"two DONE frames",
		);
		const finals = env.qq
			.streamCalls(ALICE)
			.filter((call) => call.body.input_state === 10)
			.map((call) => call.body.content_raw);
		expect(finals).toEqual(["我先看一下目录里有什么。", "看完了。"]);
		expect(env.qq.textsTo("c2c", ALICE)).toEqual([]);
	});

	it("streams each assistant message on its own, even when the next is longer, and never streams reasoning", async () => {
		env = await startChannelTest({ qqbot: { streaming: true, deliverDebounce: { enabled: false } } });
		env.llm.reply(
			{ text: "<thinking>内部推理 secret plan</thinking>先看看。", toolCalls: [{ name: "ls", args: {} }] },
			{ text: "看完了，这个目录里一共有三个文件，下面逐个说明它们的用途。" },
		);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "目录"));
		await env.qq.waitFor(
			() => (env?.qq.streamCalls(ALICE).filter((call) => call.body.input_state === 10).length ?? 0) >= 2,
			20_000,
			"two DONE frames",
		);
		const finals = env.qq
			.streamCalls(ALICE)
			.filter((call) => call.body.input_state === 10)
			.map((call) => call.body.content_raw);
		expect(finals).toEqual(["先看看。", "看完了，这个目录里一共有三个文件，下面逐个说明它们的用途。"]);
		expect(JSON.stringify(env.qq.streamCalls(ALICE))).not.toContain("secret plan");
	});

	it("without streaming, sends each assistant message as it finishes and the final answer once", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.llm.reply(
			{ text: "我先看一下目录里有什么。", toolCalls: [{ name: "ls", args: { path: "SECRET-ARG-MARKER" } }] },
			{ text: "看完了。" },
		);
		const message = c2cMessage(ALICE, "目录里有啥");
		env.push("C2C_MESSAGE_CREATE", message);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("看完了。"), 20_000, "final answer");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(env.qq.textsTo("c2c", ALICE)).toEqual(["我先看一下目录里有什么。", "看完了。"]);
		expect(env.qq.sentTo("c2c", ALICE).every((call) => call.body.msg_id === message.id)).toBe(true);
		expect(env.qq.calls.some((call) => call.path.endsWith("/stream_messages"))).toBe(false);

		// Tool activity is logged in compact form (the original reply-options monitor) and never sent to QQ.
		const log = readLog(env);
		expect(log).toMatch(/onToolStart name=ls phase=start toolCallId=\S+/);
		expect(log).toMatch(/onToolResult name=ls phase=end status=(ok|error)/);
		expect(log).not.toContain("SECRET-ARG-MARKER");
		expect(env.qq.textsTo("c2c", ALICE).join("\n")).not.toContain("ls");
	});

	it("keeps the debouncer on by default: texts still arrive, in order", async () => {
		env = await startChannelTest({ qqbot: {} });
		env.llm.reply({ text: "第一段。", toolCalls: [{ name: "ls", args: {} }] }, { text: "第二段。" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "分两段说"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("第二段。"), 20_000, "second text");
		expect(env.qq.textsTo("c2c", ALICE)).toEqual(["第一段。", "第二段。"]);
	});

	it("/stop ends a streaming answer: the stream is closed and the model is not asked again", async () => {
		env = await startChannelTest({ qqbot: { streaming: true, deliverDebounce: { enabled: false } } });
		env.llm.reply({ text: "这是一个很长很长的回答，".repeat(8), chunks: 16, chunkDelayMs: 400 });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "长篇"));
		await env.qq.waitFor(() => env?.qq.streamCalls(ALICE).length, 15_000, "first frame");
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "/stop"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("⏹️ 已停止当前任务。"), 15_000, "stop notice");
		await env.qq.waitFor(
			() => env?.qq.streamCalls(ALICE).find((call) => call.body.input_state === 10),
			15_000,
			"stream closed",
		);
		expect(env.llm.requests).toHaveLength(1);
	});
});

describe("DeliverDebouncer (ported logic)", () => {
	it("merges texts enqueued within the window into one send", async () => {
		const sent: string[] = [];
		const debouncer = new DeliverDebouncer({ windowMs: 50, separator: " | " }, async (_to, text) => {
			sent.push(text);
		});
		await Promise.all([debouncer.enqueue("t", "a"), debouncer.enqueue("t", "b"), debouncer.enqueue("t", "c")]);
		expect(sent).toEqual(["a | b | c"]);
	});

	it("keeps targets apart, flushes on flushAll, and sends at once when the window is 0", async () => {
		const sent: string[] = [];
		const debouncer = new DeliverDebouncer({ windowMs: 10_000 }, async (to, text) => {
			sent.push(`${to}:${text}`);
		});
		const pending = Promise.all([debouncer.enqueue("x", "1"), debouncer.enqueue("y", "2")]);
		await debouncer.flushAll();
		await pending;
		expect(sent.sort()).toEqual(["x:1", "y:2"]);

		const direct: string[] = [];
		const off = new DeliverDebouncer({ windowMs: 0 }, async (_to, text) => {
			direct.push(text);
		});
		expect(off.enabled).toBe(false);
		await off.enqueue("t", "now");
		expect(direct).toEqual(["now"]);
	});

	it("flushes once maxWaitMs has passed even while texts keep coming", async () => {
		const sent: string[] = [];
		const debouncer = new DeliverDebouncer({ windowMs: 40, maxWaitMs: 60, separator: "+" }, async (_to, text) => {
			sent.push(text);
		});
		const first = debouncer.enqueue("t", "a");
		await new Promise((resolve) => setTimeout(resolve, 30));
		void debouncer.enqueue("t", "b");
		await new Promise((resolve) => setTimeout(resolve, 35));
		void debouncer.enqueue("t", "c");
		await first;
		expect(sent[0]).toBe("a+b+c");
	});
});
