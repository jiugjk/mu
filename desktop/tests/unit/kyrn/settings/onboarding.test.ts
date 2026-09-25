import { describe, expect, it } from 'vitest';
import type { KyrnSettings } from '@/common/kyrn/types';
import { newDraft } from '@/renderer/pages/settings/KyrnSettings/draft';
import {
  choiceOf,
  choose,
  clmKeyVariable,
  defaultModelOf,
  GUIDE_CHOICES,
  JEV_SERVICES,
  JUDGE_CHOICES,
  jevKeyVariable,
  kindOf,
  profileFor,
  serviceOf,
  withJevService,
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

  it('offers CLM as a third choice in the settings, and leaves it out of the first-run guide', () => {
    const clm = {
      type: 'clm' as const,
      model: 'clm-latest',
      baseUrl: '',
      apiKeyEnv: 'MU_JUDGE_CLM_API_KEY',
      timeoutMs: 10000,
    };
    const withClm = settings({ judges: { ...settings().judges, clm } });
    expect(JUDGE_CHOICES).toEqual(['jev', 'local', 'clm']);
    expect(GUIDE_CHOICES).toEqual(['jev', 'local']);
    expect(kindOf(clm)).toBe('clm');
    expect(serviceOf(clm)).toBeUndefined();
    expect(choose(withClm, 'clm').tiers).toEqual(['clm']);
    expect(choiceOf(choose(withClm, 'clm'))).toBe('clm');
    expect(profileFor(settings({ judges: { ...settings().judges, gpu: clm } }), 'clm')).toBe('gpu');
    expect(clmKeyVariable(clm)).toBe('MU_JUDGE_CLM_API_KEY');
    expect(clmKeyVariable({ ...clm, apiKeyEnv: '' })).toBe('MU_JUDGE_CLM_API_KEY');
  });

  it('stands for the profile of a kind the order already asks, so the key asked for is the one its service needs', () => {
    const viaGateway = settings({ tiers: ['jev-gateway'] });
    expect(profileFor(viaGateway, 'jev')).toBe('jev-gateway');
    expect(jevKeyVariable(viaGateway.judges[profileFor(viaGateway, 'jev')!])).toBe('AI_GATEWAY_API_KEY');
    expect(choose(viaGateway, 'jev').tiers).toEqual(['jev-gateway']);
    expect(kindOf(viaGateway.judges.laya)).toBe('local');
    expect(kindOf(viaGateway.judges.mock)).toBeUndefined();
  });

  it('reads the service of a Jev profile from its type and the variable of its key', () => {
    const judges = settings().judges;
    const systemOne = (apiKeyEnv: string) => ({ ...judges.jev, type: 'typesafe' as const, apiKeyEnv });
    expect(serviceOf(judges.jev)).toBe('auto');
    expect(serviceOf(judges['jev-gateway'])).toBe('gateway');
    expect(serviceOf(systemOne('TYPESAFE_API_KEY'))).toBe('typesafe');
    expect(serviceOf(systemOne('MU_JUDGE_OPENROUTER_API_KEY'))).toBe('openrouter');
    expect(serviceOf(systemOne('MU_JUDGE_CUSTOM_API_KEY'))).toBe('custom');
    // A TypeSafe key under a name of its own, or none named, is still TypeSafe's.
    expect(serviceOf(systemOne('KYRN_JUDGE_TYPESAFE'))).toBe('typesafe');
    expect(serviceOf(systemOne(''))).toBe('typesafe');
    expect(serviceOf(judges.laya)).toBeUndefined();
    expect(serviceOf(undefined)).toBeUndefined();
    // Every service is Jev to the choice above, and has a model its own profile starts with.
    for (const service of JEV_SERVICES) {
      const made = withJevService(settings(), 1, service);
      expect(kindOf(made.judges[made.tiers[1]]), service).toBe('jev');
      expect(defaultModelOf(service), service).toBeTruthy();
    }
    expect(choiceOf(withJevService(settings({ tiers: ['jev'] }), 0, 'custom'))).toBe('jev');
  });

  it('puts the profile of the service picked in its place in the order, made from its preset when there is none', () => {
    // The built-in one is used as it is.
    expect(withJevService(settings(), 1, 'gateway').tiers).toEqual(['laya', 'jev-gateway']);
    expect(withJevService(settings({ tiers: ['jev-gateway', 'laya'] }), 0, 'auto').tiers).toEqual(['jev', 'laya']);
    const changed = settings();
    const byHand = {
      ...changed,
      judges: { ...changed.judges, 'jev-gateway': { ...changed.judges['jev-gateway'], model: 'typesafe-ai/jev-2' } },
    };
    expect(withJevService(byHand, 1, 'gateway').judges['jev-gateway'].model).toBe('typesafe-ai/jev-2');
    // None yet: made from the preset, and the profile it replaces stays as it was.
    const direct = withJevService(settings(), 1, 'typesafe');
    expect(direct.tiers).toEqual(['laya', 'jev-direct']);
    expect(direct.judges['jev-direct']).toEqual({
      type: 'typesafe',
      model: 'jev-latest',
      baseUrl: '',
      apiKeyEnv: 'TYPESAFE_API_KEY',
      timeoutMs: 10000,
    });
    expect(direct.judges.jev).toEqual(settings().judges.jev);
    const openRouter = withJevService(settings(), 1, 'openrouter');
    expect(openRouter.tiers).toEqual(['laya', 'jev-openrouter']);
    expect(openRouter.judges['jev-openrouter']).toEqual({
      type: 'typesafe',
      model: '~typesafe/jev-latest',
      baseUrl: 'https://openrouter.ai/api/v1/systemone',
      apiKeyEnv: 'MU_JUDGE_OPENROUTER_API_KEY',
      timeoutMs: 10000,
    });
    // A custom service has no address until one is typed.
    const custom = withJevService(settings(), 1, 'custom');
    expect(custom.tiers).toEqual(['laya', 'jev-custom']);
    expect(custom.judges['jev-custom']).toMatchObject({
      type: 'typesafe',
      baseUrl: '',
      apiKeyEnv: 'MU_JUDGE_CUSTOM_API_KEY',
    });
    // A custom service someone set up under a name of their own is the one picked again, with its address.
    const relay = {
      type: 'typesafe' as const,
      model: 'jev-latest',
      baseUrl: 'http://192.168.1.20:8000/v1/systemone',
      apiKeyEnv: 'MU_JUDGE_CUSTOM_API_KEY',
      timeoutMs: 10000,
    };
    const own = withJevService(settings({ judges: { ...settings().judges, relay } }), 1, 'custom');
    expect(own.tiers).toEqual(['laya', 'relay']);
    expect(own.judges['jev-custom']).toBeUndefined();
    // A profile of another service written by hand under the built-in name is left alone.
    const taken = settings({
      judges: { ...settings().judges, 'jev-custom': { ...relay, apiKeyEnv: 'MU_JUDGE_OPENROUTER_API_KEY' } },
    });
    const beside = withJevService(taken, 1, 'custom');
    expect(beside.tiers).toEqual(['laya', 'jev-custom-2']);
    expect(beside.judges['jev-custom']).toEqual(taken.judges['jev-custom']);
    expect(serviceOf(beside.judges['jev-custom-2'])).toBe('custom');
  });

  it('changes nothing for the service a judge already has, and never asks the same profile twice', () => {
    const same = settings();
    expect(withJevService(same, 1, 'auto')).toBe(same);
    // Not a judge in the order: nothing to change.
    expect(withJevService(same, 5, 'gateway')).toBe(same);
    // Two Jevs would be the same profile: the second goes.
    expect(withJevService(settings({ tiers: ['jev', 'jev-gateway'] }), 1, 'auto').tiers).toEqual(['jev']);
    const twice = withJevService(settings({ tiers: ['jev-gateway', 'jev'] }), 1, 'gateway');
    expect(twice.tiers).toEqual(['jev-gateway']);
  });

  it('carries no address and no key over to another service', () => {
    const typed = settings();
    const addressed = {
      ...typed,
      tiers: ['jev-direct'],
      judges: {
        ...typed.judges,
        'jev-direct': {
          type: 'typesafe' as const,
          model: 'jev-latest',
          baseUrl: 'http://192.168.1.20:8000/v1/systemone',
          apiKeyEnv: 'TYPESAFE_API_KEY',
          timeoutMs: 10000,
        },
      },
    };
    // A TypeSafe address is no custom service's, nor OpenRouter's.
    const custom = withJevService(addressed, 0, 'custom');
    expect(custom.judges['jev-custom'].baseUrl).toBe('');
    expect(jevKeyVariable(custom.judges[custom.tiers[0]])).toBe('MU_JUDGE_CUSTOM_API_KEY');
    const openRouter = withJevService(addressed, 0, 'openrouter');
    expect(openRouter.judges['jev-openrouter'].baseUrl).toBe('https://openrouter.ai/api/v1/systemone');
    expect(jevKeyVariable(openRouter.judges[openRouter.tiers[0]])).toBe('MU_JUDGE_OPENROUTER_API_KEY');
    // The profile left behind keeps its own address for when it is picked again.
    expect(custom.judges['jev-direct'].baseUrl).toBe('http://192.168.1.20:8000/v1/systemone');
    const back = withJevService(custom, 0, 'typesafe');
    expect(back.tiers).toEqual(['jev-direct']);
    expect(back.judges['jev-direct'].baseUrl).toBe('http://192.168.1.20:8000/v1/systemone');
    // Each service's key stays in its own variable.
    expect(jevKeyVariable(withJevService(addressed, 0, 'gateway').judges['jev-gateway'])).toBe('AI_GATEWAY_API_KEY');
    expect(jevKeyVariable(withJevService(addressed, 0, 'auto').judges.jev)).toBe('TYPESAFE_API_KEY');
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
