import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyPersonalityFile, normalizePersonalityFile, type PersonalityFile } from "./model.ts";

/** `<agentDir>/mu/personality.json`, next to the permission default and the board. */
export function personalityPath(agentDir: string): string {
	return join(agentDir, "mu", "personality.json");
}

export interface PersonalityLoad {
	file: PersonalityFile;
	/** Unreadable, or text that is not JSON. A missing file is not invalid. */
	invalid: boolean;
}

/** Read the store. A missing file is the built-in default. A broken file is reported and not guessed at. */
export function loadPersonality(path: string): PersonalityLoad {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: emptyPersonalityFile(), invalid: false };
		return { file: emptyPersonalityFile(), invalid: true };
	}
	if (!raw.trim()) return { file: emptyPersonalityFile(), invalid: false };
	try {
		return { file: normalizePersonalityFile(JSON.parse(raw.replace(/^\uFEFF/, ""))), invalid: false };
	} catch {
		return { file: emptyPersonalityFile(), invalid: true };
	}
}

/** What a turn should use. A broken file falls back to the stock personality and is left on disk. */
export function readPersonality(path: string): PersonalityFile {
	return loadPersonality(path).file;
}

/** Writes through a temporary file in the same directory. Owner-only. */
export function writePersonality(path: string, file: PersonalityFile): void {
	const text = `${JSON.stringify({ version: file.version, active: file.active, custom: file.custom, overrides: file.overrides }, null, "\t")}\n`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temp, text, { mode: 0o600 });
	renameSync(temp, path);
}
