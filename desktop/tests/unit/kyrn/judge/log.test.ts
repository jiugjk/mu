import { describe, expect, it } from 'vitest';
import type { Activity } from '@/common/kyrn/types';
import { logItems, namesLessons } from '@/renderer/pages/conversation/KyrnPanel/Judge/log';

let sequence = 0;
const event = (kind: string, payload: Record<string, unknown> = {}): Activity => ({
  id: `${kind}:${++sequence}`,
  at: sequence,
  kind,
  payload,
  runtimeId: 'runtime',
  sequence,
});

describe('the judge log', () => {
  it('leaves the board to the board tab: neither its boards nor the lines of its account are listed', () => {
    const items = logItems([
      event('board.update', { now: 'Changing the code.', progress: 'Halfway.' }),
      event('board.note', { sequence: 1, at: 1, kind: 'step', text: 'Changed src/a.ts', by: 'rules' }),
      event('goal.state', { status: 'active' }),
    ]);
    expect(items.map((item) => (item.type === 'event' ? item.event.kind : item.type))).toEqual(['goal.state']);
  });

  it('lists a task frame restored as the conversation opens again only when it reads differently', () => {
    const frame = (goal: string, reason: string) =>
      event('frame.updated', {
        frame: { version: 1, goal },
        openQuestionCodes: [],
        reason,
        stale: false,
        unmerged: [],
      });
    const items = logItems([
      frame('Map the swarm', 'created'),
      frame('Map the swarm, then fix it', 'progress'),
      // Opened again three times: the same frame, restored each time.
      frame('Map the swarm, then fix it', 'restored'),
      frame('Map the swarm, then fix it', 'restored'),
      frame('Map the swarm, then fix it', 'restored'),
      frame('Fix the swarm', 'progress'),
    ]);
    const goals = items.map((item) => (item.type === 'event' ? item.event.payload.frame : undefined));
    expect(goals).toEqual([
      { version: 1, goal: 'Map the swarm' },
      { version: 1, goal: 'Map the swarm, then fix it' },
      { version: 1, goal: 'Fix the swarm' },
    ]);
  });

  it('asks for the lessons’ words where a judgment names lessons: the ones brought in and the ones followed', () => {
    const judged = (specId: string) =>
      logItems([event('decision', { id: `${specId}-1`, specId, source: 'judge', outcome: { apply: ['a'] } })])[0];
    expect(namesLessons(judged('memory.recall'))).toBe(true);
    expect(namesLessons(judged('memory.applied'))).toBe(true);
    expect(namesLessons(judged('memory.worth'))).toBe(false);
  });
});
