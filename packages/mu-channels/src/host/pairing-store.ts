import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Direct-message pairing for chat channels: a stranger who writes to the bot gets a code; the owner approves the
 * code and the stranger's id joins the account's allow list. The rules follow OpenClaw's pairing store, which the
 * QQ Bot channel was written against: 8-character codes from an alphabet without look-alikes, a request expires
 * after an hour, at most 3 pending requests per account, writing again keeps the same code.
 */
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_PENDING_TTL_MS = 60 * 60_000;
export const PAIRING_MAX_PENDING = 3;

export interface PairingRequest {
	id: string;
	code: string;
	accountId: string;
	createdAt: number;
	lastSeenAt: number;
}

interface PairingState {
	requests: PairingRequest[];
	allowFrom: Record<string, string[]>;
}

export class PairingStore {
	private readonly file: string;
	private readonly now: () => number;

	constructor(file: string, now: () => number = Date.now) {
		this.file = file;
		this.now = now;
	}

	private read(): PairingState {
		if (!existsSync(this.file)) return { requests: [], allowFrom: {} };
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PairingState>;
			return {
				requests: Array.isArray(parsed.requests) ? parsed.requests : [],
				allowFrom: parsed.allowFrom && typeof parsed.allowFrom === "object" ? parsed.allowFrom : {},
			};
		} catch {
			return { requests: [], allowFrom: {} };
		}
	}

	private write(state: PairingState): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temporary, this.file);
	}

	private live(requests: PairingRequest[]): PairingRequest[] {
		const now = this.now();
		return requests.filter((request) => now - request.createdAt <= PAIRING_PENDING_TTL_MS);
	}

	/** Ids approved for `accountId`. */
	readAllowFrom(accountId: string): string[] {
		return [...(this.read().allowFrom[accountId] ?? [])];
	}

	listRequests(accountId?: string): PairingRequest[] {
		return this.live(this.read().requests).filter((request) => !accountId || request.accountId === accountId);
	}

	/**
	 * The code for `id` on `accountId`: the pending one if it asked before, a new one otherwise. `code` is "" when
	 * the account already has PAIRING_MAX_PENDING other requests waiting.
	 */
	upsertRequest(params: { id: string; accountId: string }): { code: string; created: boolean } {
		const state = this.read();
		const now = this.now();
		state.requests = this.live(state.requests);
		const existing = state.requests.find((r) => r.id === params.id && r.accountId === params.accountId);
		if (existing) {
			existing.lastSeenAt = now;
			this.write(state);
			return { code: existing.code, created: false };
		}
		if (state.requests.filter((r) => r.accountId === params.accountId).length >= PAIRING_MAX_PENDING) {
			this.write(state);
			return { code: "", created: false };
		}
		const taken = new Set(state.requests.map((r) => r.code));
		let code = "";
		for (let attempt = 0; attempt < 500 && (!code || taken.has(code)); attempt++) {
			code = "";
			for (let i = 0; i < PAIRING_CODE_LENGTH; i++)
				code += PAIRING_CODE_ALPHABET[randomInt(0, PAIRING_CODE_ALPHABET.length)];
		}
		state.requests.push({ id: params.id, code, accountId: params.accountId, createdAt: now, lastSeenAt: now });
		this.write(state);
		return { code, created: true };
	}

	/** Approves a pending code (any account when `accountId` is omitted, as OpenClaw did). Null when unknown or expired. */
	approveCode(code: string, accountId?: string): { id: string; accountId: string } | null {
		const wanted = code.trim().toUpperCase();
		if (!wanted) return null;
		const state = this.read();
		state.requests = this.live(state.requests);
		const index = state.requests.findIndex(
			(r) => r.code.toUpperCase() === wanted && (!accountId || r.accountId === accountId),
		);
		if (index < 0) {
			this.write(state);
			return null;
		}
		const [request] = state.requests.splice(index, 1);
		const allow = state.allowFrom[request.accountId] ?? [];
		if (!allow.includes(request.id)) state.allowFrom[request.accountId] = [...allow, request.id];
		this.write(state);
		return { id: request.id, accountId: request.accountId };
	}
}
