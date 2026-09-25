import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { say } from "../../language.ts";
import { runPersonalityCommand } from "../../personality/command.ts";
import {
	activePersonality,
	applyPersonalitySection,
	emptyPersonalityFile,
	listPersonalities,
} from "../../personality/model.ts";
import { personalityPath, readPersonality } from "../../personality/store.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

/**
 * Puts the selected personality into the `mu` section of the system prompt, replacing whatever
 * that section said. The rest of the prompt is untouched. Read again on every turn, so a switch
 * from the terminal, QQ, or the desktop settings is the version the next message uses.
 */
export function registerPersonality(runtime: KyrnRuntime, agentDir: string | undefined): void {
	const path = agentDir ? personalityPath(agentDir) : undefined;
	const { pi } = runtime;
	const file = () => (path ? readPersonality(path) : emptyPersonalityFile());

	pi.on(
		"before_agent_start",
		failOpen((event) => {
			const prompt = activePersonality(file()).prompt;
			event.systemPromptOptions.sections = applyPersonalitySection(event.systemPromptOptions.sections, prompt);
			return undefined;
		}),
	);

	pi.registerCommand("personality", {
		description: say({
			zh: "查看或切换人格。替换系统提示词中的人格版本，不在后面追加。/personality list，/personality use <id>",
			en: "Show or switch personality. Replaces the personality version in the system prompt; nothing is appended. /personality list, /personality use <id>",
		}),
		getArgumentCompletions: (prefix: string) => {
			const options = ["list", "prompt", ...listPersonalities(file()).map((entry) => `use ${entry.id}`)];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.notify(runPersonalityCommand(agentDir, args), "info");
		},
	});
}
