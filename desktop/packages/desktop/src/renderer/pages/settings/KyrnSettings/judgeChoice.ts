import { CLM_KEY_VARIABLE } from '@/common/kyrn/clm';
import type { JudgeSettings, JudgeType, KyrnSettings } from '@/common/kyrn/types';

/**
 * The three kinds of judge a person chooses between: Jev, Laya on this machine, or CLM on a server of their own. The
 * profiles behind them (jev, jev-direct, jev-openrouter, jev-gateway, jev-custom, laya, clm) are how the config keeps
 * them; the tiers page shows them by these three names, and a Jev profile by the service it reaches Jev through.
 * Anything else (a model as judge, a mock, a self-hosted HTTP judge) is only named there, by the name it was given.
 */
export type JudgeChoice = 'jev' | 'local' | 'clm';

export const JUDGE_CHOICES: readonly JudgeChoice[] = ['jev', 'local', 'clm'];
/** The choices of the first-run guide. CLM needs a server with a GPU someone already runs: it waits in the settings. */
export const GUIDE_CHOICES: readonly JudgeChoice[] = ['jev', 'local'];

const KIND_OF: Record<JudgeType, JudgeChoice | undefined> = {
  jev: 'jev',
  typesafe: 'jev',
  gateway: 'jev',
  local: 'local',
  clm: 'clm',
  llm: undefined,
  http: undefined,
  mock: undefined,
};

/** The profile a choice prefers when several of its kind exist: the built-in names. */
const PREFERRED: Record<JudgeChoice, string> = { jev: 'jev', local: 'laya', clm: 'clm' };

/** Which of the three a profile is; undefined for a model as judge, a self-hosted HTTP judge or the mock. */
export const kindOf = (judge: JudgeSettings | undefined): JudgeChoice | undefined =>
  judge ? KIND_OF[judge.type] : undefined;

/**
 * The services Jev is reached through, each kept as a profile of its own: chosen by the key that is set (TypeSafe's,
 * else OpenRouter's, else the Vercel AI Gateway's), TypeSafe directly, OpenRouter, the Vercel AI Gateway, or an
 * address of the person's own that speaks TypeSafe's System One protocol. A profile's service follows from its type
 * and the variable of its key; nothing stores it.
 */
export const JEV_SERVICES = ['auto', 'typesafe', 'openrouter', 'gateway', 'custom'] as const;
export type JevService = (typeof JEV_SERVICES)[number];

/** Where the key of a Jev profile is kept when the profile names none. */
export const JEV_KEY_VARIABLE = 'TYPESAFE_API_KEY';
const OPENROUTER_KEY_VARIABLE = 'MU_JUDGE_OPENROUTER_API_KEY';
const CUSTOM_KEY_VARIABLE = 'MU_JUDGE_CUSTOM_API_KEY';

type Preset = Omit<JudgeSettings, 'timeoutMs'>;

/**
 * Each service's profile: the store's and the harness's built-in one under its name, or for a custom service
 * jev-custom, which this page makes when it is first chosen. A missing profile is made from the preset.
 */
const SERVICE_PROFILES: Record<JevService, { name: string; preset: Preset }> = {
  auto: { name: 'jev', preset: { type: 'jev', model: 'jev-latest', baseUrl: '', apiKeyEnv: JEV_KEY_VARIABLE } },
  typesafe: {
    name: 'jev-direct',
    preset: { type: 'typesafe', model: 'jev-latest', baseUrl: '', apiKeyEnv: JEV_KEY_VARIABLE },
  },
  openrouter: {
    name: 'jev-openrouter',
    preset: {
      type: 'typesafe',
      model: '~typesafe/jev-latest',
      baseUrl: 'https://openrouter.ai/api/v1/systemone',
      apiKeyEnv: OPENROUTER_KEY_VARIABLE,
    },
  },
  gateway: {
    name: 'jev-gateway',
    preset: { type: 'gateway', model: 'typesafe-ai/jev', baseUrl: '', apiKeyEnv: 'AI_GATEWAY_API_KEY' },
  },
  custom: {
    name: 'jev-custom',
    preset: { type: 'typesafe', model: 'jev-latest', baseUrl: '', apiKeyEnv: CUSTOM_KEY_VARIABLE },
  },
};

/** The timeout the store reads for a profile that names none. */
const TIMEOUT_MS = 10000;

/** What the first judge asked is: the choice shown as selected. Undefined for a mock or a self-hosted judge. */
export function choiceOf(settings: KyrnSettings): JudgeChoice | undefined {
  const first = settings.judges[settings.tiers[0]];
  return first ? KIND_OF[first.type] : undefined;
}

/**
 * The profile a choice stands for: the one of that kind the order already asks (so Jev's key is the one its service
 * needs), else the one with the built-in name, else the first of that kind.
 */
export function profileFor(settings: KyrnSettings, choice: JudgeChoice): string | undefined {
  const asked = settings.tiers.find((name) => kindOf(settings.judges[name]) === choice);
  if (asked) return asked;
  const preferred = settings.judges[PREFERRED[choice]];
  if (preferred && KIND_OF[preferred.type] === choice) return PREFERRED[choice];
  return Object.keys(settings.judges).find((name) => KIND_OF[settings.judges[name].type] === choice);
}

/**
 * The settings with `choice` as the one judge. A cascade someone built by hand is replaced: the simple view has one
 * judge, the advanced view has the order.
 */
export function choose(settings: KyrnSettings, choice: JudgeChoice): KyrnSettings {
  const existing = profileFor(settings, choice);
  return existing ? { ...settings, tiers: [existing] } : settings;
}

/**
 * The service a Jev profile reaches Jev through, read from its type and the variable of its key: a System One profile
 * keyed for OpenRouter or for a service of the person's own is that one, any other is TypeSafe. Undefined for a judge
 * that is not Jev.
 */
export function serviceOf(judge: JudgeSettings | undefined): JevService | undefined {
  if (judge?.type === 'jev') return 'auto';
  if (judge?.type === 'gateway') return 'gateway';
  if (judge?.type !== 'typesafe') return undefined;
  if (judge.apiKeyEnv === OPENROUTER_KEY_VARIABLE) return 'openrouter';
  return judge.apiKeyEnv === CUSTOM_KEY_VARIABLE ? 'custom' : 'typesafe';
}

/** The model a service's own profile starts with: shown where the model is typed while it is empty. */
export const defaultModelOf = (service: JevService): string => SERVICE_PROFILES[service].preset.model;

/**
 * The settings with the judge at `index` of the order reaching Jev through `service`: that service's profile takes its
 * place (the built-in one, else the first of that service, else one made from the service's preset), and is not asked
 * twice. Nothing of the profile it replaces comes along: an address and a key belong to their own service (a TypeSafe
 * URL is no OpenRouter URL, and an OpenRouter key goes to OpenRouter only).
 */
export function withJevService(settings: KyrnSettings, index: number, service: JevService): KyrnSettings {
  const current = settings.tiers[index];
  if (current === undefined || serviceOf(settings.judges[current]) === service) return settings;
  const { name: builtIn, preset } = SERVICE_PROFILES[service];
  const fits = (name: string) => serviceOf(settings.judges[name]) === service;
  const existing = fits(builtIn) ? builtIn : Object.keys(settings.judges).find(fits);
  if (existing) return askedAt(settings, index, existing);
  // Made under the built-in name, unless a profile of another service written by hand has it: that one stays as it is.
  let name = builtIn;
  for (let number = 2; name in settings.judges; number++) name = `${builtIn}-${number}`;
  const judges = { ...settings.judges, [name]: { ...preset, timeoutMs: TIMEOUT_MS } };
  return askedAt({ ...settings, judges }, index, name);
}

/** The settings with `profile` asked at `index` of the order, and nowhere else. */
function askedAt(settings: KyrnSettings, index: number, profile: string): KyrnSettings {
  const tiers = settings.tiers.map((name, at) => (at === index ? profile : name));
  return { ...settings, tiers: tiers.filter((name, at) => tiers.indexOf(name) === at) };
}

/** The variable a Jev profile's key lives in. */
export const jevKeyVariable = (judge: JudgeSettings | undefined): string => judge?.apiKeyEnv || JEV_KEY_VARIABLE;

/** The variable a CLM profile's key lives in: needed only by a server started with CLM_API_KEY. */
export const clmKeyVariable = (judge: JudgeSettings | undefined): string => judge?.apiKeyEnv || CLM_KEY_VARIABLE;
