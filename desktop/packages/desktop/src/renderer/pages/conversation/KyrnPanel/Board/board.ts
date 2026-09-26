import type { Activity } from '@/common/kyrn/types';
import { record, str } from '../activity';

/**
 * The plain-language board as the panel shows it, read from the harness's presentation events of one conversation:
 * `board.switched` ({ on, cwd }) says whether the board is on for the project, when the session opens and after
 * `/board on|off`; `board.update` is the latest board, `restored` when it is the last one replayed on opening;
 * `board.note` is one line of the board's running account (what the agent did), sent the moment it happens, and every
 * `board.update` carries the last lines of that account as `log`.
 */

export const BOARD_PHASES = [
  'understanding',
  'planning',
  'changing',
  'checking',
  'fixing',
  'waiting',
  'wrapping_up',
  'stuck',
] as const;
export type BoardPhase = (typeof BOARD_PHASES)[number];

export const NOTE_KINDS = ['step', 'check', 'said', 'ticked', 'asked', 'helpers', 'goal', 'trouble', 'ended'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/**
 * One line of the board's running account: one thing the agent did, in one plain sentence. `by: 'model'` is the
 * board model's own words (the agent's words retold, a finding, what a check meant, the summing up at the end);
 * `by: 'rules'` is one of the harness's fixed sentences, named by `code`, which the app words in its own language.
 */
export type BoardNote = {
  /** `${at}:${sequence}`: a note with the identity of one already shown replaces it where it stands. */
  id: string;
  /** The harness's own counter. */
  sequence: number;
  /** When it happened, in ms since the epoch. */
  at: number;
  /** What it records; absent for a sort of note this build does not know. */
  kind?: NoteKind;
  /** The harness's sentence, in the person's language (Chinese or English). */
  text: string;
  by: 'model' | 'rules';
  /** Which fixed sentence it is (rules only). */
  code?: string;
  /** What fills the fixed sentence. */
  params?: Record<string, string | number>;
  /** Something went wrong: a failed check, a command that errored, a denied permission, trouble. */
  failed: boolean;
  /** From the account the session replays as it opens: not news. */
  restored: boolean;
};

export type BoardUpdate = {
  /** The event's own id: a new one is a new board. */
  id: string;
  progress: string;
  now: string;
  confirm: string[];
  phase?: BoardPhase;
  needsUser: boolean;
  done: number;
  total: number;
  /** Written by the model, or the harness's fixed sentences when the model did not answer. */
  by: 'model' | 'rules';
  /** Written when the agent stopped. */
  ended: boolean;
  /** The last board, shown again as the session opened: not news. */
  restored: boolean;
  /** The text of the acceptance item being worked on (the task's own words), from a harness that sends it. */
  focusText?: string;
  /**
   * One per `confirm` line of a fixed board: `waiting_reply` for the harness's "It waits for your reply", null for a
   * line quoted from the agent. A harness that sends codes sends this with every fixed board, empty when nothing
   * waits: its presence says the board can be rebuilt from its facts.
   */
  confirmCodes?: (string | null)[];
  /** The last lines of the running account, oldest first, from a harness that keeps one. */
  log?: BoardNote[];
};

export type BoardView = {
  /**
   * Whether this conversation's harness has a board at all: it said so (a switch, a board or a note). Another agent's
   * conversation, or mu with the board feature off, never does, and `/board` would reach its model as a message.
   */
  known: boolean;
  /** Whether the board is on for this project; undefined until the session has said. */
  on: boolean | undefined;
  update?: BoardUpdate;
};

/** A line the board shows is short: a longer one is cut rather than let it take the panel. */
const LINE_LIMIT = 600;
const CONFIRM_LIMIT = 8;
/** How many lines the account keeps: the oldest go first. */
export const ACCOUNT_LIMIT = 200;
/** The latest time a Date can hold. */
const TIME_LIMIT = 8.64e15;

const clip = (text: string) => (text.length > LINE_LIMIT ? `${text.slice(0, LINE_LIMIT)}…` : text);
const line = (value: unknown) => clip(str(value).trim());
/** A code is a lowercase word or words joined by underscores. */
const CODE = /^[a-z][a-z_]{0,47}$/;
/** A param is named by a word. */
const PARAM = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

export function toBoardUpdate(event: Activity): BoardUpdate | undefined {
  const payload = event.payload;
  const now = line(payload.now);
  const progress = line(payload.progress);
  if (!now && !progress) return undefined;
  const phase = BOARD_PHASES.find((known) => known === payload.phase);
  // Each line keeps its code through the filtering: the codes are the lines' own, in the same order.
  const coded = Array.isArray(payload.confirmCodes);
  const codes: unknown[] = coded ? (payload.confirmCodes as unknown[]) : [];
  const confirmed = (Array.isArray(payload.confirm) ? payload.confirm : [])
    .map((item, index) => ({ text: line(item), code: CODE.test(str(codes[index])) ? str(codes[index]) : null }))
    .filter((item) => item.text)
    .slice(0, CONFIRM_LIMIT);
  const total = count(payload.total);
  const focusText = line(payload.focusText);
  const restored = payload.restored === true;
  const log = boardLog(payload, restored);
  return {
    id: event.id,
    progress,
    now,
    confirm: confirmed.map((item) => item.text),
    ...(coded ? { confirmCodes: confirmed.map((item) => item.code) } : {}),
    ...(focusText ? { focusText } : {}),
    ...(phase ? { phase } : {}),
    needsUser: payload.needsUser === true,
    done: Math.min(count(payload.done), total),
    total,
    by: payload.by === 'rules' ? 'rules' : 'model',
    ended: payload.ended === true,
    restored,
    ...(log ? { log } : {}),
  };
}

/** What fills a fixed sentence: text (cut like a line) and numbers, by name. */
function noteParams(value: unknown): Record<string, string | number> | undefined {
  const params: Record<string, string | number> = {};
  for (const [name, item] of Object.entries(record(value))) {
    if (!PARAM.test(name)) continue;
    if (typeof item === 'string') params[name] = clip(item);
    else if (typeof item === 'number' && Number.isFinite(item)) params[name] = item;
  }
  return Object.keys(params).length ? params : undefined;
}

/** One line of the account as the harness sent it; none without its text or its time. */
function toNote(value: unknown, restored: boolean): BoardNote | undefined {
  const payload = record(value);
  const text = line(payload.text);
  const at = payload.at;
  if (!text || typeof at !== 'number' || !(at > 0 && at <= TIME_LIMIT)) return undefined;
  // Without its counter a note is known by its time alone.
  const sequence =
    Number.isSafeInteger(payload.sequence) && (payload.sequence as number) >= 0 ? (payload.sequence as number) : 0;
  const kind = NOTE_KINDS.find((known) => known === payload.kind);
  const by = payload.by === 'rules' ? 'rules' : 'model';
  const code = by === 'rules' && CODE.test(str(payload.code)) ? str(payload.code) : undefined;
  const params = noteParams(payload.params);
  return {
    id: `${at}:${sequence}`,
    sequence,
    at,
    ...(kind ? { kind } : {}),
    text,
    by,
    ...(code ? { code } : {}),
    ...(params ? { params } : {}),
    failed: payload.failed === true,
    restored,
  };
}

/** A `board.note` event as one line of the account. */
export const toBoardNote = (event: Activity): BoardNote | undefined => toNote(event.payload, false);

/** The lines of the account a board carries, oldest first; undefined when it carries none. */
function boardLog(payload: Record<string, unknown>, restored: boolean): BoardNote[] | undefined {
  if (!Array.isArray(payload.log)) return undefined;
  return (payload.log as unknown[])
    .slice(-ACCOUNT_LIMIT)
    .map((item) => toNote(item, restored))
    .filter((note): note is BoardNote => note !== undefined);
}

/** What the board says now: the last switch and the last board, in the order the session sent them. */
export function boardView(events: readonly Activity[]): BoardView {
  let on: boolean | undefined;
  let update: BoardUpdate | undefined;
  for (const event of events) {
    if (event.kind === 'board.switched' && typeof event.payload.on === 'boolean') on = event.payload.on;
    else if (event.kind === 'board.update') {
      update = toBoardUpdate(event) ?? update;
      // A harness that sends boards has the board on, even when its switch was not seen.
      on ??= true;
    } else if (event.kind === 'board.note') on ??= true;
  }
  return { known: on !== undefined, on, ...(update ? { update } : {}) };
}

/**
 * The board's running account, oldest first: every `board.note`, and the `log` of the last board that carries one
 * (on a reopened conversation, the one replayed as the session opens), one line per identity. Where two say the same
 * note the later one wins, so a note sent again (a count that grew) is replaced where it stands. The newest
 * `ACCOUNT_LIMIT` are kept.
 */
export function boardAccount(events: readonly Activity[]): BoardNote[] {
  const last = events.findLastIndex((event) => event.kind === 'board.update' && Array.isArray(event.payload.log));
  const notes = new Map<string, BoardNote>();
  events.forEach((event, index) => {
    const found =
      event.kind === 'board.note'
        ? [toBoardNote(event)]
        : index === last
          ? boardLog(event.payload, event.payload.restored === true)
          : undefined;
    for (const note of found ?? []) if (note) notes.set(note.id, note);
  });
  return [...notes.values()].toSorted((a, b) => a.at - b.at || a.sequence - b.sequence).slice(-ACCOUNT_LIMIT);
}

/**
 * The one state the board's header shows. While the agent works, its stage. Once it has stopped (`ended`), how the run
 * ended: done when it was wrapping up or every acceptance item is done, waiting when it waits for the person, and
 * stopped otherwise. A stage is never shown for a run that has stopped: "wrapping up" over a finished run misreads it.
 */
export type BoardState = { ended: false; phase: BoardPhase } | { ended: true; outcome: 'done' | 'waiting' | 'stopped' };
// Read a state's kind with `state.ended === false`: the project type-checks without strictNullChecks, where
// `!state.ended` does not narrow a state to the working one.

export function boardState(update: BoardUpdate): BoardState | undefined {
  if (!update.ended) return update.phase ? { ended: false, phase: update.phase } : undefined;
  if (update.phase === 'wrapping_up' || (update.total > 0 && update.done === update.total)) {
    return { ended: true, outcome: 'done' };
  }
  if (update.phase === 'waiting' || update.needsUser) return { ended: true, outcome: 'waiting' };
  return { ended: true, outcome: 'stopped' };
}

/** The words of a state, as a key under `common.kyrn.boardView`: a run waiting for the person reads as that stage. */
export function boardStateKey(state: BoardState): string {
  if (state.ended === false) return `phases.${state.phase}`;
  return state.outcome === 'done' ? 'done' : state.outcome === 'waiting' ? 'phases.waiting' : 'ended';
}

/** The part of the work done, from 0 to 1, when the task has acceptance items to count. */
export const share = (update: BoardUpdate) => (update.total > 0 ? update.done / update.total : undefined);

/** Whether the board asks something of the person: said so, or listed what to confirm. */
export const asksUser = (update: BoardUpdate) => update.needsUser || update.confirm.length > 0;
