import { describe, expect, it } from 'vitest';
import { conversationSessions } from '../../../packages/desktop/src/process/agent/kyrn/conversationSession.ts';

/** A backend with these conversations' `extra`, counting the requests; bindings as `conversation/agent` → session. */
function backend(extras: Record<string, Record<string, unknown>>, bindings: Record<string, string>) {
  const requests: string[] = [];
  const sessions = conversationSessions(
    async (conversationId) => {
      requests.push(conversationId);
      const extra = extras[conversationId];
      if (!extra) throw new Error(`no conversation ${conversationId}`);
      return extra;
    },
    (conversationId, agentId) => bindings[`${conversationId}/${agentId}`] ?? ''
  );
  return { sessions, requests, bindings };
}

/** Reads each conversation's session one after another, the way the pollers do. */
const readInTurn = (sessions: ReturnType<typeof backend>['sessions'], ids: string[]): Promise<string[]> =>
  ids.reduce<Promise<string[]>>(
    (read, id) => read.then(async (found) => [...found, await sessions.session(id)]),
    Promise.resolve([])
  );

describe("the session behind a conversation, as the work panel's once-a-second reads find it", () => {
  it('asks the backend for a conversation once, then reads only the binding', async () => {
    const { sessions, requests } = backend({ c1: { agent_id: 'mu' } }, { 'c1/mu': 's1' });
    expect(await readInTurn(sessions, ['c1', 'c1', 'c1', 'c1', 'c1'])).toEqual(['s1', 's1', 's1', 's1', 's1']);
    expect(requests).toEqual(['c1']);
  });

  it('sees a new session behind the same conversation (a rewind, a reopen) at the next read', async () => {
    const { sessions, bindings } = backend({ c1: { agent_id: 'mu' } }, {});
    expect(await sessions.session('c1')).toBe('');
    bindings['c1/mu'] = 's1';
    expect(await sessions.session('c1')).toBe('s1');
    bindings['c1/mu'] = 's2';
    expect(await sessions.session('c1')).toBe('s2');
  });

  it('keeps asking about a conversation that names no agent', async () => {
    const { sessions, requests } = backend({ c1: {} }, {});
    expect(await sessions.session('c1')).toBe('');
    expect(await sessions.session('c1')).toBe('');
    expect(requests).toEqual(['c1', 'c1']);
  });

  it('remembers nothing for a conversation the backend could not give', async () => {
    const { sessions, requests } = backend({}, {});
    await expect(sessions.session('gone')).rejects.toThrow('no conversation gone');
    await expect(sessions.session('gone')).rejects.toThrow('no conversation gone');
    expect(requests).toEqual(['gone', 'gone']);
  });

  it("gives the conversation's extra fresh from the backend, for readers that need more than the session", async () => {
    const extras = { c1: { agent_id: 'mu', workspace: '/a' } as Record<string, unknown> };
    const { sessions, requests } = backend(extras, { 'c1/mu': 's1' });
    expect(await sessions.conversation('c1')).toEqual({ extra: { agent_id: 'mu', workspace: '/a' }, sessionId: 's1' });
    extras.c1 = { agent_id: 'mu', workspace: '/b' };
    expect((await sessions.conversation('c1')).extra.workspace).toBe('/b');
    expect(await sessions.session('c1')).toBe('s1');
    expect(requests).toEqual(['c1', 'c1']);
  });

  it('forgets the conversation it asked about longest ago once 512 are remembered', async () => {
    const extras: Record<string, Record<string, unknown>> = {};
    for (let n = 0; n <= 512; n++) extras[`c${n}`] = { agent_id: 'mu' };
    const { sessions, requests } = backend(extras, {});
    await readInTurn(sessions, Object.keys(extras));
    requests.length = 0;
    await sessions.session('c512');
    await sessions.session('c1');
    expect(requests).toEqual([]);
    await sessions.session('c0');
    expect(requests).toEqual(['c0']);
  });
});
