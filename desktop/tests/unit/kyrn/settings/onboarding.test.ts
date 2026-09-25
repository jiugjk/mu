import { describe, expect, it } from 'vitest';
import type { KyrnSettings } from '@/common/kyrn/types';
import { newDraft } from '@/renderer/pages/settings/KyrnSettings/draft';
import {
  choiceOf,
  choose,
  jevKeyVariable,
  kindOf,
  profileFor,
  withJevAccess,
} from '@/renderer/pages/settings/KyrnSettings/judgeChoice';
import {
  apiModelProblem,
  markOnboardingSeen,
  needsOnboarding,
  ONBOARDING_KEY,
  onboardingSeen,
  providerIdFor,
  providerNameFor,
  withApiModel,
  withSignedInModel,
} from '@/renderer/pages/welcome/onboarding';

function settings(patch: Partial<KyrnSettings> = {}): KyrnSettings {
  return {
    revision: 'r1',
    tiers: ['laya', 'jev'],
    judges: {
      jev: { type: 'jev', model: 'jev-latest', baseUrl: '', apiKeyEnv: 'TYPESAFE_API_KEY', timeoutMs: 10000 },
      'jev-gateway': {
        type: 'gateway',
        model: 'typesafe-ai/jev',
        baseUrl: '',
        apiKeyEnv: 'AI_GATEWAY_API_KEY',
        timeoutMs: 10000,
      },
      laya: { type: 'local', model: '', baseUrl: 'http://127.0.0.1:47823', apiKeyEnv: '', timeoutMs: 4000 },
      mock: { type: 'mock', model: '', baseUrl: '', apiKeyEnv: '', timeoutMs: 10000 },
    },
    mode: 'active',
    betaCompression: false,
    autoCompaction: true,
    maxContextTokens: 0,
    keys: {},
    harness: { status: 'missing' },
    decisionModes: {},
    features: {},
    models: {
      providers: [],
      foreign: [],
      defaults: { provider: '', model: '', thinkingLevel: '' },
      commented: false,
      problem: '',
    },
    permissions: { mode: '', from: 'default' },
    boardModel: { supported: false, model: '' },
    ...patch,
  } as KyrnSettings;
}

describe('the judge choice', () => {
  it('reads the choice from the first judge asked, and knows none for a mock', () => {
    expect(choiceOf(settings())).toBe('local');
    expect(choiceOf(settings({ tiers: ['jev-gateway'] }))).toBe('jev');
    expect(choiceOf(settings({ tiers: ['mock'] }))).toBeUndefined();
  });

  it('picks the built-in profile of a kind, else the first of that kind', () => {
    expect(profileFor(settings(), 'jev')).toBe('jev');
    const { jev: _jev, ...others } = settings().judges;
    expect(profileFor(settings({ judges: others }), 'jev')).toBe('jev-gateway');
  });

  it('makes the choice the one judge, and leaves a model as judge to the advanced view', () => {
    expect(choose(settings(), 'jev').tiers).toEqual(['jev']);
    expect(choose(settings({ tiers: ['jev'] }), 'local').tiers).toEqual(['laya']);
    // Without a profile of that kind nothing changes.
    const { laya: _laya, ...noLocal } = settings().judges;
    const without = settings({ judges: noLocal, tiers: ['jev'] });
    expect(choose(without, 'local')).toBe(without);
    // A model as judge first in line is not one of the two choices: the page says it is a custom one.
    const modelFirst = settings({
      judges: {
        ...settings().judges,
        luna: { type: 'llm', model: 'a/b', baseUrl: '', apiKeyEnv: '', timeoutMs: 30000 },
      },
      tiers: ['luna'],
    });
    expect(choiceOf(modelFirst)).toBeUndefined();
  });

  it('stands for the profile of a kind the order already asks, so the key asked for is the one its way in needs', () => {
    const viaGateway = settings({ tiers: ['jev-gateway'] });
    expect(profileFor(viaGateway, 'jev')).toBe('jev-gateway');
    expect(jevKeyVariable(viaGateway.judges[profileFor(viaGateway, 'jev')!])).toBe('AI_GATEWAY_API_KEY');
    expect(choose(viaGateway, 'jev').tiers).toEqual(['jev-gateway']);
    expect(kindOf(viaGateway.judges.laya)).toBe('local');
    expect(kindOf(viaGateway.judges.mock)).toBeUndefined();
  });

  it('swaps the profile of Jev’s way in into its place in the order, never asking the same one twice', () => {
    expect(withJevAccess(settings(), 1, 'gateway').tiers).toEqual(['laya', 'jev-gateway']);
    expect(withJevAccess(settings({ tiers: ['jev-gateway', 'laya'] }), 0, 'jev').tiers).toEqual(['jev', 'laya']);
    // Already that way: nothing changes.
    const same = settings();
    expect(withJevAccess(same, 1, 'jev')).toBe(same);
    // Two Jevs would be the same profile: the second goes.
    expect(withJevAccess(settings({ tiers: ['jev', 'jev-gateway'] }), 1, 'jev').tiers).toEqual(['jev']);
    // No profile for that way: the judge's own profile changes its type.
    const direct = withJevAccess(settings(), 1, 'typesafe');
    expect(direct.tiers).toEqual(['laya', 'jev']);
    expect(direct.judges.jev.type).toBe('typesafe');
  });

  it('keeps the key of a Jev profile where the profile says, else in TYPESAFE_API_KEY', () => {
    expect(jevKeyVariable(settings().judges['jev-gateway'])).toBe('AI_GATEWAY_API_KEY');
    expect(jevKeyVariable({ ...settings().judges.jev, apiKeyEnv: '' })).toBe('TYPESAFE_API_KEY');
  });
});

describe('the first-run guide', () => {
  it('is for someone with no startup model, once', () => {
    expect(needsOnboarding(settings())).toBe(true);
    expect(
      needsOnboarding(
        settings({ models: { ...settings().models, defaults: { provider: 'relay', model: 'x', thinkingLevel: '' } } })
      )
    ).toBe(false);
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(onboardingSeen(storage)).toBe(false);
    markOnboardingSeen(storage);
    expect(store.has(ONBOARDING_KEY)).toBe(true);
    expect(onboardingSeen(storage)).toBe(true);
    // Storage that throws (a locked-down profile) never nags.
    expect(
      onboardingSeen({
        getItem: () => {
          throw new Error('denied');
        },
      })
    ).toBe(true);
  });

  it('names a provider after its address, and never takes an id pi already has', () => {
    const none = new Set<string>();
    expect(providerIdFor('https://api.deepseek.com/v1', none)).toBe('deepseek-custom');
    expect(providerIdFor('https://relay.example.com', none)).toBe('relay');
    expect(providerIdFor('https://relay.example.com', new Set(['relay']))).toBe('relay-custom');
    expect(providerIdFor('https://relay.example.com', new Set(['relay', 'relay-custom']))).toBe('relay-custom-2');
    expect(providerIdFor('http://localhost:11434/v1', none)).toBe('local');
    expect(providerIdFor('http://192.168.31.124:8000/v1', none)).toBe('local');
    expect(providerIdFor('https://api.openai.com/v1', none)).toBe('openai-custom');
    expect(providerIdFor('https://api.moonshot.cn/v1', none)).toBe('moonshot');
  });

  it('gives a provider a name read the same in every language: its word of the address, else the host', () => {
    expect(providerNameFor('https://api.moonshot.cn/v1', 'moonshot')).toBe('moonshot');
    // Not "local" or "…-custom", which are English words.
    expect(providerNameFor('http://localhost:11434/v1', 'local')).toBe('localhost:11434');
    expect(providerNameFor('http://127.0.0.1:1234/v1', 'local-custom')).toBe('127.0.0.1:1234');
    expect(providerNameFor('http://192.168.31.124:8000/v1', 'local')).toBe('192.168.31.124:8000');
    expect(providerNameFor('https://api.deepseek.com/v1', 'deepseek-custom')).toBe('api.deepseek.com');
    expect(providerNameFor('https://relay.example.com', 'relay-custom')).toBe('relay.example.com');

    const added = withApiModel(newDraft(settings()), {
      api: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
      key: '',
      model: 'qwen3',
    });
    expect(added.id).toBe('local');
    expect(added.draft.settings.models.providers[0]).toMatchObject({ id: 'local', name: 'localhost:11434' });
  });

  it('asks for https, a key unless the service is on this machine, and a model name', () => {
    const input = {
      api: 'openai-completions' as const,
      baseUrl: 'https://relay.example.com/v1',
      key: 'sk',
      model: 'm',
    };
    expect(apiModelProblem(input)).toBeUndefined();
    expect(apiModelProblem({ ...input, baseUrl: 'http://relay.example.com/v1' })).toBe('baseUrl');
    expect(apiModelProblem({ ...input, baseUrl: 'http://8.8.8.8/v1' })).toBe('baseUrl');
    expect(apiModelProblem({ ...input, baseUrl: 'http://192.168.31.124:8000/v1' })).toBeUndefined();
    expect(apiModelProblem({ ...input, baseUrl: 'http://192.168.31.124:8000/v1', key: '' })).toBe('key');
    expect(apiModelProblem({ ...input, key: ' ' })).toBe('key');
    expect(apiModelProblem({ ...input, baseUrl: 'http://127.0.0.1:11434/v1', key: '' })).toBeUndefined();
    expect(apiModelProblem({ ...input, model: '' })).toBe('model');
  });

  it('adds the typed endpoint as the startup model, and replaces it when the guide is walked again', () => {
    const draft = newDraft(settings());
    const first = withApiModel(draft, {
      api: 'anthropic-messages',
      baseUrl: 'https://relay.example.com',
      key: 'sk-1',
      model: 'claude-sonnet-5',
    });
    expect(first.id).toBe('relay');
    expect(first.draft.settings.models.providers).toMatchObject([
      {
        id: 'relay',
        name: 'relay',
        api: 'anthropic-messages',
        baseUrl: 'https://relay.example.com',
        isNew: true,
        models: [{ id: 'claude-sonnet-5' }],
      },
    ]);
    expect(first.draft.settings.models.defaults).toMatchObject({ provider: 'relay', model: 'claude-sonnet-5' });
    expect(first.draft.providerKeys).toEqual({ relay: 'sk-1' });

    const again = withApiModel(
      first.draft,
      { api: 'openai-completions', baseUrl: 'https://other.example.net/v1', key: 'sk-2', model: 'm2' },
      first.id
    );
    expect(again.draft.settings.models.providers.map((provider) => provider.id)).toEqual(['other']);
    expect(again.draft.providerKeys).toEqual({ other: 'sk-2' });

    // Switching to a signed-in account takes the provider the guide added away again.
    const signedIn = withSignedInModel(again.draft, 'openai-codex', 'gpt-5.6-sol', again.id);
    expect(signedIn.settings.models.providers).toEqual([]);
    expect(signedIn.providerKeys).toEqual({});
    expect(signedIn.settings.models.defaults).toMatchObject({ provider: 'openai-codex', model: 'gpt-5.6-sol' });
  });
});
