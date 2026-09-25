import type { TFunction } from 'i18next';
import type { Activity } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import { isTurnType } from '@/renderer/pages/conversation/Messages/acp/jevLine';
import { record, str } from '../activity';
import { judgeCards, LESSON_FIELDS, runtimeEvents, type JudgeCard } from './activity';
import { eventLines } from './eventLine';

/**
 * The judge tab as a log: one line per judgment and per runtime event, oldest first, so the newest is at the bottom
 * where the eye follows it. A judgment is one line however many records it took (a preflight's wait, verdict and
 * ledger entry fold into one), and each line says what happened in a short sentence of the app language.
 */

export type LogItem =
  | { type: 'judgment'; id: string; at: number; card: JudgeCard }
  | { type: 'event'; id: string; at: number; event: Activity };

/**
 * Kinds another tab shows (the board, and the cache ring above it), or the context line above the log: the log leaves
 * them out.
 */
const SHOWN_ELSEWHERE = new Set(['board.update', 'board.note', 'context.usage', 'context.policy', 'turn.usage']);

/** A harness frame is known by its runtime and its number there; a record the app made, by its own id. */
const identity = (event: Activity): string =>
  event.runtimeId && event.sequence !== undefined ? JSON.stringify([event.runtimeId, event.sequence]) : event.id;

type StateReport = { about: string; state: string };

/**
 * Reports of how things stand. The harness sends each one whenever it starts, which is every time the conversation
 * is opened, and again when the state changes. A server's start and its failures report one state: running with
 * these tools, or failed for this reason. The task frame comes back as `restored` at every start: only a frame that
 * reads differently is an update.
 */
const STATE_REPORTS: Readonly<Record<string, (payload: Record<string, unknown>) => StateReport>> = {
  'frame.updated': (payload) => ({
    about: 'frame',
    state: JSON.stringify([payload.frame, payload.openQuestionCodes, payload.stale, payload.unmerged]),
  }),
  'permissions.mode': (payload) => ({ about: 'permissions', state: str(payload.mode) || str(payload.label) }),
  'board.switched': (payload) => ({ about: 'board', state: String(payload.on) }),
  'inherit.found': (payload) => ({
    about: 'inherit',
    state: JSON.stringify([payload.rules, payload.skills, payload.servers, payload.problems]),
  }),
  'mcp.started': (payload) => ({
    about: `mcp:${str(payload.id) || str(payload.name)}`,
    state: JSON.stringify(['started', payload.tools ?? null]),
  }),
  'mcp.failed': (payload) => ({
    about: `mcp:${str(payload.id) || str(payload.name)}`,
    state: JSON.stringify(['failed', str(payload.code) || str(payload.reason)]),
  }),
};

/** A state report whose state is the one last reported about the same thing tells nothing new. */
function changes(events: readonly Activity[]): Activity[] {
  const states = new Map<string, string>();
  return events.filter((event) => {
    const report = STATE_REPORTS[event.kind]?.(event.payload);
    if (!report) return true;
    if (states.get(report.about) === report.state) return false;
    states.set(report.about, report.state);
    return true;
  });
}

/**
 * Each record once, and a state report only when it changed something: reopening a conversation adds no lines, and
 * a switch still gets its line.
 */
export function logItems(events: Activity[]): LogItem[] {
  const seen = new Set<string>();
  const once = events.filter((event) => {
    const key = identity(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const judgments = judgeCards(once).map(
    (card): LogItem => ({ type: 'judgment', id: `judgment:${card.id}`, at: card.at, card })
  );
  const listed = new Set(runtimeEvents(once));
  const others = changes(once)
    .filter((event) => (listed.has(event) || event.kind === 'artifact.image') && !SHOWN_ELSEWHERE.has(event.kind))
    .map((event): LogItem => ({ type: 'event', id: `event:${event.id}`, at: event.at, event }));
  // A stable sort: records of the same moment keep the order they came in.
  return [...others, ...judgments].toSorted((a, b) => a.at - b.at);
}

/** Whether the agent is working on a turn: it started one and has not settled since. */
export function turnRunning(events: readonly Activity[]): boolean {
  for (let index = events.length - 1; index >= 0; index--) {
    const kind = events[index].kind;
    if (kind === 'agent_start') return true;
    if (kind === 'agent_settled' || kind === 'kyrn_rpc_closed') return false;
  }
  return false;
}

/** The verdict on the message being worked on: kept in view while its turn runs, or while it is still being made. */
export function pinnedVerdict(items: readonly LogItem[], running: boolean): JudgeCard | undefined {
  const latest = items.findLast((item) => item.type === 'judgment' && item.card.stage === 'preflight');
  const card = latest?.type === 'judgment' ? latest.card : undefined;
  return card && (running || card.state === 'pending') ? card : undefined;
}

/** The code a line shows: the decision point a judgment answered, or the kind of a runtime event. */
export const itemCode = (item: LogItem): string => (item.type === 'judgment' ? item.card.specId : item.event.kind);

/** A classification in the words the conversation uses for it ("Classified by Jev: Multi-step task"). */
function verdictSentence(t: TFunction, card: JudgeCard): string {
  if (card.state === 'pending') return t('common.kyrn.jevLine.classifying');
  if (card.state === 'fallback') return t('common.kyrn.jevLine.fallback');
  if (card.state === 'ended') return t('common.kyrn.event.preflight.wait_end');
  const turnType = str(record(card.outcome).turnType);
  const type = t(`common.kyrn.judgeView.values.${isTurnType(turnType) ? turnType : 'other'}`);
  const said = t(card.state === 'rule' ? 'common.kyrn.jevLine.byRule' : 'common.kyrn.jevLine.classified', { type });
  if (card.state === 'shadow') return t('common.kyrn.jevLine.shadow', { line: said });
  if (card.state === 'late') return t('common.kyrn.jevLine.late', { line: said });
  return said;
}

/** What one line says: a judgment by its question and what became of it, an event by its coded words. */
export function itemSentence(t: TFunction, item: LogItem, language?: string | null): string {
  if (item.type === 'judgment') {
    const card = item.card;
    if (card.stage === 'preflight') return verdictSentence(t, card);
    const route = card.route ? [card.route.from, card.route.to].filter(Boolean).join(' → ') : '';
    return [route, t(`common.kyrn.judgeView.questions.${card.stage}`), t(`common.kyrn.judgeView.state.${card.state}`)]
      .filter(Boolean)
      .join(' · ');
  }
  const { kind, payload } = item.event;
  const lines = eventLines(t, kind, payload, language);
  if (lines?.length) return lines.join(' · ');
  const label = t(`common.kyrn.event.${kind}`, { defaultValue: kind });
  const text = str(payload.text) || str(payload.lesson) || str(payload.head) || str(payload.step);
  const score =
    typeof payload.score === 'number' && Number.isFinite(payload.score)
      ? formatNumber(payload.score, language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';
  return [label, text, score].filter(Boolean).join(' · ');
}

/** Events that name lessons by id: the lessons brought into a turn, and the ones it followed. */
const NAMES_LESSONS: ReadonlySet<string> = new Set(['memory.recalled', 'memory.applied']);

/** Whether a line names lessons by id, so that the log needs their words (`lessonText`) to say which. */
export const namesLessons = (item: LogItem): boolean =>
  item.type === 'judgment' ? LESSON_FIELDS[item.card.stage] !== undefined : NAMES_LESSONS.has(item.event.kind);

/**
 * Every line of an event, for its opened view: the coded words, or the text it carried. An event that names lessons
 * lists them by their words (`lessonText`), one line each.
 */
export function eventDetail(
  t: TFunction,
  event: Activity,
  language?: string | null,
  lessonText?: (id: string) => string
): string[] {
  const lines = eventLines(t, event.kind, event.payload, language);
  if (lines?.length) return lines;
  if (lessonText && NAMES_LESSONS.has(event.kind) && Array.isArray(event.payload.ids)) {
    const named = event.payload.ids.filter((id): id is string => typeof id === 'string' && id !== '').map(lessonText);
    if (named.length) return named;
  }
  const text = str(event.payload.text) || str(event.payload.lesson) || str(event.payload.head);
  return text ? [text] : [];
}
