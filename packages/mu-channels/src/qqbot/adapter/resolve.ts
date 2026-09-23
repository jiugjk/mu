/**
 * Runtime Adapters — mu 适配层。
 *
 * 原版按候选路径探测 OpenClaw runtime（channel.inbound.run、reply.dispatchReplyWithBufferedBlockDispatcher、
 * routing.resolveAgentRoute、text.chunkMarkdownText、media.saveRemoteMedia、config.mutateConfigFile 等）。
 * 移植到 mu 后：
 *   - 消息分发 / 路由 / 会话记录由渠道宿主（QQBotRuntime.host）完成，不再经由 adapters；
 *   - getConfig / persistConfig 读写 ~/.mu/agent/mu.json；
 *   - formatEnvelope / chunkMarkdownText / saveRemoteMedia 在 mu 中没有对应能力，固定为 null，
 *     调用方走源码中原有的降级分支（内置表格感知切分、内置 fetch 下载、`标签: 内容` 格式）；
 *   - resolveAgentRoute 固定为 null：mu 只有一个 agent。
 */
import type { QQBotRuntime } from "../runtime.ts";
import type { MuConfig } from "../types.ts";

export interface RuntimeAdapters {
	/** 格式化 envelope（mu 无对应能力） */
	formatEnvelope: ((params: Record<string, unknown>) => string) | null;
	/** Markdown 文本分块（mu 无对应能力） */
	chunkMarkdownText: ((text: string, limit: number) => string[]) | null;
	/** Agent 路由（mu 只有一个 agent） */
	resolveAgentRoute: ((params: unknown) => { agentId?: string } | undefined) | null;
	/** 获取当前配置快照 */
	getConfig: (() => MuConfig) | null;
	/** 持久化配置变更：mutator 接收当前 config（可原地修改或返回新对象），写回后热生效 */
	persistConfig: ((mutator: (cfg: any) => any) => Promise<void>) | null;
	/** mu 版本 */
	version: string;
}

export function getAdapters(rt: QQBotRuntime | null | undefined): RuntimeAdapters {
	return {
		formatEnvelope: null,
		chunkMarkdownText: null,
		resolveAgentRoute: null,
		getConfig: rt ? () => rt.getConfig() : null,
		persistConfig: rt ? (mutator) => rt.persistConfig(mutator) : null,
		version: rt?.version ?? "unknown",
	};
}
