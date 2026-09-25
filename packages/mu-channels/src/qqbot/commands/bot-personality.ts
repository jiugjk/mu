import type { SlashCommand } from "@tencent-connect/qqbot-nodejs";
import { runPersonalityCommand } from "../../../../kyrn-judge/src/personality/command.ts";
import { muAgentDir } from "../../host/paths.ts";
import { checkAdminCommandAuth } from "./config-util.ts";

function commandText(raw: unknown, args: unknown): string {
	if (typeof raw === "string") return raw.trim();
	if (Array.isArray(args)) return args.join(" ").trim();
	return typeof args === "string" ? args.trim() : "";
}

/**
 * `/personality` — view, switch, and edit personalities.
 * The same file the terminal and the desktop settings use. Switching replaces the personality
 * version inside the system prompt; it does not append a second prompt.
 */
export function botPersonality(): SlashCommand {
	return {
		name: "personality",
		description: "查看、切换和配置人格",
		scope: "c2c",
		authorized: checkAdminCommandAuth,
		usage: [
			"/personality",
			"",
			"查看当前人格，或切换、增改。与终端 /personality、应用内设置写同一个文件。",
			"切换会替换系统提示词中的人格版本，不会在系统提示词后面再加一段。",
			"",
			"/personality list",
			"/personality use <id>",
			"/personality prompt [id]",
			"/personality add <id> | <名字> | <说明> | <完整提示词>",
			"/personality edit <id> | <完整提示词>",
			"/personality delete <id>",
			"/personality reset <id>",
		].join("\n"),
		handler: (ctx) => runPersonalityCommand(muAgentDir(), commandText(ctx.command.raw, ctx.command.args)),
	};
}
