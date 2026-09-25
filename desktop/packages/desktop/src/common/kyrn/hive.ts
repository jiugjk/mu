const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const isRecord = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
/**
 * A field of a tool's output, by the harness's name for it. The relay snake_cases every key of a tool call's output,
 * in what it streams to the window and in what it stores (`titleCode` arrives as `title_code`); activity records keep
 * the harness's own names.
 */
const field = (row: Record<string, unknown>, key: string): unknown =>
  row[key] ?? row[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];

/** What a presentation code names (a count, a tool, a message): only strings and finite numbers are kept. */
export type CodeParams = Readonly<Record<string, string | number>>;
/** A sentence of the harness as a stable code and its params; the English next to it is the fallback. */
export type Coded = { code: string; params: CodeParams };

/** The params under the harness's own names: a relayed `max_attempts` is its `maxAttempts` again. */
export function parseParams(value: unknown): CodeParams {
  const params: Record<string, string | number> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) {
      params[key.replace(/_([a-z0-9])/g, (_, next: string) => next.toUpperCase())] = item;
    }
  }
  return params;
}

/** `{ code, params? }`, or undefined when there is no code to translate by. */
export function parseCoded(value: unknown): Coded | undefined {
  const row = record(value);
  const code = text(row.code);
  return code ? { code, params: parseParams(row.params) } : undefined;
}

/** One line of a bee's activity log; `code` is absent in sessions recorded before the harness wrote codes. */
export type BeeActivity = { at: number; text: string; code?: string; params: CodeParams };
/** A wrap-up that was requested: `reason` is the harness's English, `code` the same as a code. */
export type BeeWrapUp = { at: number; reason: string; code?: string; params: CodeParams };
/** Why a bee ended (`error`, in English) and the same as a code, plus the wrap-up it may have been asked for. */
export type BeeErrorState = { error: string; errorCode?: string; errorParams: CodeParams; wrapUp?: BeeWrapUp };

export function parseBeeActivity(value: unknown): BeeActivity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): BeeActivity[] => {
    const row = record(item);
    const line = text(row.text);
    const code = text(row.code);
    if (!line && !code) return [];
    return [{ at: number(row.at), text: line, ...(code ? { code } : {}), params: parseParams(row.params) }];
  });
}

export function parseBeeError(value: unknown): BeeErrorState {
  const bee = record(value);
  const errorCode = text(field(bee, 'errorCode'));
  const wrapUp = record(field(bee, 'wrapUp'));
  const wrapUpCode = text(wrapUp.code);
  return {
    error: text(bee.error),
    ...(errorCode ? { errorCode } : {}),
    errorParams: parseParams(field(bee, 'errorParams')),
    ...(isRecord(field(bee, 'wrapUp'))
      ? {
          wrapUp: {
            at: number(wrapUp.at),
            reason: text(wrapUp.reason),
            ...(wrapUpCode ? { code: wrapUpCode } : {}),
            params: parseParams(wrapUp.params),
          },
        }
      : {}),
  };
}

const BEE_STATUSES = [
  'queued',
  'starting',
  'thinking',
  'tool',
  'retrying',
  'wrapping-up',
  'done',
  'failed',
  'stopped',
  'timed-out',
] as const;
export type HiveBeeStatus = (typeof BEE_STATUSES)[number] | 'unknown';
export type HiveBee = BeeErrorState & {
  name: string;
  assignmentIndex: number;
  status: HiveBeeStatus;
  role: string;
  model: string;
  thinking: string;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  published: number;
  received: number;
  said: string;
  quietMs: number;
  tool?: { name: string; summary: string };
  /** The last few things it did, newest last. Empty in a final (compact) snapshot. */
  recent: BeeActivity[];
};
export type SwarmKind = 'hive' | 'delegate';
/** A run's title. A delegate run's is mu's own words and has `titleCode`; a hive's is its goal, shown as it is. */
export type SwarmTitle = { title: string; titleCode?: Coded };
/** One of the board's latest notes as the harness sums them up: who posted it, whom the judge handed it to. */
export type HiveBoardLine = { bee: string; to: string[]; text: string; state?: 'superseded' | 'contested' };
export type HiveSnapshot = SwarmTitle & {
  kind: SwarmKind;
  bees: HiveBee[];
  startedAt: number;
  endedAt: number;
  now: number;
  /** The board's last few notes (the harness keeps 8), oldest first; empty for a delegate run. */
  latest: HiveBoardLine[];
};
export type HiveToolData = { kind: SwarmKind; goal: string; names: string[]; snapshot?: HiveSnapshot };

export function parseSwarmTitle(value: unknown): SwarmTitle {
  const row = record(value);
  const titleCode = parseCoded(field(row, 'titleCode'));
  return { title: text(row.title), ...(titleCode ? { titleCode } : {}) };
}

/** Decode only display fields of a hive or delegate snapshot; paths and arbitrary tool metadata never reach the view. */
export function parseSwarmSnapshot(value: unknown): HiveSnapshot | undefined {
  const row = record(value);
  const kind: SwarmKind | undefined = row.kind === 'hive' || row.kind === 'delegate' ? row.kind : undefined;
  if (!kind || !Array.isArray(row.bees)) return undefined;
  const names = new Set<string>();
  const bees = row.bees.flatMap((item, assignmentIndex): HiveBee[] => {
    const bee = record(item);
    const name = text(bee.name);
    if (!name || names.has(name)) return [];
    names.add(name);
    const tool = record(bee.tool);
    const status = text(bee.status);
    return [
      {
        name,
        assignmentIndex,
        status: BEE_STATUSES.find((known) => known === status) ?? 'unknown',
        role: text(bee.role),
        model: text(bee.model),
        thinking: text(bee.thinking),
        turns: number(bee.turns),
        toolCalls: number(field(bee, 'toolCalls')),
        toolErrors: number(field(bee, 'toolErrors')),
        published: number(bee.published),
        received: number(bee.received),
        said: text(bee.said),
        ...parseBeeError(bee),
        quietMs: number(field(bee, 'quietMs')),
        tool: text(tool.name) ? { name: text(tool.name), summary: text(tool.summary) } : undefined,
        recent: parseBeeActivity(bee.recent),
      },
    ];
  });
  return {
    kind,
    ...parseSwarmTitle(row),
    bees,
    startedAt: number(field(row, 'startedAt')),
    endedAt: number(field(row, 'endedAt')),
    now: number(row.now),
    latest: parseBoardLines(record(row.board).latest),
  };
}

/** The board summary's latest notes: only their author, receivers, words and state; never a path or a score. */
function parseBoardLines(value: unknown): HiveBoardLine[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-16).flatMap((item): HiveBoardLine[] => {
    const row = record(item);
    const bee = text(row.bee);
    if (!bee) return [];
    const to = Array.isArray(row.to) ? row.to.slice(0, 32).map(text).filter(Boolean) : [];
    const state = row.state === 'superseded' || row.state === 'contested' ? row.state : undefined;
    return [{ bee, to, text: text(row.text), ...(state ? { state } : {}) }];
  });
}

/** A hive's snapshot only: a delegate run is drawn by the panel's own list, not as a hive. */
export function parseHiveSnapshot(value: unknown): HiveSnapshot | undefined {
  return record(value).kind === 'hive' ? parseSwarmSnapshot(value) : undefined;
}

/** The tools that run sub-agents. Both are shown as a list of their sub-agents, never as their raw payload. */
const SWARM_TOOLS: ReadonlyMap<string, SwarmKind> = new Map<string, SwarmKind>([
  ['hive', 'hive'],
  ['delegate', 'delegate'],
]);

/** The sub-agents a call asked for, before its first snapshot: a hive names its bees, a delegate titles its tasks. */
function askedNames(args: Record<string, unknown>): string[] {
  const listed = Array.isArray(args.bees) ? args.bees : Array.isArray(args.tasks) ? args.tasks : [];
  return listed.map((item) => text(record(item).name) || text(record(item).title)).filter(Boolean);
}

/** Keep structured swarm data alongside the unchanged generic input/output evidence. */
export function parseHiveTool(title: string, input: unknown, output: unknown): HiveToolData | undefined {
  const snapshot = parseSwarmSnapshot(record(record(output).details).snapshot);
  const asked = SWARM_TOOLS.get(title);
  if (!snapshot && !asked) return undefined;
  const args = record(input);
  return {
    kind: snapshot?.kind ?? asked ?? 'hive',
    snapshot,
    goal: text(args.goal) || snapshot?.title || '',
    names: snapshot?.bees.map((bee) => bee.name) ?? askedNames(args),
  };
}

const SWARM_PROGRESS_CODES = new Set(['choosing_roles']);

/**
 * What the delegate and hive tools say before their first snapshot, as a code:
 * `details: { code: 'choosing_roles', params: { count } }` next to the English partial output.
 */
export function parseSwarmProgress(output: unknown): Coded | undefined {
  const details = record(record(output).details);
  if (details.snapshot !== undefined) return undefined;
  const coded = parseCoded(details);
  return coded && SWARM_PROGRESS_CODES.has(coded.code) ? coded : undefined;
}

export function isBeeActive(status: HiveBeeStatus): boolean {
  return ['starting', 'thinking', 'tool', 'retrying', 'wrapping-up'].includes(status);
}
