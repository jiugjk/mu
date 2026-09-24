import type { SlashCommand } from "@tencent-connect/qqbot-nodejs";
import { shouldUseStreaming } from "../outbound/streaming-controller.ts";
import type { QQBotRuntime } from "../runtime.ts";
import type { ResolvedQQBotAccount } from "../types.ts";
import { checkCommandAuth, updateAccountConfig } from "./config-util.ts";

/** /bot-streaming — 一键开关流式消息 */
export function botStreaming(account: ResolvedQQBotAccount, getRuntime: () => QQBotRuntime): SlashCommand {
	return {
		name: "bot-streaming",
		description: "一键开关流式消息",
		scope: "c2c",
		authorized: checkCommandAuth,
		usage: `/bot-streaming

查看当前流式消息状态，或切换开/关。
流式消息仅支持 C2C（私聊）场景。`,
		handler: async (ctx) => {
			const args = (Array.isArray(ctx.command.args) ? ctx.command.args.join(" ") : String(ctx.command.args ?? ""))
				.trim()
				.toLowerCase();
			// mu 修正：原版未配置 streaming 时显示「已启用」（实际不流式），且 /bot-streaming on 回答「无需切换」，
			// 无法开启；改为与实际发送一致的判断
			const currentEnabled = shouldUseStreaming(account, "c2c");

			// 无参数 → 显示状态
			if (!args) {
				const status = currentEnabled ? "✅ 已启用" : "❌ 未启用";
				const toggleHint = currentEnabled
					? '<qqbot-cmd-input text="/bot-streaming off" show="关闭流式"/>'
					: '<qqbot-cmd-input text="/bot-streaming on" show="开启流式"/>';
				return [
					`🌊 流式消息状态: ${status}`,
					"",
					"流式消息仅支持 C2C（私聊）场景。",
					`点击 ${toggleHint} 切换。`,
				].join("\n");
			}

			// on / off → 切换
			const targetEnabled = args === "on" || args === "1" || args === "true";
			if (targetEnabled === currentEnabled) {
				return `ℹ️ 流式消息已经是${currentEnabled ? "开启" : "关闭"}状态，无需切换。`;
			}

			const error = await updateAccountConfig(account, getRuntime, (acfg) => {
				(acfg as any).streaming = { mode: targetEnabled ? "partial" : "off" };
			});
			if (error) return error;

			account.config.streaming = { mode: targetEnabled ? "partial" : "off" };
			return targetEnabled
				? "✅ 流式消息已开启，私聊消息将以流式方式发送。"
				: "✅ 流式消息已关闭，私聊消息将以静态方式发送。";
		},
	};
}
