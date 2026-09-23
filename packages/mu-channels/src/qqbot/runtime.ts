/**
 * QQBot 通道运行时管理。
 *
 * mu 适配：原版保存 OpenClaw 的 PluginRuntime（框架注入）；移植后保存 mu 渠道宿主提供的 QQBotRuntime。
 * 原版在这里注册 SIGINT/SIGTERM 退出钩子并直接 process.exit；移植后退出流程统一由 `mu qqbot start`
 * 负责（先停网关、再 flush ref-index），库代码不再调用 process.exit。
 */
import type { ChannelLogger, Redactor } from "../host/logger.ts";
import { setOpenClawVersion } from "./bot-instance.ts";
import type { ReminderScheduler } from "./features/reminders.ts";
import type { QQBotHost } from "./host.ts";
import type { MuConfig } from "./types.ts";

export interface QQBotRuntime {
	/** mu 版本（原版为 OpenClaw 框架版本） */
	version: string;
	/** 当前 mu.json 快照 */
	getConfig(): MuConfig;
	/** 修改并原子写回 mu.json（mutator 可原地修改或返回新对象） */
	persistConfig(mutator: (cfg: MuConfig) => unknown): Promise<void>;
	/** 会话宿主：每个私聊/群一个 mu 会话 */
	host: QQBotHost;
	logger: ChannelLogger;
	redactor: Redactor;
	/**
	 * mu provider 的凭据（auth.json / 环境变量 / models.json），供 STT 等非对话调用使用。
	 * mu 适配：替代原版从 OpenClaw 配置 models.providers 读取。
	 */
	providerAuth?: (provider: string) => Promise<{ apiKey?: string; baseUrl?: string } | undefined>;
	/** 定时提醒调度器（`mu qqbot start` 运行时存在；原版由 OpenClaw cron 负责） */
	reminders?: ReminderScheduler;
}

let runtime: QQBotRuntime | null = null;

export function setQQBotRuntime(next: QQBotRuntime | null) {
	runtime = next;
	if (next) setOpenClawVersion(next.version);
}

export function getQQBotRuntime(): QQBotRuntime {
	if (!runtime) throw new Error("QQBot runtime not initialized");
	return runtime;
}

export function tryGetQQBotRuntime(): QQBotRuntime | null {
	return runtime;
}
