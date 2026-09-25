import type { Activity } from '@/common/kyrn/types';
import { parseHiveSnapshot, type HiveSnapshot } from '@/common/kyrn/hive';
import { list, record, str } from '../activity';

export type HiveNote = { id: string; from: string; text: string; kind: string };
export type HiveDelivery = { id: string; from: string; to: string; text: string; noteId: string; at: number };
/** What the judge read a later note as doing to an earlier one (the harness's `relations.jsonl`). */
export type HiveRelationKind = 'supersedes' | 'contradicts' | 'supports';
export type HiveRelation = {
  id: string;
  later: string;
  earlier: string;
  relation: HiveRelationKind;
  score: number;
  by: string;
  at: number;
};
export type HiveRun = {
  id: string;
  at: number;
  snapshot?: HiveSnapshot;
  goal: string;
  assignments: { name: string; focus: string }[];
  events: Activity[];
  notes: HiveNote[];
  deliveries: HiveDelivery[];
  relations: HiveRelation[];
  gates: Activity[];
};

const RELATIONS: readonly HiveRelationKind[] = ['supersedes', 'contradicts', 'supports'];

/**
 * The runs whose turn is over: mu's turn settled, or its process closed, after the run's last word. A run that mu's
 * death cut short sends no last snapshot to say so, and its bees would read as at work for good.
 */
export function endedRuns(events: readonly Activity[]): ReadonlySet<string> {
  const last = new Map<string, number>();
  let end = -Infinity;
  for (const event of events) {
    if (event.kind === 'agent_settled' || event.kind === 'kyrn_rpc_closed') end = Math.max(end, event.at);
    else if (event.run) last.set(event.run, Math.max(last.get(event.run) ?? -Infinity, event.at));
  }
  return new Set([...last].filter(([, at]) => at <= end).map(([run]) => run));
}

/** Join within a run, never across runs with coincidentally identical bee/note names. */
export function buildHiveRuns(events: Activity[]): HiveRun[] {
  const runs = new Map<string, HiveRun>();
  for (const event of events) {
    if (
      !event.run ||
      (event.kind !== 'hive.manifest' && (event.kind !== 'swarm.snapshot' || !parseHiveSnapshot(event.payload)))
    )
      continue;
    let run = runs.get(event.run);
    if (!run) {
      run = {
        id: event.run,
        at: event.at,
        goal: '',
        assignments: [],
        events: [],
        notes: [],
        deliveries: [],
        relations: [],
        gates: [],
      };
      runs.set(event.run, run);
    }
    if (event.kind === 'hive.manifest') {
      run.goal = str(event.payload.goal);
      run.assignments = list(event.payload.bees).map((bee) => ({ name: str(bee.name), focus: str(bee.focus) }));
    } else {
      run.snapshot = parseHiveSnapshot(event.payload);
    }
  }
  for (const event of events) {
    const run = event.run ? runs.get(event.run) : undefined;
    if (!run) continue;
    run.events.push(event);
    if (event.kind === 'hive.note' && str(event.payload.id)) {
      run.notes.push({
        id: str(event.payload.id),
        from: str(event.payload.bee),
        text: str(event.payload.text),
        kind: str(event.payload.kind),
      });
    }
    if (event.kind === 'hive.gate') run.gates.push(event);
  }
  for (const run of runs.values()) {
    const notes = new Map(run.notes.map((note) => [note.id, note]));
    run.notes = [...notes.values()];
    const seen = new Set<string>();
    for (const event of run.events) {
      if (event.kind === 'hive.relation') {
        const relation = RELATIONS.find((known) => known === event.payload.relation);
        const later = str(event.payload.later);
        const earlier = str(event.payload.earlier);
        const key = JSON.stringify(['relation', later, earlier]);
        if (!relation || !later || !earlier || later === earlier || seen.has(key)) continue;
        seen.add(key);
        const score = event.payload.score;
        run.relations.push({
          id: event.id,
          later,
          earlier,
          relation,
          score: typeof score === 'number' && Number.isFinite(score) ? score : 0,
          by: str(event.payload.by),
          at: event.at,
        });
        continue;
      }
      if (event.kind !== 'hive.delivery') continue;
      const noteId = str(event.payload.note);
      const to = str(event.payload.to);
      const key = JSON.stringify([noteId, to]);
      if (!to || !noteId || seen.has(key)) continue;
      seen.add(key);
      const note = notes.get(noteId);
      // A receipt without its note remains visible, but cannot create a fabricated source edge.
      run.deliveries.push({ id: event.id, noteId, from: note?.from ?? '', to, text: note?.text ?? '', at: event.at });
    }
  }
  return [...runs.values()].toSorted((a, b) => b.at - a.at);
}

export type BeeRecord = {
  id: string;
  at: number;
  kind: 'assistant' | 'thinking' | 'user' | 'custom' | 'tool';
  text: string;
  name?: string;
  input?: string;
  complete?: boolean;
  error?: boolean;
};

function contentText(content: unknown, type = 'text'): string {
  if (typeof content === 'string') return type === 'text' ? content : '';
  return list(content)
    .filter((block) => block.type === type)
    .map((block) => str(type === 'thinking' ? block.thinking : block.text))
    .filter(Boolean)
    .join('\n\n');
}

/** Reconstruct visible transcript records, not an inferred prompt or private model state. */
export function beeRecords(events: Activity[], bee: string): BeeRecord[] {
  const result: BeeRecord[] = [];
  const tools = new Map<string, BeeRecord>();
  for (const event of events) {
    if (event.kind !== 'bee.event' || event.bee !== bee) continue;
    const p = event.payload;
    const message = record(p.message);
    const isToolMessage = p.type === 'message_end' && message.role === 'toolResult';
    if (p.type === 'tool_execution_start' || p.type === 'tool_execution_end' || isToolMessage) {
      const callId = str(isToolMessage ? message.toolCallId : p.toolCallId) || event.id;
      let entry = tools.get(callId);
      if (!entry) {
        entry = { id: event.id, at: event.at, kind: 'tool', name: str(p.toolName) || str(message.toolName), text: '' };
        tools.set(callId, entry);
        result.push(entry);
      }
      if (p.type === 'tool_execution_start') entry.input = JSON.stringify(p.args ?? {}, null, 2);
      else {
        entry.complete = true;
        entry.text = contentText(isToolMessage ? message.content : record(p.result).content);
        entry.error = (isToolMessage ? message.isError : p.isError) === true;
      }
      continue;
    }
    if (p.type !== 'message_end') continue;
    const role = str(message.role);
    if (!['assistant', 'user', 'custom'].includes(role)) continue;
    const thinking = role === 'assistant' ? contentText(message.content, 'thinking') : '';
    if (thinking) result.push({ id: `${event.id}:thinking`, at: event.at, kind: 'thinking', text: thinking });
    const text = contentText(message.content);
    if (text) result.push({ id: event.id, at: event.at, kind: role as 'assistant' | 'user' | 'custom', text });
  }
  return result;
}
