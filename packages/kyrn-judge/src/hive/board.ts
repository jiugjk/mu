import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

/**
 * The hive's shared board: an append-only file every bee can write to and
 * read from. Bees never talk to each other directly; what one of them found
 * reaches the others only through here, and only after the judge let it.
 */
export type NoteKind = "finding" | "dead_end" | "decision" | "blocker";

export interface Note {
	readonly id: string;
	/** Who posted it. */
	readonly bee: string;
	readonly kind: NoteKind;
	/** The judge's probability that others need this. */
	readonly score: number;
	/** Word for word what the bee said or saw. Nothing is paraphrased on the way. */
	readonly text: string;
	/** Where it came from: "said", or the tool call that produced it. */
	readonly source: string;
	readonly at: string;
}

export interface Delivery {
	readonly note: string;
	readonly to: string;
	readonly score: number;
}

/**
 * What a later note does to an earlier one, as the judge read it. The board
 * only ever grows, so a conclusion that stopped being true would otherwise
 * stay on it as if it still held; these rows are how it is read with its
 * corrections (see `foldRelations`).
 */
export type Relation = "supersedes" | "contradicts" | "supports";

export interface RelationRow {
	readonly later: string;
	readonly earlier: string;
	readonly relation: Relation;
	/** The judge's probability of this reading. */
	readonly score: number;
	/** The bee that posted `later`, whose judge asked. */
	readonly by: string;
	readonly at: string;
}

const BOARD = "board.jsonl";
const DELIVERIES = "deliveries.jsonl";
const RELATIONS = "relations.jsonl";

function parseLines<T>(text: string): T[] {
	const rows: T[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as T);
		} catch {
			// A torn line from a concurrent writer is skipped, not fatal.
		}
	}
	return rows;
}

/** Reads what was appended since `offset`, up to the last complete line. */
function readFrom<T>(path: string, offset: number): { rows: T[]; offset: number } {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return { rows: [], offset };
	}
	try {
		const size = fstatSync(fd).size;
		if (size <= offset) return { rows: [], offset };
		const buffer = Buffer.alloc(size - offset);
		readSync(fd, buffer, 0, buffer.length, offset);
		const text = buffer.toString("utf8");
		const complete = text.lastIndexOf("\n") + 1;
		return {
			rows: parseLines<T>(text.slice(0, complete)),
			offset: offset + Buffer.byteLength(text.slice(0, complete)),
		};
	} finally {
		closeSync(fd);
	}
}

export class Board {
	readonly dir: string;
	private offset = 0;

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
	}

	post(note: Note): void {
		appendFileSync(join(this.dir, BOARD), `${JSON.stringify(note)}\n`);
	}

	/** Notes appended since the last call on this instance. */
	fresh(): Note[] {
		const read = readFrom<Note>(join(this.dir, BOARD), this.offset);
		this.offset = read.offset;
		return read.rows;
	}

	all(): Note[] {
		return readFrom<Note>(join(this.dir, BOARD), 0).rows;
	}

	delivered(delivery: Delivery): void {
		appendFileSync(join(this.dir, DELIVERIES), `${JSON.stringify(delivery)}\n`);
	}

	/** Every verdict of the gates, passed or not: the answer to "why did nobody hear about this?". */
	log(entry: Readonly<Record<string, unknown>>): void {
		appendFileSync(join(this.dir, "gate.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
	}

	deliveries(): Delivery[] {
		return readFrom<Delivery>(join(this.dir, DELIVERIES), 0).rows;
	}

	relate(row: RelationRow): void {
		appendFileSync(join(this.dir, RELATIONS), `${JSON.stringify(row)}\n`);
	}

	relations(): RelationRow[] {
		return readFrom<RelationRow>(join(this.dir, RELATIONS), 0).rows;
	}

	private relationOffset = 0;

	/** Relations appended since the last call on this instance. */
	freshRelations(): RelationRow[] {
		const read = readFrom<RelationRow>(join(this.dir, RELATIONS), this.relationOffset);
		this.relationOffset = read.offset;
		return read.rows;
	}

	private gateOffset = 0;
	private gateRows = 0;

	/** How many verdicts the gates have given so far. Counted incrementally: the log only grows. */
	judged(): number {
		const read = readFrom<unknown>(join(this.dir, "gate.jsonl"), this.gateOffset);
		this.gateOffset = read.offset;
		this.gateRows += read.rows.length;
		return this.gateRows;
	}
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []);

/**
 * The earlier notes a new one may be speaking about: those it shares enough
 * words with to be worth one question each, the closest first. A rule before
 * the judge, so a board of thirty notes does not cost thirty questions.
 */
export function overlapping<T extends Pick<Note, "text">>(
	text: string,
	notes: readonly T[],
	options: { min?: number; shared?: number; limit?: number } = {},
): T[] {
	const { min = 0.15, shared: atLeast = 2, limit = 6 } = options;
	const mine = words(text);
	if (mine.size === 0) return [];
	const scored: { note: T; overlap: number }[] = [];
	for (const note of notes) {
		const theirs = words(note.text);
		if (theirs.size === 0) continue;
		let shared = 0;
		for (const word of mine) if (theirs.has(word)) shared++;
		const overlap = shared / Math.min(mine.size, theirs.size);
		if (shared >= atLeast && overlap >= min) scored.push({ note, overlap });
	}
	return scored
		.sort((a, b) => b.overlap - a.overlap)
		.slice(0, limit)
		.map((entry) => entry.note);
}

/** The board read with its corrections. */
export interface BoardState {
	/** Notes nothing has replaced, in board order. */
	readonly current: Note[];
	/** Replaced note id → the row that replaced it. */
	readonly superseded: ReadonlyMap<string, RelationRow>;
	/** Note id → the rows disputing it, while both sides still stand. */
	readonly contested: ReadonlyMap<string, RelationRow[]>;
	/**
	 * Note id → the other investigators whose later notes confirmed it, each named once. A bee that says the
	 * same thing twice, or builds on what it said before, has not been confirmed by anyone.
	 */
	readonly supported: ReadonlyMap<string, readonly string[]>;
}

/**
 * What stands, what was replaced by what, and what is in dispute. A replaced
 * note is out; a dispute one side of which was since replaced is over; a
 * dispute nobody settled keeps both sides, because a judge does not get to
 * vote on which of two workers is right.
 */
export function foldRelations(notes: readonly Note[], relations: readonly RelationRow[]): BoardState {
	const ids = new Set(notes.map((note) => note.id));
	const known = relations.filter((row) => ids.has(row.earlier) && ids.has(row.later));
	const beeOf = new Map(notes.map((note) => [note.id, note.bee]));
	const superseded = new Map<string, RelationRow>();
	const supported = new Map<string, string[]>();
	for (const row of known) {
		if (row.relation === "supersedes") superseded.set(row.earlier, row);
		else if (row.relation === "supports") {
			const by = beeOf.get(row.later) ?? row.by;
			const named = supported.get(row.earlier) ?? [];
			if (by !== beeOf.get(row.earlier) && !named.includes(by)) supported.set(row.earlier, [...named, by]);
		}
	}
	const contested = new Map<string, RelationRow[]>();
	for (const row of known) {
		if (row.relation !== "contradicts" || superseded.has(row.earlier) || superseded.has(row.later)) continue;
		for (const id of [row.earlier, row.later]) contested.set(id, [...(contested.get(id) ?? []), row]);
	}
	return { current: notes.filter((note) => !superseded.has(note.id)), superseded, contested, supported };
}

/** Rules before the judge: a note that says what the board already says is not news. */
export function isDuplicate(text: string, notes: readonly Pick<Note, "text">[], overlap = 0.8): boolean {
	const mine = words(text);
	if (mine.size === 0) return true;
	return notes.some((note) => {
		const theirs = words(note.text);
		let shared = 0;
		for (const word of mine) if (theirs.has(word)) shared++;
		return shared / mine.size >= overlap;
	});
}
