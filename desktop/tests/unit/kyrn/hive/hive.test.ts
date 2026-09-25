import { describe, expect, it } from 'vitest';
import {
  parseBeeActivity,
  parseHiveSnapshot,
  parseHiveTool,
  parseSwarmProgress,
  parseSwarmSnapshot,
} from '@/common/kyrn/hive';
import { normalizeAcpToolCall } from '@/common/chat/normalizeToolCall';
import { buildHiveRuns, beeRecords } from '@/renderer/pages/conversation/KyrnPanel/Hive/activity';
import { mergeActivity } from '@/renderer/pages/conversation/KyrnPanel/activity';
import { activity, hiveEvents, hiveMessage, hiveSnapshot, relayed } from './hiveFixtures';

describe('Native Hive event projection', () => {
  it('ignores delegate and malformed snapshots instead of manufacturing bee state', () => {
    expect(parseHiveSnapshot({ kind: 'delegate', bees: [] })).toBeUndefined();
    expect(parseHiveSnapshot({ kind: 'hive', bees: null })).toBeUndefined();
    expect(
      parseHiveSnapshot({ kind: 'hive', bees: [null, {}, { name: 'a', status: 'future', turns: NaN }, { name: 'a' }] })
        ?.bees
    ).toMatchObject([{ name: 'a', status: 'unknown', turns: 0 }]);
  });

  it('retains structured Hive state and original raw evidence during ACP normalization', () => {
    const normalized = normalizeAcpToolCall(hiveMessage());
    expect(normalized?.hive?.names).toEqual(['prefix-mutations', 'provider-cache']);
    expect(normalized?.output).toBe('\u001b[32mOriginal terminal evidence\u001b[0m');
    expect(normalized?.key).toBe('run-1');
  });

  it('supports a named swarm tool before its first snapshot but not unrelated tool titles', () => {
    expect(parseHiveTool('hive', { bees: [{ name: 'a' }] }, undefined)).toMatchObject({
      kind: 'hive',
      names: ['a'],
      snapshot: undefined,
    });
    expect(parseHiveTool('delegate', { tasks: [{ title: 'a' }, { title: 'b' }] }, undefined)).toMatchObject({
      kind: 'delegate',
      names: ['a', 'b'],
      snapshot: undefined,
    });
    expect(parseHiveTool('archive-hive', {}, {})).toBeUndefined();
    expect(parseHiveTool('other', {}, { details: { snapshot: hiveSnapshot } })?.snapshot?.bees).toHaveLength(2);
    // A delegate snapshot is read as one too, whatever the tool that carried it was called.
    expect(parseHiveTool('other', {}, { details: { snapshot: { ...hiveSnapshot, kind: 'delegate' } } })).toMatchObject({
      kind: 'delegate',
    });
  });

  it('folds the relations the judge recorded, once per pair, and reads the board summary of a snapshot', () => {
    const events = [
      ...hiveEvents,
      activity('relation-repeat', 'hive.relation', { later: 'note-2', earlier: 'note-1', relation: 'supersedes' }),
      activity('relation-self', 'hive.relation', { later: 'note-2', earlier: 'note-2', relation: 'contradicts' }),
      activity('relation-odd', 'hive.relation', { later: 'note-3', earlier: 'note-1', relation: 'refutes' }),
      activity('relation-late', 'hive.relation', {
        later: 'note-3',
        earlier: 'note-2',
        relation: 'contradicts',
        score: 'x',
      }),
    ];
    expect(buildHiveRuns(events)[0].relations).toEqual([
      {
        id: 'relation',
        later: 'note-2',
        earlier: 'note-1',
        relation: 'supersedes',
        score: 0.9,
        by: 'provider-cache',
        at: 10000,
      },
      { id: 'relation-late', later: 'note-3', earlier: 'note-2', relation: 'contradicts', score: 0, by: '', at: 10000 },
    ]);
    const snapshot = parseSwarmSnapshot({
      ...hiveSnapshot,
      board: {
        latest: [
          { bee: 'prefix-mutations', to: ['provider-cache', 7], text: 'Prefix is stable.', state: 'superseded', at: 1 },
          { bee: '', to: ['provider-cache'] },
          { bee: 'provider-cache', to: 'not-a-list', text: 'Swapped key.', state: 'odd' },
        ],
      },
    });
    expect(snapshot?.latest).toEqual([
      { bee: 'prefix-mutations', to: ['provider-cache'], text: 'Prefix is stable.', state: 'superseded' },
      { bee: 'provider-cache', to: [], text: 'Swapped key.' },
    ]);
    expect(parseSwarmSnapshot(hiveSnapshot)?.latest).toEqual([]);
  });

  it('never turns a passed gate into a confirmed delivery', () => {
    const runs = buildHiveRuns(hiveEvents.filter((event) => event.kind !== 'hive.delivery'));
    expect(runs[0].gates).toHaveLength(1);
    expect(runs[0].deliveries).toEqual([]);
  });

  it('joins and deduplicates deliveries within the exact run', () => {
    const events = [
      ...hiveEvents,
      activity('snapshot-other', 'swarm.snapshot', hiveSnapshot, 'run-2'),
      activity('receipt-other', 'hive.delivery', { note: 'note-1', to: 'provider-cache' }, 'run-2'),
      activity('receipt-repeat', 'hive.delivery', { note: 'note-1', to: 'provider-cache' }),
    ];
    const runs = buildHiveRuns(events);
    expect(runs.find((run) => run.id === 'run-1')?.deliveries).toMatchObject([
      { from: 'prefix-mutations', to: 'provider-cache' },
    ]);
    expect(runs.find((run) => run.id === 'run-2')?.deliveries).toMatchObject([{ from: '', text: '' }]);
  });

  it('keeps real execution records after a final compact snapshot clears live text', () => {
    const final = {
      ...hiveSnapshot,
      endedAt: 9000,
      bees: hiveSnapshot.bees.map((bee) => ({ ...bee, status: 'done', said: '', recent: [], finals: [] })),
    };
    const run = buildHiveRuns(mergeActivity(hiveEvents, [activity('final', 'swarm.snapshot', final)]))[0];
    expect(run.snapshot?.bees.every((bee) => bee.status === 'done')).toBe(true);
    expect(beeRecords(run.events, 'provider-cache')).toMatchObject([
      { kind: 'assistant', text: 'Confirmed stable prefix.' },
    ]);
    expect(run.assignments[1].focus).toBe('Inspect provider mapping');
  });

  it('pairs tool start/output and avoids duplicating the matching toolResult message', () => {
    const events = [
      ...hiveEvents,
      activity(
        'tool-message',
        'bee.event',
        {
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: 'read-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'export const stablePrefix = true;' }],
          },
        },
        'run-1',
        'prefix-mutations'
      ),
    ];
    expect(beeRecords(events, 'prefix-mutations')).toMatchObject([
      { kind: 'tool', name: 'read', complete: true, text: 'export const stablePrefix = true;' },
    ]);
    expect(beeRecords(events, 'prefix-mutations')).toHaveLength(1);
  });

  it('never renders signatures, images, or guessed thinking as transcript text', () => {
    const events = [
      activity(
        'thinking',
        'bee.event',
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Public reasoning', thinkingSignature: 'private-signature' },
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'image', data: 'binary' },
            ],
          },
        },
        'run-1',
        'a'
      ),
    ];
    expect(beeRecords(events, 'a')).toMatchObject([{ kind: 'thinking', text: 'Public reasoning' }]);
    expect(JSON.stringify(beeRecords(events, 'a'))).not.toContain('private-signature');
    expect(beeRecords(events, 'missing')).toEqual([]);
  });

  it('does not shift assignments when an invalid snapshot row is skipped', () => {
    const snapshot = parseHiveSnapshot({ kind: 'hive', bees: [null, { name: 'second', status: 'done' }] });
    expect(snapshot?.bees[0].assignmentIndex).toBe(1);
  });

  it('does not infer assignments when an old run has no recorded manifest', () => {
    expect(buildHiveRuns(hiveEvents.filter((event) => event.kind !== 'hive.manifest'))[0].assignments).toEqual([]);
    expect(buildHiveRuns([activity('delegate', 'swarm.snapshot', { ...hiveSnapshot, kind: 'delegate' })])).toEqual([]);
  });

  it('keeps the codes beside the English of a snapshot, typed, for translation at render time', () => {
    const snapshot = parseSwarmSnapshot({
      kind: 'delegate',
      title: '2 tasks',
      titleCode: { code: 'delegate_tasks', params: { count: 2, junk: { nested: true } } },
      bees: [
        {
          name: 'scan',
          status: 'timed-out',
          error: 'time budget of 10 min reached; no report within 90s of being asked',
          errorCode: 'no_report_in_time',
          errorParams: { seconds: 90, after: 'time_budget' },
          wrapUp: { at: 5, reason: 'time budget of 10 min reached', code: 'time_budget', params: { minutes: 10 } },
          recent: [
            { at: 3, text: '← 2 notes from the others', code: 'notes_received', params: { count: 2 } },
            { at: 4, text: 'bash npm test' },
            null,
            { at: 5 },
          ],
        },
        { name: 'fix', status: 'queued' },
      ],
    });
    expect(snapshot).toMatchObject({
      kind: 'delegate',
      title: '2 tasks',
      titleCode: { code: 'delegate_tasks', params: { count: 2 } },
    });
    expect(snapshot?.titleCode?.params).not.toHaveProperty('junk');
    expect(snapshot?.bees[0]).toMatchObject({
      errorCode: 'no_report_in_time',
      errorParams: { seconds: 90, after: 'time_budget' },
      wrapUp: { reason: 'time budget of 10 min reached', code: 'time_budget', params: { minutes: 10 } },
      recent: [
        { at: 3, text: '← 2 notes from the others', code: 'notes_received', params: { count: 2 } },
        { at: 4, text: 'bash npm test', params: {} },
      ],
    });
    // An older snapshot carries no codes: the fields are simply absent.
    expect(snapshot?.bees[1]).toMatchObject({ error: '', errorParams: {}, recent: [] });
    expect(snapshot?.bees[1].errorCode).toBeUndefined();
    expect(snapshot?.bees[1].wrapUp).toBeUndefined();
    expect(parseSwarmSnapshot({ kind: 'future', bees: [] })).toBeUndefined();
    expect(parseHiveSnapshot({ ...hiveSnapshot, titleCode: { code: 'x' } })?.titleCode).toEqual({
      code: 'x',
      params: {},
    });
    expect(parseBeeActivity('not a list')).toEqual([]);
  });

  it('reads a snapshot the relay snake_cased on its way to the transcript', () => {
    const output = relayed({
      details: {
        snapshot: {
          kind: 'delegate',
          title: '2 tasks',
          titleCode: { code: 'delegate_tasks', params: { count: 2 } },
          startedAt: 1000,
          endedAt: 9000,
          bees: [
            {
              name: 'scan',
              status: 'failed',
              turns: 5,
              toolCalls: 25,
              toolErrors: 1,
              quietMs: 4000,
              error: 'the model request kept failing',
              errorCode: 'retries_exhausted',
              errorParams: { message: 'overloaded', stopReason: 'error' },
              wrapUp: { at: 5, reason: 'time budget of 10 min reached', code: 'time_budget', params: { minutes: 10 } },
              recent: [
                {
                  at: 3,
                  text: 'retry 1/3: overloaded',
                  code: 'retry',
                  params: { attempt: 1, maxAttempts: 3, message: 'overloaded' },
                },
              ],
            },
          ],
        },
      },
    });
    // What arrives: `title_code`, `tool_calls`, `max_attempts`.
    expect(JSON.stringify(output)).toContain('"title_code"');
    const message = hiveMessage();
    const update = message.content.update as Record<string, unknown>;
    update.title = 'delegate';
    delete update.rawOutput;
    update.raw_output = output;
    const snapshot = normalizeAcpToolCall(message)?.hive?.snapshot;
    expect(snapshot).toMatchObject({
      titleCode: { code: 'delegate_tasks', params: { count: 2 } },
      startedAt: 1000,
      endedAt: 9000,
    });
    expect(snapshot?.bees[0]).toMatchObject({
      turns: 5,
      toolCalls: 25,
      toolErrors: 1,
      quietMs: 4000,
      errorCode: 'retries_exhausted',
      errorParams: { message: 'overloaded', stopReason: 'error' },
      wrapUp: { code: 'time_budget', params: { minutes: 10 } },
      recent: [{ code: 'retry', params: { attempt: 1, maxAttempts: 3, message: 'overloaded' } }],
    });
  });

  it('reads the routing step before the first snapshot, and nothing once there is one', () => {
    const choosing = { details: { code: 'choosing_roles', params: { count: 3 } } };
    expect(parseSwarmProgress(choosing)).toEqual({ code: 'choosing_roles', params: { count: 3 } });
    expect(parseSwarmProgress({ details: { snapshot: hiveSnapshot } })).toBeUndefined();
    expect(parseSwarmProgress({ details: { code: 'done' } })).toBeUndefined();
    expect(parseSwarmProgress(undefined)).toBeUndefined();
    const message = hiveMessage();
    message.content.update.title = 'delegate';
    message.content.update.rawInput = { tasks: [{ title: 'scout' }, { title: 'build' }] };
    message.content.update.rawOutput = choosing;
    const normalized = normalizeAcpToolCall(message);
    expect(normalized?.swarmProgress).toEqual({ code: 'choosing_roles', params: { count: 3 } });
    // A delegate call is a sub-agent run from the start: the tasks it asked for name its sub-agents.
    expect(normalized?.hive).toMatchObject({ kind: 'delegate', names: ['scout', 'build'], snapshot: undefined });
    // The English output stays the raw evidence it was.
    expect(normalized?.output).toBe('\u001b[32mOriginal terminal evidence\u001b[0m');
  });
});
