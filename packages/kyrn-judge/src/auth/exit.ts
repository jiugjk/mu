import { mkdirSync, rmdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * How `mu auth` ends. pi keeps the credentials (auth.json) and the model catalogue (models-store.json) under a lock:
 * a folder beside the file, `<file>.lock` (proper-lockfile), made by an asynchronous mkdir and removed by an
 * asynchronous rmdir. A process that exits in between leaves the folder behind, and every other mu then waits on
 * that file until the lock counts as stale, 30 s later: a conversation the app starts meanwhile finds no model.
 *
 * The answer of `mu auth` is out while pi is still at work: registering a provider starts a catalogue refresh that
 * nobody waits for. So the exit waits until this process can make every lock folder itself, all in one go: then no
 * lock work of its own is under way. It removes them and exits in that same step, before anything else of the
 * process can run. A lock another process keeps past `limitMs` is that process's own: the exit stops waiting for it.
 */
export async function exitWhenUnlocked(
	code: number,
	files: readonly string[],
	exit: (code: number) => void,
	{ limitMs = 5000, pollMs = 20 }: { readonly limitMs?: number; readonly pollMs?: number } = {},
): Promise<void> {
	const locks = lockFolders(files);
	const deadline = Date.now() + limitMs;
	while (true) {
		const taken = takeAll(locks);
		if (taken || Date.now() >= deadline) {
			for (const lock of taken ?? []) drop(lock);
			exit(code);
			return;
		}
		await sleep(pollMs);
	}
}

/**
 * How a session of mu ends (`session_shutdown`, reason `quit`): pi calls process.exit soon after, and a lock of its
 * stores this process is taking or dropping then stays behind, as with `mu auth` above. pi still awaits things before
 * it exits (its output is flushed), so looking once would not do: the lock folders are taken as soon as none is held,
 * and kept until the process exits, which removes them in the same step. Whatever of this process wants one
 * meanwhile waits, and never starts. A lock another process keeps past `limitMs` is that process's own: then nothing
 * is taken. A process that lives on after its session ended (pi run as a library) gives them back after `holdMs`.
 *
 * @returns a function that gives the folders back now, or undefined when none was taken
 */
export async function holdLocksUntilExit(
	files: readonly string[],
	{
		limitMs = 3000,
		pollMs = 20,
		holdMs = 2000,
	}: { readonly limitMs?: number; readonly pollMs?: number; readonly holdMs?: number } = {},
): Promise<(() => void) | undefined> {
	const locks = lockFolders(files);
	const deadline = Date.now() + limitMs;
	let taken = takeAll(locks);
	while (!taken && Date.now() < deadline) {
		await sleep(pollMs);
		taken = takeAll(locks);
	}
	if (!taken) return undefined;
	const held = taken;
	const release = () => {
		clearTimeout(timer);
		process.off("exit", release);
		for (const lock of held) drop(lock);
	};
	const timer = setTimeout(release, holdMs);
	timer.unref();
	process.once("exit", release);
	return release;
}

/** The folder proper-lockfile makes beside each file while it is locked, once each. */
function lockFolders(files: readonly string[]): string[] {
	return [...new Set(files.map((file) => `${resolve(file)}.lock`))];
}

/**
 * Every lock folder, or none: undefined when one is held, and the ones made on the way are removed again, so two
 * processes that end at the same time never hold one each and wait for the other. A folder that cannot be made for
 * another reason (no agent folder yet) holds nothing up.
 */
function takeAll(locks: readonly string[]): string[] | undefined {
	const taken: string[] = [];
	for (const lock of locks) {
		try {
			mkdirSync(lock);
			taken.push(lock);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") continue;
			for (const mine of taken) drop(mine);
			return undefined;
		}
	}
	return taken;
}

function drop(lock: string): void {
	try {
		rmdirSync(lock);
	} catch {
		// Gone already, which leaves nothing behind either.
	}
}
