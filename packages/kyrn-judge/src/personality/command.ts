import { say } from "../language.ts";
import {
	activePersonality,
	applyPersonalityAction,
	builtinPersonality,
	emptyPersonalityFile,
	listPersonalities,
	PersonalityError,
	type PersonalityFile,
	type PersonalityProblem,
} from "./model.ts";
import { loadPersonality, personalityPath, writePersonality } from "./store.ts";

const PROBLEMS: Record<PersonalityProblem, { zh: string; en: string }> = {
	unknown: { zh: "没有这个人格。", en: "No personality with that id." },
	id: {
		zh: "id 要用小写字母开头，后面只能是小写字母、数字和短横线，最长 32 个字符。",
		en: "An id starts with a letter and then uses letters, digits, or hyphens, up to 32 characters.",
	},
	reserved: { zh: "这个 id 是内置人格，不能当作新人格。", en: "That id is a built-in personality." },
	protected: {
		zh: "内置人格不能删除。可以改它的提示词，或用 reset 恢复。",
		en: "A built-in personality cannot be deleted. Edit its prompt, or reset it.",
	},
	empty: { zh: "人格提示词不能是空的。", en: "The personality prompt cannot be empty." },
	long: {
		zh: "名字不超过 40 字，说明不超过 200 字，提示词不超过 12000 字。",
		en: "Name up to 40 characters, description up to 200, prompt up to 12000.",
	},
	name: { zh: "自定义人格需要一个名字。", en: "A custom personality needs a name." },
};

const USAGE = {
	zh: [
		"用法",
		"/personality                当前人格",
		"/personality list           全部人格",
		"/personality use <id>       切换（替换系统提示词中的人格版本，不追加）",
		"/personality prompt [id]    查看这一版的完整提示词",
		"/personality add <id> | <名字> | <说明> | <完整提示词>",
		"/personality edit <id> | <完整提示词>",
		"/personality delete <id>    删除自定义人格",
		"/personality reset <id>     恢复内置人格的原文",
	].join("\n"),
	en: [
		"Usage",
		"/personality                the personality in use",
		"/personality list           every personality",
		"/personality use <id>       switch (replaces the personality version in the system prompt; nothing is appended)",
		"/personality prompt [id]    the full text of that version",
		"/personality add <id> | <name> | <description> | <full prompt>",
		"/personality edit <id> | <full prompt>",
		"/personality delete <id>    delete a custom personality",
		"/personality reset <id>     restore a built-in personality's text",
	].join("\n"),
};

/** Split on ` | ` into exactly `count` fields. The last field keeps any further separators. */
function fields(rest: string, count: number): string[] | undefined {
	const parts: string[] = [];
	let left = rest.trim();
	for (let index = 0; index < count - 1; index++) {
		const at = left.indexOf(" | ");
		if (at < 0) return undefined;
		parts.push(left.slice(0, at).trim());
		left = left.slice(at + 3);
	}
	parts.push(left.trim());
	return parts;
}

function label(file: PersonalityFile, id = activePersonality(file).id): string {
	const entry = listPersonalities(file).find((item) => item.id === id) ?? activePersonality(file);
	const name = say({ zh: entry.nameZh, en: entry.nameEn });
	const description = say({ zh: entry.descriptionZh, en: entry.descriptionEn });
	return description ? `${name} (${entry.id}) — ${description}` : `${name} (${entry.id})`;
}

function known(file: PersonalityFile, id: string): boolean {
	return listPersonalities(file).some((entry) => entry.id === id);
}

/**
 * `/personality` for the terminal and for QQ. Both write `<agentDir>/mu/personality.json`.
 * With no agent directory the current default can be shown and nothing is saved.
 */
export function runPersonalityCommand(agentDir: string | undefined, args: string): string {
	const path = agentDir ? personalityPath(agentDir) : undefined;
	const loaded = path ? loadPersonality(path) : { file: emptyPersonalityFile(), invalid: false };
	const trimmed = args.trim();
	const verb = trimmed.split(/\s+/, 1)[0] ?? "";
	const rest = trimmed.slice(verb.length).trim();
	const mutates = new Set(["use", "add", "edit", "delete", "remove", "reset"]);
	if (loaded.invalid && mutates.has(verb)) {
		return say({
			zh: "人格配置文件不是合法的 JSON，没有改它。请先修好这个文件。",
			en: "The personality file is not valid JSON, so it was left as it is. Fix that file first.",
		});
	}
	try {
		if (!verb || verb === "show") {
			return [
				say({ zh: `当前人格：${label(loaded.file)}`, en: `Personality: ${label(loaded.file)}` }),
				say({
					zh: "下一句起换用这一版人格提示词，不会在系统提示词后面另加一段。",
					en: "The next message uses this version of the personality prompt. Nothing is appended to the system prompt.",
				}),
				say({
					zh: "用 /personality list 查看，/personality use <id> 切换。",
					en: "List them with /personality list, switch with /personality use <id>.",
				}),
			].join("\n");
		}
		if (verb === "help" || verb === "?") return say(USAGE);
		if (verb === "list") {
			const active = activePersonality(loaded.file).id;
			return listPersonalities(loaded.file)
				.map((entry) => {
					const mark = entry.id === active ? ">" : " ";
					const kind = entry.builtin ? "" : say({ zh: "  自定义", en: "  custom" });
					const edited = entry.overridden ? say({ zh: "  已修改", en: "  edited" }) : "";
					return `${mark} ${entry.id}  ${say({ zh: entry.nameZh, en: entry.nameEn })}${kind}${edited}`;
				})
				.join("\n");
		}
		if (verb === "prompt") {
			const id = rest || activePersonality(loaded.file).id;
			const entry = listPersonalities(loaded.file).find((item) => item.id === id);
			if (!entry) throw new PersonalityError("unknown");
			return `${label(loaded.file, entry.id)}\n\n${entry.prompt}`;
		}
		if (!mutates.has(verb)) return say(USAGE);
		if (!path) {
			return say({
				zh: "这里没有可写的人格配置，不能切换或修改。",
				en: "There is no personality file to write here, so it cannot be switched or edited.",
			});
		}
		const next = change(loaded.file, verb, rest);
		writePersonality(path, next);
		if (verb === "use") return say({ zh: `已切换为 ${label(next)}`, en: `Switched to ${label(next)}` });
		if (verb === "delete" || verb === "remove") {
			return say({ zh: `已删除。当前人格：${label(next)}`, en: `Deleted. Personality: ${label(next)}` });
		}
		if (verb === "reset") return say({ zh: `已恢复 ${label(next, rest)}`, en: `Restored ${label(next, rest)}` });
		const savedId = fields(rest, 2)?.[0] ?? rest;
		return say({ zh: `已保存 ${label(next, savedId)}`, en: `Saved ${label(next, savedId)}` });
	} catch (error) {
		if (error instanceof PersonalityError) return say(PROBLEMS[error.problem]);
		return say({ zh: "没能保存人格。", en: "Could not save the personality." });
	}
}

function change(file: PersonalityFile, verb: string, rest: string): PersonalityFile {
	if (verb === "use") return applyPersonalityAction(file, { action: "use", id: rest });
	if (verb === "delete" || verb === "remove") return applyPersonalityAction(file, { action: "remove", id: rest });
	if (verb === "reset") return applyPersonalityAction(file, { action: "reset", id: rest });
	if (verb === "edit") {
		const parts = fields(rest, 2);
		if (!parts) throw new PersonalityError("empty");
		const [id, prompt] = parts;
		if (!known(file, id) && !builtinPersonality(id)) throw new PersonalityError("unknown");
		return applyPersonalityAction(file, { action: "upsert", id, prompt });
	}
	const parts = fields(rest, 4);
	if (!parts) throw new PersonalityError("empty");
	const [id, name, description, prompt] = parts;
	if (builtinPersonality(id)) throw new PersonalityError("reserved");
	return applyPersonalityAction(file, { action: "upsert", id, name, description, prompt });
}
