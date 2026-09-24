import { existsSync, readFileSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir } from "./paths.ts";

export type ConfigObject = Record<string, unknown>;

/**
 * mu.json, read and written by the channels. The judge reads the same file and only takes the keys it knows, so
 * `channels` sits beside them untouched. Writes replace the whole file atomically (temporary file, then rename) and
 * keep every key the channel does not own; they are serialized, so two commands never interleave.
 */
export class MuConfigFile {
	readonly path: string;
	private cached: ConfigObject | undefined;
	private cachedMtime = -1;
	private writing: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
	}

	/** The current file, parsed; `{}` when it does not exist. A file that does not parse is an error, not `{}`. */
	read(): ConfigObject {
		if (!existsSync(this.path)) return {};
		const mtime = statSync(this.path).mtimeMs;
		if (this.cached && mtime === this.cachedMtime) return this.cached;
		const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${this.path} is not a JSON object`);
		}
		this.cached = parsed as ConfigObject;
		this.cachedMtime = mtime;
		return this.cached;
	}

	/** Applies `mutator` to a deep copy of the file and writes it back. The mutator may change it in place or return a new object. */
	update(mutator: (config: ConfigObject) => unknown): Promise<void> {
		const run = async () => {
			const current = structuredClone(this.read());
			const returned = mutator(current);
			const next = returned && typeof returned === "object" ? (returned as ConfigObject) : current;
			ensureDir(dirname(this.path));
			const temporary = join(dirname(this.path), `.mu.json.${process.pid}.${Date.now()}.tmp`);
			// The file may hold an AppSecret: only its owner reads it.
			writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
			this.cached = undefined;
		};
		const result = this.writing.then(run, run);
		this.writing = result.catch(() => {});
		return result;
	}

	/** Calls `onChange` when the file changes on disk (polled, so editors that replace the file are seen). */
	watch(onChange: () => void, intervalMs = 2000): () => void {
		const listener = () => {
			this.cached = undefined;
			onChange();
		};
		watchFile(this.path, { interval: intervalMs }, listener);
		return () => unwatchFile(this.path, listener);
	}
}
