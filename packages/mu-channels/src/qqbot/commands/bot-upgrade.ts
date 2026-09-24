import type { SlashCommand } from "@tencent-connect/qqbot-nodejs";
import { getUpdateInfo } from "../features/update-checker.ts";
import type { ResolvedQQBotAccount } from "../types.ts";
import { getPackageVersion } from "../utils/pkg-version.ts";
import { checkCommandAuth } from "./config-util.ts";

const DEFAULT_UPGRADE_URL = "https://github.com/qybaihe/mu/blob/main/docs/qqbot.md";
const GITHUB_URL = "https://github.com/qybaihe/mu";
/** mu 适配：QQ 通道随 mu 发布，升级 mu 即升级通道 */
const UPGRADE_COMMAND = "npm i -g mu-agent@latest";

/** /bot-upgrade — 检查更新并查看升级指引 */
export function botUpgrade(account: ResolvedQQBotAccount): SlashCommand {
	return {
		name: "bot-upgrade",
		description: "检查更新并查看升级指引",
		scope: "c2c",
		authorized: checkCommandAuth,
		usage: ["/bot-upgrade              检查是否有新版本"].join("\n"),
		handler: async () => {
			const url = account.config.upgradeUrl ?? DEFAULT_UPGRADE_URL;
			const info = await getUpdateInfo();

			if (info.checkedAt === 0) {
				return "⏳ 版本检查中，请稍后再试";
			}

			if (info.error) {
				return ["❌ 主机网络访问异常，无法检查更新", "", `查看升级指引：[点击查看](${url})`].join("\n");
			}

			if (!info.hasUpdate) {
				return [`✅ 当前已是最新版本 v${getPackageVersion()}`, "", `项目地址：[GitHub](${GITHUB_URL})`].join("\n");
			}

			return [
				"🆕 发现新版本",
				"",
				`当前版本：**v${getPackageVersion()}**`,
				`最新版本：**v${info.latest}**`,
				"",
				`在主机上执行：\`${UPGRADE_COMMAND}\`，然后重启 \`mu qqbot start\`。`,
				`📖 升级指引：[点击查看](${url})`,
				`🌟 官方 GitHub 仓库：[点击前往](${GITHUB_URL})`,
			].join("\n");
		},
	};
}
