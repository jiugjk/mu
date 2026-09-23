import type { ChannelLogger } from "./logger.ts";

export interface SessionPoolOptions<T> {
	/** A session unused this long is closed (its transcript stays on disk). Default 30 minutes; 0 keeps them. */
	idleMs?: number;
	/** Most sessions open at once. Default 32. */
	maxSessions?: number;
	create(key: string): Promise<T>;
	dispose(value: T, key: string): Promise<void> | void;
	/** False while the session must stay open even though no turn holds it (e.g. a question is waiting for an answer). */
	canClose?(value: T): boolean;
	now?: () => number;
	log?: ChannelLogger;
}

/** Thrown when every open session is in use and no more may be opened. */
export class SessionPoolFullError extends Error {
	constructor(max: number) {
		super(`all ${max} sessions are busy`);
		this.name = "SessionPoolFullError";
	}
}

interface Entry<T> {
	value: T;
	lastUsed: number;
	holders: number;
	/** Opened under settings that changed since: closed as soon as it is free, and never handed out again. */
	retired?: boolean;
}

export interface Lease<T> {
	readonly value: T;
	release(): void;
}

/**
 * One open session per conversation. Opening one more than `maxSessions` first closes the session unused longest;
 * if every session is in use, the new conversation is refused rather than closing one mid-turn. A timer closes
 * sessions idle longer than `idleMs`. A closed conversation reopens from its transcript on its next message.
 */
export class SessionPool<T> {
	private readonly entries = new Map<string, Entry<T>>();
	private readonly opening = new Map<string, Promise<Entry<T>>>();
	private readonly idleMs: number;
	readonly maxSessions: number;
	private readonly options: SessionPoolOptions<T>;
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;

	constructor(options: SessionPoolOptions<T>) {
		this.options = options;
		this.idleMs = options.idleMs ?? 30 * 60_000;
		this.maxSessions = Math.max(1, options.maxSessions ?? 32);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	get size(): number {
		return this.entries.size;
	}

	keys(): string[] {
		return [...this.entries.keys()];
	}

	/** The open session for `key`, without opening one or touching its use time. */
	peek(key: string): T | undefined {
		return this.entries.get(key)?.value;
	}

	async acquire(key: string): Promise<Lease<T>> {
		if (this.closed) throw new Error("session pool is closed");
		let entry = this.entries.get(key);
		if (entry?.retired && this.closable(entry)) {
			await this.close(key);
			entry = this.entries.get(key);
		}
		if (!entry) {
			let pending = this.opening.get(key);
			if (!pending) {
				pending = this.open(key);
				this.opening.set(key, pending);
			}
			try {
				entry = await pending;
			} finally {
				this.opening.delete(key);
			}
		}
		const held = entry;
		held.holders++;
		held.lastUsed = this.now();
		let released = false;
		return {
			value: held.value,
			release: () => {
				if (released) return;
				released = true;
				held.holders--;
				held.lastUsed = this.now();
				if (held.retired && this.entries.get(key) === held && this.closable(held)) void this.close(key);
			},
		};
	}

	/**
	 * The session for `key` was opened under settings that changed (tools, model): it closes now if free, else when
	 * its turn ends, and the conversation's next message opens it again under the new settings.
	 */
	async retire(key: string): Promise<void> {
		const entry = this.entries.get(key);
		if (!entry) return;
		entry.retired = true;
		if (this.closable(entry)) await this.close(key);
	}

	private async open(key: string): Promise<Entry<T>> {
		if (this.entries.size + this.opening.size > this.maxSessions - 1) {
			const victim = this.leastRecentlyUsedClosable();
			if (!victim) throw new SessionPoolFullError(this.maxSessions);
			this.options.log?.info(`session pool full (${this.maxSessions}): closing ${victim}`);
			await this.close(victim);
		}
		const value = await this.options.create(key);
		if (this.closed) {
			// closeAll ran while this session was opening: nobody would ever close it
			await this.options.dispose(value, key);
			throw new Error("session pool is closed");
		}
		const entry: Entry<T> = { value, lastUsed: this.now(), holders: 0 };
		this.entries.set(key, entry);
		return entry;
	}

	private closable(entry: Entry<T>): boolean {
		return entry.holders === 0 && (this.options.canClose?.(entry.value) ?? true);
	}

	private leastRecentlyUsedClosable(): string | undefined {
		let found: string | undefined;
		let oldest = Number.POSITIVE_INFINITY;
		for (const [key, entry] of this.entries) {
			if (!this.closable(entry) || entry.lastUsed >= oldest) continue;
			oldest = entry.lastUsed;
			found = key;
		}
		return found;
	}

	async close(key: string): Promise<boolean> {
		const entry = this.entries.get(key);
		if (!entry) return false;
		this.entries.delete(key);
		try {
			await this.options.dispose(entry.value, key);
		} catch (error) {
			this.options.log?.warn(`closing ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return true;
	}

	/** Closes every session idle longer than `idleMs`; returns their keys. */
	async reclaimIdle(): Promise<string[]> {
		if (this.idleMs <= 0) return [];
		const cutoff = this.now() - this.idleMs;
		const idle = [...this.entries].filter(([, entry]) => entry.lastUsed <= cutoff && this.closable(entry));
		// Closing awaits each session's shutdown: one may have been taken again meanwhile.
		for (const [key, entry] of idle) {
			if (this.entries.get(key) === entry && this.closable(entry) && entry.lastUsed <= cutoff) await this.close(key);
		}
		if (idle.length > 0) this.options.log?.info(`closed ${idle.length} idle session(s)`);
		return idle.map(([key]) => key);
	}

	start(intervalMs = 60_000): void {
		if (this.timer || this.idleMs <= 0) return;
		this.timer = setInterval(() => void this.reclaimIdle(), Math.min(intervalMs, this.idleMs));
		this.timer.unref?.();
	}

	async closeAll(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await Promise.allSettled([...this.opening.values()]);
		for (const key of [...this.entries.keys()]) await this.close(key);
	}
}
