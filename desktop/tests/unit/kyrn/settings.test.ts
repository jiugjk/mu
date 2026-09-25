import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../../../packages/desktop/src/process/agent/kyrn/settings';
import { initializeKyrn, type BackendRequest } from '../../../packages/desktop/src/process/agent/kyrn/product';
import { configPath, muEnv, muHome } from '../../../packages/desktop/src/process/agent/kyrn/naming';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kyrn-settings-'));
  const dir = join(root, 'agent');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'kyrn.json'),
    JSON.stringify({
      tiers: ['jev'],
      routes: { 'browser.step': ['llm-a'] },
      features: { hive: { maxBees: 4 }, compaction: { enabled: false, keepThreshold: 0.4 } },
      judges: { 'llm-a': { type: 'llm', model: 'p/m', thinking: 'low' } },
    })
  );
  return {
    root,
    dir,
    store: new SettingsStore(dir, root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
describe('native mu settings', () => {
  it('shares the context cap with pi and preserves model settings and reserve', () => {
    const f = fixture();
    try {
      writeFileSync(
        join(f.dir, 'settings.json'),
        JSON.stringify({ defaultModel: 'model', compaction: { reserveTokens: 1000 } })
      );
      const saved = f.store.save({ ...f.store.read(), maxContextTokens: 64000, autoCompaction: true });
      expect(saved.maxContextTokens).toBe(64000);
      expect(JSON.parse(readFileSync(join(f.dir, 'settings.json'), 'utf8'))).toEqual({
        defaultModel: 'model',
        compaction: { reserveTokens: 1000, enabled: true, maxContextTokens: 64000 },
      });
      expect(() => f.store.save({ ...saved, maxContextTokens: 200 })).toThrow('Context threshold');
    } finally {
      f.cleanup();
    }
  });
  it('rejects a stale save after the CLI changes pi settings', () => {
    const f = fixture();
    try {
      const old = f.store.read();
      writeFileSync(join(f.dir, 'settings.json'), '{"defaultModel":"new"}');
      expect(() => f.store.save(old)).toThrow('Configuration changed');
    } finally {
      f.cleanup();
    }
  });
  it('persists the beta toggle without replacing routes, profiles or feature options', () => {
    const f = fixture();
    try {
      f.store.save({ ...f.store.read(), betaCompression: true });
      const raw = JSON.parse(readFileSync(join(f.dir, 'kyrn.json'), 'utf8'));
      expect(raw.features).toEqual({ hive: { maxBees: 4 }, compaction: { enabled: true, keepThreshold: 0.4 } });
      expect(raw.routes).toEqual({ 'browser.step': ['llm-a'] });
      expect(raw.judges['llm-a'].thinking).toBe('low');
    } finally {
      f.cleanup();
    }
  });
  it('rejects stale saves instead of overwriting CLI changes', () => {
    const f = fixture();
    try {
      const old = f.store.read();
      f.store.save({ ...old, betaCompression: true });
      expect(() => f.store.save(old)).toThrow('Configuration changed');
    } finally {
      f.cleanup();
    }
  });
  it('keeps credentials write-only and restricts shell-sensitive input', () => {
    const f = fixture();
    try {
      const saved = f.store.save({
        ...f.store.read(),
        credential: { name: 'TYPESAFE_API_KEY', value: 'fixture-secret' },
      });
      expect(JSON.stringify(saved)).not.toContain('fixture-secret');
      expect(statSync(join(f.root, '.env')).mode & 0o777).toBe(0o600);
      expect(() => f.store.save({ ...saved, credential: { name: 'NODE_OPTIONS', value: 'execute' } })).toThrow(
        'Invalid credential'
      );
    } finally {
      f.cleanup();
    }
  });
  it('accepts a private-network HTTP address for a TypeSafe judge and still refuses a public one', () => {
    const f = fixture();
    try {
      const value = f.store.read();
      value.judges['jev-direct'].baseUrl = 'http://192.168.31.124:8000/v1/systemone';
      expect(f.store.save(value).judges['jev-direct'].baseUrl).toBe('http://192.168.31.124:8000/v1/systemone');
      const again = f.store.read();
      again.judges['jev-direct'].baseUrl = 'http://example.com/v1';
      expect(() => f.store.save(again)).toThrow('private-network address');
      expect(f.store.read().judges['jev-direct'].baseUrl).toBe('http://192.168.31.124:8000/v1/systemone');
    } finally {
      f.cleanup();
    }
  });
  it('rejects credentialed or non-HTTPS external endpoints before changing disk', () => {
    const f = fixture();
    try {
      const value = f.store.read();
      value.judges.jev.baseUrl = 'https://secret@example.com';
      expect(() => f.store.save(value)).toThrow('without embedded credentials');
      expect(f.store.read().judges.jev.baseUrl).toBe('');
    } finally {
      f.cleanup();
    }
  });
});

describe('the rename from KYRN to mu', () => {
  it('keeps saving to kyrn.json while that is the only file, and follows it once it is renamed', () => {
    const f = fixture();
    try {
      f.store.save({ ...f.store.read(), mode: 'active' });
      expect(existsSync(join(f.dir, 'mu.json'))).toBe(false);
      expect(JSON.parse(readFileSync(join(f.dir, 'kyrn.json'), 'utf8')).modes.default).toBe('active');

      // The one-time move of the home renames the file. The same store follows it without a restart.
      renameSync(join(f.dir, 'kyrn.json'), join(f.dir, 'mu.json'));
      expect(f.store.read().mode).toBe('active');
      f.store.save({ ...f.store.read(), mode: 'off' });
      expect(JSON.parse(readFileSync(join(f.dir, 'mu.json'), 'utf8')).modes.default).toBe('off');
      expect(existsSync(join(f.dir, 'kyrn.json'))).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it('reads mu.json first when both files are there, and writes mu.json on a fresh machine', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, 'mu.json'), JSON.stringify({ tiers: ['laya'] }));
      expect(f.store.read().tiers).toEqual(['laya']);
      const fresh = join(f.root, 'fresh');
      mkdirSync(fresh);
      expect(configPath(fresh)).toBe(join(fresh, 'mu.json'));
    } finally {
      f.cleanup();
    }
  });
  it('accepts credential variables under the new prefix and the old one', () => {
    const f = fixture();
    try {
      for (const apiKeyEnv of ['MU_JUDGE_CUSTOM', 'KYRN_JUDGE_CUSTOM']) {
        const value = f.store.read();
        value.judges.jev.apiKeyEnv = apiKeyEnv;
        expect(f.store.save(value).judges.jev.apiKeyEnv).toBe(apiKeyEnv);
      }
      const value = f.store.read();
      value.judges.jev.apiKeyEnv = 'PATH';
      expect(() => f.store.save(value)).toThrow('Invalid credential variable');
    } finally {
      f.cleanup();
    }
  });
  it('stays in the old home until it has been moved, and never creates a second one beside it', () => {
    const f = fixture();
    try {
      expect(muHome(f.root)).toBe(join(f.root, '.mu'));
      mkdirSync(join(f.root, '.kyrn'));
      expect(muHome(f.root)).toBe(join(f.root, '.kyrn'));
      mkdirSync(join(f.root, '.mu'));
      expect(muHome(f.root)).toBe(join(f.root, '.mu'));
      expect(muEnv('AGENT_DIR', { MU_AGENT_DIR: '/new', KYRN_AGENT_DIR: '/old' })).toBe('/new');
      expect(muEnv('AGENT_DIR', { KYRN_AGENT_DIR: '/old' })).toBe('/old');
    } finally {
      f.cleanup();
    }
  });
});

type Call = { method: string; path: string; body?: unknown };
const puts = (calls: Call[]) => calls.filter((call) => call.method === 'PUT');
const switches = (calls: Call[], id: string) =>
  calls.filter((call) => call.path === `/api/agents/${id}/enabled`).map((call) => call.body);

describe('mu-only backend catalog', () => {
  type Options = { fail?: (call: Call) => boolean; wholeRecords?: boolean };
  /** Answers the way the bundled AionCore v0.2.2 was seen to, checked against a real one. */
  function backend(records: Record<string, unknown>[], options: Options = {}) {
    const calls: Call[] = [];
    const request: BackendRequest = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      if (options.fail?.({ method, path, body })) throw new Error('probe failed');
      // The list leaves `env` out, whatever is stored.
      if (path === '/api/agents/management') return records.map(({ env: _env, ...row }) => row) as T;
      if (path === '/api/assistants')
        return [
          { id: 'ak', agent_id: 'k', enabled: true },
          { id: 'ao', agent_id: 'other', enabled: true },
        ] as T;
      if (method === 'POST' && path === '/api/agents/custom')
        return { id: 'new', enabled: true, ...(body as object) } as T;
      const enabled = /^\/api\/agents\/([^/]+)\/enabled$/.exec(path);
      if (method === 'PATCH' && enabled) {
        // Setting `enabled` answers with the whole record: the only place `env` can be read.
        if (options.wholeRecords === false) return { status: 'online' } as T;
        const record = records.find((row) => row.id === enabled[1]);
        return { ...record, ...(body as object), available: true } as T;
      }
      return { status: 'online' } as T;
    };
    return { calls, request };
  }

  it('disables other runtimes and assistants before exposing the sole product engine', async () => {
    const { calls, request } = backend([
      { id: 'k', name: 'mu', command: '/kyrn/acp', enabled: true, yolo_id: 'full' },
      { id: 'other', enabled: true },
    ]);
    expect((await initializeKyrn(request, '/kyrn/acp')).assistants).toHaveLength(1);
    expect(calls).toContainEqual({ method: 'PATCH', path: '/api/agents/other/enabled', body: { enabled: false } });
    expect(calls).toContainEqual({ method: 'PATCH', path: '/api/assistants/ao/state', body: { enabled: false } });
    // Already called mu, with full auto set: nothing to read, nothing to update, nothing to create.
    expect(calls.filter((call) => call.method === 'PUT' || call.path === '/api/agents/custom')).toEqual([]);
    expect(switches(calls, 'k')).toEqual([]);
  });
  it('renames the registration from before the rename in place, sending the whole record back', async () => {
    const { calls, request } = backend([
      {
        id: 'k',
        name: 'KYRN',
        command: '/kyrn/acp',
        enabled: true,
        icon: 'icon.svg',
        description: 'KYRN harness · local Codex login · Jev judgment',
        args: ['--flag'],
        // Not in the list the backend returns. An update built from the list would clear it.
        env: [{ name: 'A', value: 'b' }],
        native_skills_dirs: ['/skills'],
        behavior_policy: { supports_side_question: true },
        yolo_id: 'yolo',
      },
      { id: 'other', enabled: true },
    ]);

    const catalog = await initializeKyrn(request, '/kyrn/acp');

    // The old conversations hang on this id: the same agent, not a second one.
    expect(catalog.agentId).toBe('k');
    expect(calls.filter((call) => call.path === '/api/agents/custom')).toEqual([]);
    expect(puts(calls)).toEqual([
      {
        method: 'PUT',
        path: '/api/agents/custom/k',
        body: {
          name: 'mu',
          command: '/kyrn/acp',
          icon: 'icon.svg',
          args: ['--flag'],
          env: [{ name: 'A', value: 'b' }],
          advanced: {
            // AionUi's own word for full auto, which mu does not know, becomes mu's full access.
            yolo_id: 'full',
            native_skills_dirs: ['/skills'],
            behavior_policy: { supports_side_question: true },
            description: 'mu harness · local Codex login · Jev judgment',
          },
        },
      },
    ]);
    // The record is read by setting `enabled` to what it already is; the agent being kept is never switched off.
    expect(switches(calls, 'k')).toEqual([{ enabled: true }]);
  });
  it('reads a disabled registration as it is, and only then switches it on', async () => {
    const { calls, request } = backend([{ id: 'k', name: 'KYRN', command: '/kyrn/acp', enabled: false }]);
    await initializeKyrn(request, '/kyrn/acp');
    expect(switches(calls, 'k')).toEqual([{ enabled: false }, { enabled: true }]);
    expect(puts(calls)).toHaveLength(1);
  });
  it('keeps a description the user wrote', async () => {
    const { calls, request } = backend([
      { id: 'k', name: 'KYRN', command: '/kyrn/acp', enabled: true, description: 'my own words' },
    ]);
    await initializeKyrn(request, '/kyrn/acp');
    const put = puts(calls)[0]?.body as { advanced: { description: string } };
    expect(put.advanced.description).toBe('my own words');
  });
  it('knows its own description in any capitalization, and writes it as the judge is spelled now', async () => {
    const { calls, request } = backend([
      {
        id: 'k',
        name: 'KYRN',
        command: '/kyrn/acp',
        enabled: true,
        description: 'mu harness · local codex login · jev judgment',
      },
    ]);
    await initializeKyrn(request, '/kyrn/acp');
    const put = puts(calls)[0]?.body as { advanced: { description: string } };
    expect(put.advanced.description).toBe('mu harness · local Codex login · Jev judgment');
  });
  it('keeps the old name rather than update a record it could not read whole', async () => {
    const { calls, request } = backend(
      [{ id: 'k', name: 'KYRN', command: '/kyrn/acp', enabled: true, env: [{ name: 'A', value: 'b' }] }],
      { wholeRecords: false }
    );

    const catalog = await initializeKyrn(request, '/kyrn/acp');

    expect(catalog.agentId).toBe('k');
    expect(puts(calls)).toEqual([]);
    expect(calls.filter((call) => call.path === '/api/agents/custom')).toEqual([]);
  });
  it.each([
    ['the update', (call: Call) => call.method === 'PUT'],
    ['reading the record', (call: Call) => call.path === '/api/agents/k/enabled'],
  ])('starts under the old name when the backend refuses %s', async (_what, fail) => {
    const { calls, request } = backend(
      [
        { id: 'k', name: 'KYRN', command: '/kyrn/acp', enabled: true },
        { id: 'other', enabled: true },
      ],
      { fail }
    );

    const catalog = await initializeKyrn(request, '/kyrn/acp');

    expect(catalog.agentId).toBe('k');
    expect(calls.filter((call) => call.path === '/api/agents/custom')).toEqual([]);
    expect(calls).toContainEqual({ method: 'PATCH', path: '/api/agents/other/enabled', body: { enabled: false } });
  });
  it('registers once, as mu, when nothing is registered yet, with full access for runs nobody watches', async () => {
    const { calls, request } = backend([{ id: 'other', enabled: true }]);
    await initializeKyrn(request, '/kyrn/acp');
    const created = calls.filter((call) => call.path === '/api/agents/custom');
    expect(created).toHaveLength(1);
    expect(created[0].body).toMatchObject({ name: 'mu', command: '/kyrn/acp', advanced: { yolo_id: 'full' } });
  });
  it('gives a registration without a full-auto mode mu’s full access, and keeps one of mu’s modes someone chose', async () => {
    const { calls, request } = backend([
      { id: 'k', name: 'mu', command: '/kyrn/acp', enabled: true, env: [{ name: 'A', value: 'b' }] },
    ]);
    await initializeKyrn(request, '/kyrn/acp');
    // A scheduled task asks AionCore for full auto: without it, the run would wait on a question nobody answers.
    expect(puts(calls)).toEqual([
      {
        method: 'PUT',
        path: '/api/agents/custom/k',
        body: expect.objectContaining({
          name: 'mu',
          env: [{ name: 'A', value: 'b' }],
          advanced: expect.objectContaining({ yolo_id: 'full' }),
        }),
      },
    ]);
    const chosen = backend([{ id: 'k', name: 'mu', command: '/kyrn/acp', enabled: true, yolo_id: 'jev' }]);
    await initializeKyrn(chosen.request, '/kyrn/acp');
    expect(puts(chosen.calls)).toEqual([]);
  });
  it.each(['KYRN', 'mu'])('never replaces a different user command registered as %s', async (name) => {
    const { calls, request } = backend([{ id: 'k', name, command: '/other' }]);
    await expect(initializeKyrn(request, '/kyrn/acp')).rejects.toThrow('different mu command');
    expect(calls).toHaveLength(1);
  });
});
