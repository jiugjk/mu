/**
 * Agent 事件监控（原 reply-options.ts 的事件订阅）
 *
 * 原 tests/reply-options.test.ts 验证的是 OpenClaw GetReplyOptions 的开关（commentaryPayloadsEnabled 等），
 * 这些在 mu 中不存在；保留其核心约束：事件只写日志、字段精简、不输出工具参数、不产生 QQ 可见内容。
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createAgentEventMonitor, mapAgentEvent, summarizeAgentEvent } from "../src/qqbot/dispatch/agent-events.ts";
import type { PluginLogger } from "../src/qqbot/utils/plugin-logger.ts";

function logSpy() {
	const lines: string[] = [];
	const sink: PluginLogger = {
		debug: (msg) => lines.push(msg),
		info: (msg) => lines.push(msg),
		warn: (msg) => lines.push(msg),
		error: (msg) => lines.push(msg),
		child: () => sink,
	};
	return { log: sink, lines };
}

const event = (e: Record<string, unknown>) => e as unknown as AgentSessionEvent;

describe("agent event monitor", () => {
	it("logs tool calls with compact fields and never the arguments or results", () => {
		const { log, lines } = logSpy();
		const monitor = createAgentEventMonitor(log);
		monitor(event({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: { apiKey: "SECRET" } }));
		monitor(
			event({ type: "tool_execution_end", toolName: "bash", toolCallId: "t1", result: "SECRET", isError: true }),
		);
		expect(lines).toEqual([
			"onToolStart name=bash phase=start toolCallId=t1",
			"onToolResult name=bash phase=end status=error toolCallId=t1",
		]);
	});

	it("maps assistant starts (and model changes), reasoning end, compaction and retries", () => {
		const { log, lines } = logSpy();
		const monitor = createAgentEventMonitor(log);
		const start = event({ type: "message_start", message: { role: "assistant", provider: "p", model: "m" } });
		monitor(start);
		monitor(start);
		monitor(event({ type: "message_start", message: { role: "user" } }));
		monitor(event({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_end" } }));
		monitor(event({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta" } }));
		monitor(event({ type: "compaction_start", reason: "threshold" }));
		monitor(event({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false }));
		monitor(event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "x" }));
		expect(lines).toEqual([
			"onAssistantMessageStart provider=p model=m",
			"onModelSelected provider=p model=m",
			"onAssistantMessageStart provider=p model=m",
			"onReasoningEnd",
			"onCompactionStart kind=threshold",
			"onCompactionEnd status=ok kind=threshold",
			"onAutoRetry phase=start status=1/3",
		]);
	});

	it("ignores text streaming events (text goes through the delivery lanes)", () => {
		expect(mapAgentEvent(event({ type: "message_end", message: { role: "assistant" } }))).toBeUndefined();
		expect(mapAgentEvent(event({ type: "agent_end", messages: [], willRetry: false }))).toBeUndefined();
	});

	it("summarizes only whitelisted keys, like the original", () => {
		expect(summarizeAgentEvent(null)).toBe("");
		expect(summarizeAgentEvent({ name: "exec", args: { x: 1 }, model: "" })).toBe(" name=exec");
	});
});
