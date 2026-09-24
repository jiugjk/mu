/**
 * StreamingController 状态机单元测试
 *
 * openclaw-qqbot 自带的 tests/streaming-controller.test.ts 引用了已不存在的 src/streaming.js
 * （旧版控制器，含 processMediaTags / pendingNormalizedFull），在原仓库中同样无法运行，因此未移植；
 * 这里针对现行 src/outbound/streaming-controller.ts 的行为重写：前缀续写、空白归一化、工具调用后的新回复、
 * 尾部重写追加、首帧失败降级静态消息、finalize / abort。
 */
import { describe, expect, it } from "vitest";
import type { QQBotGateway } from "../src/qqbot/gateway/qqbot-gateway.ts";
import { StreamingController, shouldUseStreaming } from "../src/qqbot/outbound/streaming-controller.ts";
import type { ResolvedQQBotAccount } from "../src/qqbot/types.ts";

interface FakeStream {
	updates: string[];
	completed: boolean;
}

function fakeGateway(options: { failUpdate?: boolean } = {}) {
	const streams: FakeStream[] = [];
	const gateway = {
		openStream: () => {
			const stream: FakeStream = { updates: [], completed: false };
			streams.push(stream);
			return {
				update: async (text: string) => {
					if (options.failUpdate) throw new Error("stream api down");
					stream.updates.push(text);
				},
				complete: async () => {
					stream.completed = true;
				},
			};
		},
	} as unknown as QQBotGateway;
	return { gateway, streams };
}

function controller(options: { failUpdate?: boolean } = {}) {
	const { gateway, streams } = fakeGateway(options);
	const ctrl = new StreamingController({
		gateway,
		target: { scope: "c2c", targetId: "u", msgId: "m" },
		accountId: "a",
		replyToId: "m",
	});
	return { ctrl, streams };
}

describe("StreamingController", () => {
	it("opens one stream on the first partial and sends every growth of the text", async () => {
		const { ctrl, streams } = controller();
		expect(ctrl.hasStarted).toBe(false);
		const first = ctrl.onPartialReply("你好");
		expect(ctrl.hasStarted).toBe(true); // 同步置位，final 去重依赖它
		await first;
		await ctrl.onPartialReply("你好世界");
		await ctrl.onPartialReply("你好世界"); // 未增长不重发
		await ctrl.finalize();
		expect(streams).toHaveLength(1);
		expect(streams[0]).toEqual({ updates: ["你好", "你好世界"], completed: true });
		expect(ctrl.currentPhase).toBe("done");
		expect(ctrl.shouldFallbackToStatic).toBe(false);
	});

	it("treats whitespace-only differences in the prefix as continuation", async () => {
		const { ctrl, streams } = controller();
		await ctrl.onPartialReply("第一行\n");
		await ctrl.onPartialReply("第一行 \n\n第二行");
		await ctrl.finalize();
		expect(streams).toHaveLength(1);
		expect(streams[0]?.updates).toEqual(["第一行\n", "第一行 \n\n第二行"]);
	});

	it("starts a new stream when the text gets shorter (the next assistant message after a tool call)", async () => {
		const { ctrl, streams } = controller();
		await ctrl.onPartialReply("我先查一下目录。");
		await ctrl.onPartialReply("好了");
		await ctrl.finalize();
		expect(streams.map((s) => s.updates)).toEqual([["我先查一下目录。"], ["好了"]]);
		expect(streams.every((s) => s.completed)).toBe(true);
	});

	it("appends to the same stream when the model rewrites the tail but the text grows", async () => {
		const { ctrl, streams } = controller();
		await ctrl.onPartialReply("答案是 A");
		await ctrl.onPartialReply("答案是 B，理由如下");
		await ctrl.finalize();
		expect(streams).toHaveLength(1);
		// 已下发前缀不可变：保留 "答案是 A"，追加新文本超出公共前缀的部分
		expect(streams[0]?.updates).toEqual(["答案是 A", "答案是 AB，理由如下"]);
	});

	it("fails over to static delivery when the first frame cannot be sent", async () => {
		const { ctrl } = controller({ failUpdate: true });
		await ctrl.onPartialReply("文本");
		await ctrl.onPartialReply("文本更多"); // 已失败，忽略
		await ctrl.finalize();
		expect(ctrl.currentPhase).toBe("failed");
		expect(ctrl.hasSentChunks).toBe(false);
		expect(ctrl.shouldFallbackToStatic).toBe(true);
	});

	it("finalize without any partial marks the lane for static fallback", async () => {
		const { ctrl, streams } = controller();
		await ctrl.finalize();
		expect(streams).toHaveLength(0);
		expect(ctrl.shouldFallbackToStatic).toBe(true);
	});

	it("abort closes an open stream and ignores later partials", async () => {
		const { ctrl, streams } = controller();
		await ctrl.onPartialReply("进行中");
		await ctrl.abort("stop");
		await ctrl.onPartialReply("进行中，还有更多");
		expect(streams[0]).toEqual({ updates: ["进行中"], completed: true });
		expect(ctrl.isTerminal).toBe(true);
		expect(ctrl.shouldFallbackToStatic).toBe(false);
	});
});

describe("shouldUseStreaming", () => {
	const account = (streaming: unknown) => ({ config: { streaming } }) as unknown as ResolvedQQBotAccount;

	it("streams only private chats, and only when streaming is on", () => {
		expect(shouldUseStreaming(account(true), "c2c")).toBe(true);
		expect(shouldUseStreaming(account({ mode: "partial" }), "c2c")).toBe(true);
		expect(shouldUseStreaming(account({ mode: "off" }), "c2c")).toBe(false);
		expect(shouldUseStreaming(account(undefined), "c2c")).toBe(false);
		expect(shouldUseStreaming(account(true), "group")).toBe(false);
		expect(shouldUseStreaming(account(true), "channel")).toBe(false);
	});
});
