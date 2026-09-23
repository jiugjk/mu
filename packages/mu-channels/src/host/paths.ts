import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** mu's agent directory (~/.mu/agent): mu.json, sign-ins, settings. */
export function muAgentDir(): string {
	return getAgentDir();
}

/** mu.json, where `channels.<id>` lives beside the judge settings. */
export function muConfigPath(): string {
	return join(muAgentDir(), "mu.json");
}

/**
 * Where one channel keeps its own state: `<mu home>/<channel>`, e.g. ~/.mu/qqbot.
 * `MU_<CHANNEL>_HOME` moves it (tests, several bots on one machine).
 */
export function channelHome(channel: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env[`MU_${channel.toUpperCase()}_HOME`];
	return override || join(dirname(muAgentDir()), channel);
}

/** `path.join` that also creates the directory. */
export function ensureDir(...parts: string[]): string {
	const dir = join(...parts);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** A conversation id as a directory name: openids are hex, but nothing from outside is trusted as a path. */
export function safeSegment(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	return cleaned.slice(0, 96) || "_";
}
