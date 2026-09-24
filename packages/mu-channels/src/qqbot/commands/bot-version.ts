import type { SlashCommand } from "@tencent-connect/qqbot-nodejs";
import { getOpenClawVersion } from "../bot-instance.ts";
import { getUpdateInfo } from "../features/update-checker.ts";
import type { ResolvedQQBotAccount } from "../types.ts";
import { getPackageVersion } from "../utils/pkg-version.ts";

const GITHUB_URL = "https://github.com/qybaihe/mu";

/** /bot-version — 查看插件版本号 */
export function botVersion(_account: ResolvedQQBotAccount): SlashCommand {
	return {
		name: "bot-version",
		description: "查看插件版本号",
		usage: ["/bot-version", "", "查看当前 QQBot 通道版本和 mu 版本。", "同时检查是否有新版本可用。"].join("\n"),
		handler: async () => {
			const frameworkVersion = getOpenClawVersion();
			const lines = [`μ mu 版本：${frameworkVersion}`, `🤖QQBot 通道版本：v${getPackageVersion()}`];

			const info = await getUpdateInfo();
			if (info.checkedAt === 0) {
				lines.push("⏳ 版本检查中...");
			} else if (info.error) {
				lines.push("⚠️ 版本检查失败");
			} else if (info.hasUpdate && info.latest) {
				lines.push(
					`🆕最新可用版本：v${info.latest}，点击 <qqbot-cmd-input text="/bot-upgrade" show="/bot-upgrade"/> 查看升级指引`,
				);
			}

			lines.push(`🌟官方 GitHub 仓库：[点击前往](${GITHUB_URL})`);
			return lines.join("\n");
		},
	};
}
