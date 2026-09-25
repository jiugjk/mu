import type { JudgeSettings, JudgeType, KyrnSettings } from '@/common/kyrn/types';

/**
 * The two kinds of judge a person chooses between: Jev, or Laya on this machine. The profiles behind them (jev,
 * jev-direct, jev-gateway, laya) are how the config keeps them; the tiers page shows them by these two names, and a
 * Jev profile as the way it reaches Jev. Anything else (a model as judge, a mock, a self-hosted HTTP judge) is only
 * named there, by the name it was given.
 */
export type JudgeChoice = 'jev' | 'local';

export const JUDGE_CHOICES: readonly JudgeChoice[] = ['jev', 'local'];

const KIND_OF: Record<JudgeType, JudgeChoice | undefined> = {
  jev: 'jev',
  typesafe: 'jev',
  gateway: 'jev',
  local: 'local',
  llm: undefined,
  http: undefined,
  mock: undefined,
};

/** The profile a choice prefers when several of its kind exist: the built-in names. */
const PREFERRED: Record<JudgeChoice, string> = { jev: 'jev', local: 'laya' };

/** Which of the two a profile is; undefined for a model as judge, a self-hosted judge or the mock. */
export const kindOf = (judge: JudgeSettings | undefined): JudgeChoice | undefined =>
  judge ? KIND_OF[judge.type] : undefined;

/**
 * The ways Jev can be reached, each kept as a profile of its own under a built-in name: chosen by the key that is
 * set, always TypeSafe directly, always through the Vercel AI Gateway.
 */
export const JEV_ACCESS = ['jev', 'typesafe', 'gateway'] as const satisfies readonly JudgeType[];
export type JevAccess = (typeof JEV_ACCESS)[number];
const ACCESS_PROFILE: Record<JevAccess, string> = { jev: 'jev', typesafe: 'jev-direct', gateway: 'jev-gateway' };

/** Where the key of a Jev profile is kept when the profile names none. */
export const JEV_KEY_VARIABLE = 'TYPESAFE_API_KEY';

/** What the first judge asked is: the choice shown as selected. Undefined for a mock or a self-hosted judge. */
export function choiceOf(settings: KyrnSettings): JudgeChoice | undefined {
  const first = settings.judges[settings.tiers[0]];
  return first ? KIND_OF[first.type] : undefined;
}

/**
 * The profile a choice stands for: the one of that kind the order already asks (so Jev's key is the one its way in
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
 * The settings with the judge at `index` of the order reaching Jev by `access`: the profile of that way takes its
 * place (the built-in one, else the first of that type), and is not asked twice. Without such a profile, the judge's
 * own profile changes its type, and leaves behind an address that belonged to the old way in: a TypeSafe URL is no
 * gateway, nor the other way round.
 */
export function withJevAccess(settings: KyrnSettings, index: number, access: JevAccess): KyrnSettings {
  const current = settings.tiers[index];
  if (current === undefined || settings.judges[current]?.type === access) return settings;
  const builtIn = ACCESS_PROFILE[access];
  const profile =
    settings.judges[builtIn]?.type === access
      ? builtIn
      : Object.keys(settings.judges).find((name) => settings.judges[name].type === access);
  if (!profile)
    return {
      ...settings,
      judges: { ...settings.judges, [current]: { ...settings.judges[current], type: access, baseUrl: '' } },
    };
  const tiers = settings.tiers.map((name, at) => (at === index ? profile : name));
  return { ...settings, tiers: tiers.filter((name, at) => tiers.indexOf(name) === at) };
}

/** The variable a Jev profile's key lives in. */
export const jevKeyVariable = (judge: JudgeSettings | undefined): string => judge?.apiKeyEnv || JEV_KEY_VARIABLE;
