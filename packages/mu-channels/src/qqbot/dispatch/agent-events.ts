/**
 * Agent 事件监控（原 reply-options.ts）
 *
 * 原版向 OpenClaw 订阅 GetReplyOptions 里的 agent 事件（onToolStart / onToolResult / onReasoningEnd /
 * onCompactionStart …），一律只记日志、返回 false，不把工具名 / reasoning / plan 发到 QQ。
 *
 * mu 适配：GetReplyOptions 是 OpenClaw 专有接口。mu 会话的事件（tool_execution_start、compaction_start …）
 * 映射到原版的事件名后同样只写 debug 日志，日志格式保持不变；文本车道不经过这里
 * （partial → StreamingController，block / final → deliver，见 dispatch.ts）。
 * 只记录 EVENT_SUMMARY_KEYS 中的字段，不输出工具参数和结果（可能含凭据）。
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PluginLogger } from "../utils/plugin-logger.ts";

/** 原版监控的 agent 事件名（mu 中能对应上的部分） */
export const QQBOT_MONITORED_AGENT_EVENTS = [
	"onAssistantMessageStart",
	"onToolStart",
	"onToolResult",
	"onReasoningEnd",
	"onCompactionStart",
	"onCompactionEnd",
	"onModelSelected",
	"onAutoRetry",
] as const;

export type QqbotMonitoredAgentEvent = (typeof QQBOT_MONITORED_AGENT_EVENTS)[number];

const EVENT_SUMMARY_KEYS = [
	"name",
	"phase",
	"status",
	"kind",
	"title",
	"toolCallId",
	"itemId",
	"provider",
	"model",
] as const;

interface AssistantInfo {
	role?: string;
	provider?: string;
	model?: string;
}

/** 把 mu 会话事件映射为原版的事件名 + 摘要字段；不需要监控的事件返回 undefined */
export function mapAgentEvent(
	event: AgentSessionEvent,
): { name: QqbotMonitoredAgentEvent; payload: Record<string, unknown> } | undefined {
	switch (event.type) {
		case "message_start": {
			const message = event.message as AssistantInfo;
			if (message.role !== "assistant") return undefined;
			return { name: "onAssistantMessageStart", payload: { provider: message.provider, model: message.model } };
		}
		case "message_update":
			if (event.assistantMessageEvent.type !== "thinking_end") return undefined;
			return { name: "onReasoningEnd", payload: {} };
		case "tool_execution_start":
			return {
				name: "onToolStart",
				payload: { name: event.toolName, phase: "start", toolCallId: event.toolCallId },
			};
		case "tool_execution_end":
			return {
				name: "onToolResult",
				payload: {
					name: event.toolName,
					phase: "end",
					status: event.isError ? "error" : "ok",
					toolCallId: event.toolCallId,
				},
			};
		case "compaction_start":
			return { name: "onCompactionStart", payload: { kind: event.reason } };
		case "compaction_end":
			return {
				name: "onCompactionEnd",
				payload: { kind: event.reason, status: event.aborted ? "aborted" : event.errorMessage ? "error" : "ok" },
			};
		case "auto_retry_start":
			return { name: "onAutoRetry", payload: { phase: "start", status: `${event.attempt}/${event.maxAttempts}` } };
		case "auto_retry_end":
			return { name: "onAutoRetry", payload: { phase: "end", status: event.success ? "ok" : "failed" } };
		default:
			return undefined;
	}
}

/** 返回交给 runTurn 的 onEvent：只写日志，不向 QQ 发送任何内容 */
export function createAgentEventMonitor(log: PluginLogger | undefined): (event: AgentSessionEvent) => void {
	const eventLog = log?.child("agent");
	let lastModel: string | undefined;
	return (event) => {
		if (!eventLog) return;
		const mapped = mapAgentEvent(event);
		if (!mapped) return;
		eventLog.debug(`${mapped.name}${summarizeAgentEvent(mapped.payload)}`);
		if (mapped.name === "onAssistantMessageStart") {
			const model = `${mapped.payload.provider ?? ""}/${mapped.payload.model ?? ""}`;
			if (model !== lastModel) {
				lastModel = model;
				eventLog.debug(`onModelSelected${summarizeAgentEvent(mapped.payload)}`);
			}
		}
	};
}

export function summarizeAgentEvent(payload: unknown): string {
	if (payload == null || typeof payload !== "object") {
		return "";
	}
	const rec = payload as Record<string, unknown>;
	const bits: string[] = [];
	for (const key of EVENT_SUMMARY_KEYS) {
		const value = rec[key];
		if (value == null || value === "") continue;
		bits.push(`${key}=${String(value)}`);
	}
	return bits.length > 0 ? ` ${bits.join(" ")}` : "";
}
