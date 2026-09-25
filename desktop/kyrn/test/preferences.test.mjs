import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Preferences } from '../main/preferences.mjs';

test('desktop defaults and project overrides persist without changing CLI settings or exposing keys', () => {
  const home = mkdtempSync(join(tmpdir(), 'kyrn-settings-'));
  try {
    const agent = join(home, 'agent');
    mkdirSync(agent);
    writeFileSync(
      join(agent, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'fixture', defaultThinkingLevel: 'medium' })
    );
    writeFileSync(
      join(agent, 'kyrn.json'),
      JSON.stringify({ tiers: ['jev'], judges: { local: { type: 'http', apiKey: 'never-render' } } })
    );
    const prefs = new Preferences(home, agent);
    assert.equal(prefs.effective('/project').model, 'openai-codex/fixture');
    prefs.save('defaults', '', { thinking: 'high', judge: 'jev,local', mode: 'active' });
    prefs.save('project', '/project', { name: '示例', thinking: 'low' });
    assert.equal(new Preferences(home, agent).effective('/project').thinking, 'low');
    assert.equal(prefs.effective('/other').thinking, 'high');
    assert.equal(prefs.effective('/project').model, 'openai-codex/fixture');
    assert.equal(JSON.stringify(prefs.read()).includes('never-render'), false);
    assert.throws(() => prefs.save('defaults', '', { apiKey: 'secret' }), /无效/);
    assert.throws(() => prefs.save('defaults', '', { judge: 'arbitrary-endpoint' }), /未知/);
    prefs.save('project', '/project', {});
    assert.equal(prefs.effective('/project').thinking, 'high');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
