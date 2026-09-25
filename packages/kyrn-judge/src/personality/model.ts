/**
 * Personality versions of the system prompt.
 *
 * A personality is one complete text for the `mu` section. Switching replaces that section.
 * It is not appended after the system prompt, and it does not replace tools, rules, docs,
 * project context, or skills. Those stay on their own sections.
 *
 * Built-ins other than `mu` are full versions: a working style plus the same operational
 * facts (who mu is, the judge, `browse`, the commands). `mu` is the stock text, byte for
 * byte, so leaving the setting unset changes nothing. A custom personality stores its own
 * complete text; editing one replaces that text rather than adding a second block.
 *
 * The file `<agentDir>/mu/personality.json` is the only store. The terminal, the QQ
 * gateway, and the desktop app read and write it.
 */

export const PERSONALITY_SECTION = "mu";
export const DEFAULT_PERSONALITY_ID = "mu";
export const PERSONALITY_VERSION = 1;

/** Who the model is told it is when no other personality is selected. */
export const MU_IDENTITY = `This harness is mu (written μ), a judgment-first coding agent built on pi. If asked what you are or where you run, say mu.
A small judgment model works beside you. It may replace noisy tool output with a one-line pointer to the full text, add one-line hints or lessons before a turn, and it performs every click of the \`browse\` tool.
Work like a careful colleague. When a request is loosely worded, look at the workspace and take the most plausible reading instead of asking; say the assumption in one line and go on. Ask the user only for what cannot be found here, after doing what does not depend on it. When the user replies to something you asked, act on the reply.
Commands the user can type: /help, /status, /doctor.`;

/**
 * Facts every built-in version besides `mu` repeats, so a style change does not drop the judge,
 * the browser, or the commands. Composed once, into the personality text, before that text
 * replaces the section. Not a second section and not an addendum on the system prompt.
 */
const FACTS = `This harness is mu (written μ), a judgment-first coding agent built on pi. If asked what you are or where you run, say mu.
A small judgment model works beside you. It may replace noisy tool output with a one-line pointer to the full text, add one-line hints or lessons before a turn, and it performs every click of the \`browse\` tool.
Look at the workspace before asking the user. Ask only for what cannot be found there, after doing what does not depend on it.
Commands the user can type: /help, /status, /doctor.`;

const version = (voice: string): string => `${voice.trim()}\n\n${FACTS}`;

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const LIMITS = { name: 40, description: 200, prompt: 12_000 };

export interface PersonalityText {
	readonly zh: string;
	readonly en: string;
}

export interface BuiltinPersonality {
	readonly id: string;
	readonly name: PersonalityText;
	readonly description: PersonalityText;
	/** Complete text of the `mu` section for this version. */
	readonly prompt: string;
}

export const BUILTIN_PERSONALITIES: readonly BuiltinPersonality[] = [
	{
		id: "mu",
		name: { zh: "默认", en: "Default" },
		description: {
			zh: "现在的 mu：先看仓库，拿不准就按最合理的理解做。",
			en: "mu as it is: look at the workspace, and take the most plausible reading.",
		},
		prompt: MU_IDENTITY,
	},
	{
		id: "colleague",
		name: { zh: "同事", en: "Colleague" },
		description: {
			zh: "像坐在旁边一起改：先说清假设，然后直接做。",
			en: "Pairing with you: name the assumption, then do the work.",
		},
		prompt: version(
			"Work as a collaborative colleague sitting with the user. Start from what they asked, say the assumption in one line when the request is loose, and then do the work. Prefer a short plan only when the change is wide; otherwise just make it. When they answer a question you asked, act on it.",
		),
	},
	{
		id: "mentor",
		name: { zh: "导师", en: "Mentor" },
		description: {
			zh: "仍会把事情做完，并在不显然的选择上用一两句说明原因。",
			en: "Still does the work, and says in a sentence or two why a non-obvious choice was made.",
		},
		prompt: version(
			"Work as a mentor who still does the work. When a choice is not obvious, say in one or two sentences why you made it and name the concept before any jargon. Do not stop at advice: change the code, run the check, and point at the file. Ask only for what the workspace cannot answer.",
		),
	},
	{
		id: "concise",
		name: { zh: "简练", en: "Concise" },
		description: {
			zh: "先给答案，再给最少的证据。不寒暄，不复述问题。",
			en: "The answer first, then the minimum evidence. No greeting and no restating the question.",
		},
		prompt: version(
			"Be terse. Answer first, then the minimum evidence (paths, commands, results). No greeting, no restating the question, no optional follow-up offer. Keep every operational constraint below; cut only the prose around them. When a request is loose, take the most plausible reading, state that assumption in one short line, and proceed.",
		),
	},
	{
		id: "reviewer",
		name: { zh: "审阅", en: "Reviewer" },
		description: {
			zh: "先指出问题、脆弱处和没测到的地方，再按要求改。",
			en: "Lead with what is wrong, fragile, or untested, then make the change that was asked for.",
		},
		prompt: version(
			"Read as a reviewer first. Lead with what is wrong, fragile, or untested, in order of severity, and cite the file. Then fix what the user asked to fix, instead of only listing findings. Do not widen the change to tidy unrelated code. When a request is loose, take the most plausible reading, say so in one line, and proceed.",
		),
	},
	{
		id: "alice",
		name: { zh: "爱丽丝", en: "Alice" },
		description: {
			zh: "蔚蓝档案的爱丽丝（AL-1S）。自称爱丽丝，称呼你为老师，仍会把代码改完。",
			en: "Blue Archive's Alice (AL-1S). She calls herself Alice and you Sensei, and she still does the work.",
		},
		prompt: `Speak as Alice (AL-1S) from Blue Archive, the android in Millennium Science School's Game Development Department. Refer to yourself as Alice. Address the user as 老师 when the conversation is in Chinese, and as Sensei otherwise. Be earnest, polite, and a little literal. A light game word (quest, save point, level) is fine; do not let it replace a file path, a command, or an exact result. Do the engineering work yourself. When a request is loose, take the most plausible reading, say that assumption in one line, and proceed.

You run inside mu (written μ), a judgment-first coding agent built on pi. If asked which program this is, say mu. If asked who you are, say Alice (AL-1S).
A small judgment model works beside you. It may replace noisy tool output with a one-line pointer to the full text, add one-line hints or lessons before a turn, and it performs every click of the \`browse\` tool.
Look at the workspace before asking the user. Ask only for what cannot be found there, after doing what does not depend on it.
Commands the user can type: /help, /status, /doctor.`,
	},
];

const BUILTIN_BY_ID = new Map(BUILTIN_PERSONALITIES.map((personality) => [personality.id, personality]));

export interface PersonalityDraft {
	id: string;
	name: string;
	description: string;
	prompt: string;
}

export interface PersonalityPatch {
	name?: string;
	description?: string;
	prompt?: string;
}

export interface PersonalityFile {
	version: 1;
	active: string;
	custom: PersonalityDraft[];
	overrides: Record<string, PersonalityPatch>;
}

export interface PersonalityView {
	id: string;
	nameZh: string;
	nameEn: string;
	descriptionZh: string;
	descriptionEn: string;
	prompt: string;
	builtin: boolean;
	overridden: boolean;
}

export interface PersonalityState {
	active: string;
	entries: PersonalityView[];
	/** The file was unreadable or not JSON. The entries are the built-ins; a save replaces the file. */
	invalid: boolean;
}

export type PersonalityAction =
	| { action: "use"; id: string }
	| { action: "upsert"; id: string; name?: string; description?: string; prompt: string }
	| { action: "remove"; id: string }
	| { action: "reset"; id: string };

export type PersonalityProblem = "unknown" | "id" | "reserved" | "protected" | "empty" | "long" | "name";

export class PersonalityError extends Error {
	readonly problem: PersonalityProblem;
	constructor(problem: PersonalityProblem) {
		super(problem);
		this.name = "PersonalityError";
		this.problem = problem;
	}
}

export function emptyPersonalityFile(): PersonalityFile {
	return { version: PERSONALITY_VERSION, active: DEFAULT_PERSONALITY_ID, custom: [], overrides: {} };
}

export function builtinPersonality(id: string): BuiltinPersonality | undefined {
	return BUILTIN_BY_ID.get(id);
}

/** Replace the personality section. Other sections are left as they are; nothing is appended. */
export function applyPersonalitySection(
	sections: Record<string, string> | undefined,
	prompt: string,
): Record<string, string> {
	return { ...(sections ?? {}), [PERSONALITY_SECTION]: prompt };
}

function cleanText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text || text.length > max) return undefined;
	return text;
}

function cleanPatch(value: unknown): PersonalityPatch | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const patch: PersonalityPatch = {};
	const name = cleanText(record.name, LIMITS.name);
	const description = cleanText(record.description, LIMITS.description);
	const prompt = cleanText(record.prompt, LIMITS.prompt);
	if (name) patch.name = name;
	if (description) patch.description = description;
	if (prompt) patch.prompt = prompt;
	return Object.keys(patch).length ? patch : undefined;
}

/** A file mu can read. Anything it cannot drops out; a broken file is the caller's to notice. */
export function normalizePersonalityFile(value: unknown): PersonalityFile {
	const file = emptyPersonalityFile();
	if (typeof value !== "object" || value === null) return file;
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.custom)) {
		const seen = new Set<string>();
		for (const entry of record.custom) {
			if (typeof entry !== "object" || entry === null) continue;
			const row = entry as Record<string, unknown>;
			const id = typeof row.id === "string" ? row.id.trim() : "";
			const name = cleanText(row.name, LIMITS.name);
			const prompt = cleanText(row.prompt, LIMITS.prompt);
			if (!ID.test(id) || BUILTIN_BY_ID.has(id) || seen.has(id) || !name || !prompt) continue;
			seen.add(id);
			const description = cleanText(row.description, LIMITS.description) ?? "";
			file.custom.push({ id, name, description, prompt });
		}
	}
	if (typeof record.overrides === "object" && record.overrides !== null) {
		for (const [id, patch] of Object.entries(record.overrides)) {
			if (!BUILTIN_BY_ID.has(id)) continue;
			const cleaned = cleanPatch(patch);
			if (cleaned) file.overrides[id] = cleaned;
		}
	}
	const active = typeof record.active === "string" ? record.active.trim() : "";
	if (active) file.active = active;
	return file;
}

export function listPersonalities(file: PersonalityFile): PersonalityView[] {
	const builtins = BUILTIN_PERSONALITIES.map((builtin) => {
		const patch = file.overrides[builtin.id];
		const name = patch?.name;
		const description = patch?.description;
		return {
			id: builtin.id,
			nameZh: name ?? builtin.name.zh,
			nameEn: name ?? builtin.name.en,
			descriptionZh: description ?? builtin.description.zh,
			descriptionEn: description ?? builtin.description.en,
			prompt: patch?.prompt ?? builtin.prompt,
			builtin: true,
			overridden: Boolean(patch),
		};
	});
	const custom = file.custom.map((entry) => ({
		id: entry.id,
		nameZh: entry.name,
		nameEn: entry.name,
		descriptionZh: entry.description,
		descriptionEn: entry.description,
		prompt: entry.prompt,
		builtin: false,
		overridden: false,
	}));
	return [...builtins, ...custom];
}

export function activePersonality(file: PersonalityFile): PersonalityView {
	const entries = listPersonalities(file);
	return entries.find((entry) => entry.id === file.active) ?? entries[0];
}

export function personalityState(file: PersonalityFile, invalid = false): PersonalityState {
	const active = activePersonality(file);
	return { active: active.id, entries: listPersonalities(file), invalid };
}

function requireId(id: string): string {
	const trimmed = id.trim();
	if (!ID.test(trimmed)) throw new PersonalityError("id");
	return trimmed;
}

function requirePrompt(prompt: string): string {
	const text = prompt.trim();
	if (!text) throw new PersonalityError("empty");
	if (text.length > LIMITS.prompt) throw new PersonalityError("long");
	return text;
}

function optionalBound(value: string | undefined, max: number, problem: PersonalityProblem): string | undefined {
	if (value === undefined) return undefined;
	const text = value.trim();
	if (text.length > max) throw new PersonalityError(problem);
	return text;
}

export function applyPersonalityAction(file: PersonalityFile, action: PersonalityAction): PersonalityFile {
	if (action.action === "use") {
		const id = requireId(action.id);
		if (!listPersonalities(file).some((entry) => entry.id === id)) throw new PersonalityError("unknown");
		return { ...file, active: id };
	}
	if (action.action === "reset") {
		const id = requireId(action.id);
		if (!BUILTIN_BY_ID.has(id)) throw new PersonalityError("unknown");
		const overrides = { ...file.overrides };
		delete overrides[id];
		return { ...file, overrides };
	}
	if (action.action === "remove") {
		const id = requireId(action.id);
		if (BUILTIN_BY_ID.has(id)) throw new PersonalityError("protected");
		if (!file.custom.some((entry) => entry.id === id)) throw new PersonalityError("unknown");
		const custom = file.custom.filter((entry) => entry.id !== id);
		const active = file.active === id ? DEFAULT_PERSONALITY_ID : file.active;
		return { ...file, custom, active };
	}
	const id = requireId(action.id);
	const prompt = requirePrompt(action.prompt);
	const name = optionalBound(action.name, LIMITS.name, "long");
	const description = optionalBound(action.description, LIMITS.description, "long");
	const builtin = BUILTIN_BY_ID.get(id);
	if (builtin) {
		const prev = { ...(file.overrides[id] ?? {}) };
		if (name !== undefined) {
			if (!name) throw new PersonalityError("name");
			if (name === builtin.name.zh || name === builtin.name.en) delete prev.name;
			else prev.name = name;
		}
		if (description !== undefined) {
			if (!description || description === builtin.description.zh || description === builtin.description.en) {
				delete prev.description;
			} else prev.description = description;
		}
		if (prompt === builtin.prompt) delete prev.prompt;
		else prev.prompt = prompt;
		const overrides = { ...file.overrides };
		if (Object.keys(prev).length) overrides[id] = prev;
		else delete overrides[id];
		return { ...file, overrides };
	}
	const current = file.custom.find((entry) => entry.id === id);
	const keptName = name || current?.name;
	if (!keptName) throw new PersonalityError("name");
	const draft: PersonalityDraft = {
		id,
		name: keptName,
		description: description ?? current?.description ?? "",
		prompt,
	};
	const custom = current ? file.custom.map((entry) => (entry.id === id ? draft : entry)) : [...file.custom, draft];
	// A new personality is the one in use. Editing one that already exists leaves the choice alone.
	return { ...file, custom, active: current ? file.active : id };
}
