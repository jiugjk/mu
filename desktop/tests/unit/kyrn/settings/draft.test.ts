import { describe, expect, it } from 'vitest';
import {
  defaultFeatureState,
  parseManifest,
  type OptionInfo,
} from '../../../../packages/desktop/src/common/kyrn/manifest';
import type { KyrnSettings } from '../../../../packages/desktop/src/common/kyrn/types';
import {
  PAGE_ROWS,
  decisionPageOf,
  dirtySections,
  featurePageOf,
  isStale,
  isStrayDecision,
  matches,
  newDraft,
  optionParts,
  setCompaction,
  toSave,
} from '../../../../packages/desktop/src/renderer/pages/settings/KyrnSettings/draft';
import {
  blankProvider,
  freeProviderId,
  providerProblems,
} from '../../../../packages/desktop/src/renderer/pages/settings/KyrnSettings/providers/endpoints';
import manifestJson from './manifest.fixture.json';

const harness = parseManifest(manifestJson);
if (harness.status !== 'ok') throw new Error('fixture manifest is not readable');

const base: KyrnSettings = {
  revision: 'r1',
  tiers: ['jev'],
  judges: { jev: { type: 'jev', model: '', baseUrl: '', apiKeyEnv: 'TYPESAFE_API_KEY', timeoutMs: 10000 } },
  mode: 'shadow',
  betaCompression: false,
  autoCompaction: true,
  maxContextTokens: 0,
  keys: { TYPESAFE_API_KEY: false },
  harness,
  decisionModes: {},
  features: Object.fromEntries(
    harness.manifest.features.map((feature) => [feature.name, defaultFeatureState(feature)])
  ),
  models: {
    providers: [
      {
        ...blankProvider('relay'),
        isNew: undefined,
        baseUrl: 'https://relay.example.com/v1',
        key: 'managed',
        keySet: true,
      },
    ],
    foreign: [],
    defaults: { provider: '', model: '', thinkingLevel: '' },
    commented: false,
    problem: '',
  },
  permissions: { mode: 'jev', from: 'default' },
  boardModel: { supported: true, model: '' },
};

const entry = (id: string) => ({ id, name: '', api: '', baseUrl: '', modelCount: 0 });

describe('the draft of the settings area', () => {
  it('is clean when nothing was edited, whatever is read-only about a provider', () => {
    const draft = newDraft(structuredClone(base));
    draft.settings.models.providers[0].keySet = false;
    draft.settings.models.providers[0].headerNames = ['x'];
    expect([...dirtySections(base, draft)]).toEqual([]);
  });
  it('names each page that was edited, and a typed key counts', () => {
    const edited = structuredClone(base);
    edited.decisionModes = { 'tool.risk': 'off' };
    edited.features.guard.enabled = false;
    edited.maxContextTokens = 64000;
    expect(new Set(dirtySections(base, newDraft(edited)))).toEqual(new Set(['decisions', 'moreFeatures', 'context']));
    // A switch that carries the product is on the features page; every other feature on the more-features page.
    edited.features.swarm.enabled = !edited.features.swarm.enabled;
    expect(dirtySections(base, newDraft(edited)).has('features')).toBe(true);
    expect([...dirtySections(base, { ...newDraft(base), judgeKeys: { TYPESAFE_API_KEY: 'k' } })]).toEqual(['judges']);
    expect([...dirtySections(base, { ...newDraft(base), providerKeys: { relay: 'k' } })]).toEqual(['providers']);
    expect([...dirtySections(base, { ...newDraft(base), providerKeys: { relay: '' } })]).toEqual([]);
  });
  it('counts the startup model and the board’s model as the default model page', () => {
    const startup = structuredClone(base);
    startup.models.defaults = { provider: 'relay', model: 'x', thinkingLevel: 'high' };
    expect([...dirtySections(base, newDraft(startup))]).toEqual(['defaultModel']);
    const board = { ...base, boardModel: { ...base.boardModel, model: 'relay/x' } };
    expect([...dirtySections(base, newDraft(board))]).toEqual(['defaultModel']);
    expect(toSave(newDraft(startup)).models?.defaults).toEqual({
      provider: 'relay',
      model: 'x',
      thinkingLevel: 'high',
    });
  });
  it('sends keys as credentials under the variable of their provider, and nothing read-only', () => {
    const sent = toSave({
      settings: base,
      judgeKeys: { TYPESAFE_API_KEY: 'judge' },
      providerKeys: { relay: 'sk', gone: 'x' },
    });
    expect(sent.credentials).toEqual([
      { name: 'TYPESAFE_API_KEY', value: 'judge' },
      { name: 'MU_PROVIDER_RELAY_API_KEY', value: 'sk' },
    ]);
    expect(Object.keys(sent)).not.toEqual(expect.arrayContaining(['keys', 'harness']));
    expect(Object.keys(sent.models ?? {})).toEqual(['providers', 'defaults']);
    const old = toSave(newDraft({ ...base, harness: { status: 'missing' }, features: {} }));
    expect(old).not.toHaveProperty('features');
  });
  it('counts a removed hand-written entry as a change, and names it for the store only against the base', () => {
    const read = { ...base, models: { ...base.models, foreign: [entry('lab'), entry('anthropic')] } };
    const draft = newDraft({ ...read, models: { ...read.models, foreign: [entry('anthropic')] } });
    expect([...dirtySections(read, draft)]).toEqual(['providers']);
    expect(toSave(draft, read).models?.removeEntries).toEqual(['lab']);
    expect(toSave(newDraft(read), read).models).not.toHaveProperty('removeEntries');
    // Without the base nothing is known to be removed, so nothing is.
    expect(toSave(draft).models).not.toHaveProperty('removeEntries');
  });
  it('keeps the beta switch and the compaction feature as one, on the more-features page', () => {
    const on = setCompaction(base, true);
    expect([on.betaCompression, on.features.compaction.enabled]).toEqual([true, true]);
    expect(setCompaction({ ...base, features: {} }, true).betaCompression).toBe(true);
    expect([...dirtySections(base, newDraft(on))]).toEqual(['moreFeatures']);
  });
  it('names the one judges page for the choice, the order, a profile’s field and any judge’s key', () => {
    const laya = { type: 'local' as const, model: '', baseUrl: '', apiKeyEnv: '', timeoutMs: 3000 };
    const one = { ...base, judges: { ...base.judges, laya } };
    const two = { ...one, tiers: ['jev', 'laya'] };
    // Laya picked: the one judge now.
    expect([...dirtySections(two, newDraft({ ...two, tiers: ['laya'] }))]).toEqual(['judges']);
    // The order turned round, and a second judge added.
    expect([...dirtySections(two, newDraft({ ...two, tiers: ['laya', 'jev'] }))]).toEqual(['judges']);
    expect([...dirtySections(one, newDraft(two))]).toEqual(['judges']);
    // A profile's field.
    const slower = structuredClone(one);
    slower.judges.jev.timeoutMs = 9000;
    expect([...dirtySections(one, newDraft(slower))]).toEqual(['judges']);
    // A key, of the judge chosen or of one further down the order.
    expect([...dirtySections(base, { ...newDraft(base), judgeKeys: { MU_JUDGE_OWN: 'k' } })]).toEqual(['judges']);
    const layaFirst = { ...one, tiers: ['laya', 'jev'] };
    expect([...dirtySections(layaFirst, { ...newDraft(layaFirst), judgeKeys: { TYPESAFE_API_KEY: 'k' } })]).toEqual([
      'judges',
    ]);
  });
  it('never writes the mode a new conversation starts in: that is the permission feature’s option now', () => {
    const picked = { ...base, permissions: { mode: 'full', from: 'picked' as const } };
    expect(toSave(newDraft(picked))).not.toHaveProperty('permissions');
    expect([...dirtySections(base, newDraft(picked))]).toEqual([]);
  });
  it('searches every word, in any of the texts, ignoring case', () => {
    expect(matches('', 'anything')).toBe(true);
    expect(matches('HIVE deliver', 'hive.deliver', '蜂群：投递')).toBe(true);
    expect(matches('蜂群 risk', 'hive.deliver', '蜂群：投递')).toBe(false);
    // A stale revision is recognised by the store's code, not by its English words.
    expect(isStale({ code: 'stale' })).toBe(true);
    expect(isStale({ code: 'unknown' })).toBe(false);
  });
});

describe('provider form rules', () => {
  it('explains an id, an address and model ids the store would refuse', () => {
    const provider = { ...blankProvider('Bad Id'), baseUrl: 'http://example.com/v1', models: [] };
    expect(providerProblems(provider, true, new Set())).toEqual({ id: 'format', baseUrl: 'unsafe' });
    expect(providerProblems({ ...provider, id: 'openai' }, true, new Set()).id).toBe('reserved');
    expect(providerProblems({ ...provider, id: 'mine' }, true, new Set(['mine'])).id).toBe('taken');
    // A saved provider keeps whatever id it has.
    expect(providerProblems({ ...provider, baseUrl: '' }, false, new Set())).toEqual({ baseUrl: 'empty' });
    const model = {
      id: 'a',
      name: '',
      reasoning: false,
      imageInput: false,
      contextWindow: 1,
      maxTokens: 1,
      thinkingLevels: [],
    };
    const ok = { ...provider, id: 'mine', baseUrl: 'http://localhost:1234/v1' };
    expect(providerProblems({ ...ok, baseUrl: 'http://192.168.31.124:8000/v1', models: [] }, false, new Set())).toEqual(
      {}
    );
    expect(providerProblems({ ...ok, models: [model, model] }, true, new Set()).models).toBe('duplicate');
    expect(providerProblems({ ...ok, models: [{ ...model, id: ' ' }] }, true, new Set()).models).toBe('emptyId');
    expect(providerProblems({ ...ok, models: [model] }, true, new Set())).toEqual({});
  });
  it('finds a free id', () => {
    expect(freeProviderId(new Set())).toBe('custom');
    expect(freeProviderId(new Set(['custom', 'custom-2']))).toBe('custom-3');
  });
});

describe('which page a setting is on', () => {
  const { manifest } = harness;

  it('puts a decision point on its group’s page, and the lessons’ points on a page of their own', () => {
    expect(decisionPageOf({ group: 'tools', feature: 'guard' })).toBe('tools');
    // The experience library's points are in the context group, where with the rest they would run past a page.
    expect(decisionPageOf({ group: 'context', feature: 'memory' })).toBe('memory');
    expect(decisionPageOf({ group: 'memory', feature: 'anything' })).toBe('memory');
    // A group the rail has no page for is shown on the first page, under its own name.
    expect(decisionPageOf({ group: 'misc', feature: 'x' })).toBe('input');
    expect(isStrayDecision({ group: 'misc', feature: 'x' })).toBe(true);
    expect(isStrayDecision({ group: 'input', feature: 'preflight' })).toBe(false);
    expect(isStrayDecision({ group: 'context', feature: 'memory' })).toBe(false);
    for (const decision of manifest.decisions) expect(isStrayDecision(decision), decision.id).toBe(false);
  });

  it('puts a feature on the page of the first point it acts at, and one that acts at none under Other', () => {
    const page = (name: string) => featurePageOf(manifest, { name });
    expect(page('preflight')).toBe('input');
    expect(page('compaction')).toBe('context');
    expect(page('welcome')).toBe('other');
    expect(page('no-such-feature')).toBe('other');
    // The team group has no more-features page: its features are under Other.
    const team = manifest.decisions.find((decision) => decision.group === 'team');
    if (team) expect(page(team.feature)).toBe('other');
    expect(featurePageOf(undefined, { name: 'preflight' })).toBe('other');
  });

  it('keeps every page of the fixture harness within a page of rows', () => {
    const decisions = new Map<string, number>();
    for (const decision of manifest.decisions)
      decisions.set(decisionPageOf(decision), (decisions.get(decisionPageOf(decision)) ?? 0) + 1);
    for (const [page, count] of decisions) expect(count, page).toBeLessThanOrEqual(PAGE_ROWS);
    for (const feature of manifest.features) expect(optionParts(feature.options).length, feature.name).toBe(1);
  });
});

/** An option as far as the pages of options care: its key, and whether it is a switch. */
const option = (key: string, kind: OptionInfo['kind']) => ({ key, kind });
const keys = (parts: { key: string }[][]) => parts.map((part) => part.map((each) => each.key));

describe('the pages of a feature’s options', () => {
  it('keeps a switch on the page of the settings after it, and fills each page up to twelve', () => {
    // The capability packs: six switches, eighteen options, each switch followed by its own settings.
    const packs = [
      option('astGrep', 'boolean'),
      option('maxResults', 'number'),
      option('maxDiffChars', 'number'),
      option('astGrepCommand', 'text'),
      option('github', 'boolean'),
      option('ghCommand', 'text'),
      option('commit', 'boolean'),
      option('maxPlanChars', 'number'),
      option('review', 'boolean'),
      option('conflicts', 'boolean'),
      option('maxSideLines', 'number'),
      option('maxConflictChars', 'number'),
      option('maxFindings', 'number'),
      option('debugger', 'boolean'),
      option('maxFrames', 'number'),
      option('maxVariables', 'number'),
      option('debugOutputChars', 'number'),
      option('debugWaitMs', 'number'),
    ];
    const parts = optionParts(packs);
    expect(keys(parts)).toEqual([
      [
        'astGrep',
        'maxResults',
        'maxDiffChars',
        'astGrepCommand',
        'github',
        'ghCommand',
        'commit',
        'maxPlanChars',
        'review',
      ],
      [
        'conflicts',
        'maxSideLines',
        'maxConflictChars',
        'maxFindings',
        'debugger',
        'maxFrames',
        'maxVariables',
        'debugOutputChars',
        'debugWaitMs',
      ],
    ]);
    expect(parts.flat()).toEqual(packs);
  });

  it('leaves twelve options on one page, cuts a longer run without switches where the page is full', () => {
    const twelve = Array.from({ length: PAGE_ROWS }, (_, index) => option(`n${index}`, 'number'));
    expect(optionParts(twelve)).toHaveLength(1);
    const fourteen = Array.from({ length: 14 }, (_, index) => option(`n${index}`, 'number'));
    expect(optionParts(fourteen).map((part) => part.length)).toEqual([12, 2]);
    expect(optionParts([])).toEqual([[]]);
  });
});
