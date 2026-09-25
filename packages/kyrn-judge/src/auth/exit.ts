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
	const locks = [...new Set(files.map((file) => `${resolve(file)}.lock`))];
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
