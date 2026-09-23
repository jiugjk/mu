/**
 * 斜杠命令注册表
 *
 * 通过 SDK 的 slashCommand 中间件统一注册所有内置命令。
 * 每个命令拆分为独立文件，此处仅编排。
 */
import type { SlashCommand } from "@tencent-connect/qqbot-nodejs";
import type { QQBotRuntime } from "../runtime.ts";
import type { ResolvedQQBotAccount } from "../types.ts";
import { botApprove } from "./bot-approve.ts";
import { botClearStorage } from "./bot-clear-storage.ts";
import { botGroupAlways } from "./bot-group-always.ts";
import { botHelp } from "./bot-help.ts";
import { botLogs } from "./bot-logs.ts";
import { botMe } from "./bot-me.ts";
import { botPairing } from "./bot-pairing.ts";
import { botPing } from "./bot-ping.ts";
import { botStreaming } from "./bot-streaming.ts";
import { botUpgrade } from "./bot-upgrade.ts";
import { botVersion } from "./bot-version.ts";

export interface CommandBuildOptions {
	getRuntime: () => QQBotRuntime;
}

/**
 * 构建标准命令列表（匹配后直接回复，不进入 AI）
 */
export function buildCommandList(account: ResolvedQQBotAccount, opts: CommandBuildOptions): SlashCommand[] {
	const commands: SlashCommand[] = [];

	// help 需要访问完整命令列表，延迟绑定
	const help = botHelp(account, () => commands);
	commands.push(
		help,
		botPing(),
		botVersion(account),
		botMe(),
		botUpgrade(account),
		botLogs(opts.getRuntime),
		botStreaming(account, opts.getRuntime),
		botClearStorage(account),
		botApprove(account, opts.getRuntime),
		botGroupAlways(account, opts.getRuntime),
		botPairing(opts.getRuntime),
	);

	return commands.map(withUsageHelp);
}

/**
 * `/指令名 ?` 查看用法。
 * mu 修正：原版 /bot-help 写着「使用 /指令名 ? 可查看某条指令的详细用法」，但插件与 SDK 都没有处理 `?`，
 * 参数被当成普通参数（如 /bot-streaming ? 会被当作「关闭」）。这里在进入命令之前统一回答用法。
 */
function withUsageHelp(command: SlashCommand): SlashCommand {
	if (!command.usage) return command;
	const name = Array.isArray(command.name) ? command.name[0] : command.name;
	const handler = command.handler;
	return {
		...command,
		handler: (ctx) => {
			const raw = typeof ctx.command.raw === "string" ? ctx.command.raw.trim() : "";
			if (raw === "?" || raw === "？") return [`📖 /${name} 用法`, "", String(command.usage)].join("\n");
			return handler(ctx);
		},
	};
}
