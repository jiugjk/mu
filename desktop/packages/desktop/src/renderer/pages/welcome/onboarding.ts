import {
  isPrivateNetworkHost,
  isSafeEndpoint,
  PROVIDER_ID,
  RESERVED_PROVIDER_IDS,
  suggestProviderId,
  type EndpointType,
} from '@/common/kyrn/models';
import type { KyrnSettings } from '@/common/kyrn/types';
import type { Draft } from '@/renderer/pages/settings/KyrnSettings/draft';
import { blankModel, blankProvider } from '@/renderer/pages/settings/KyrnSettings/providers/endpoints';

/**
 * The first-run guide: a model, a judge, done. It is shown once, to someone who has no startup model yet; it is
 * marked seen when it is finished or skipped, and can be opened again from the models settings.
 */
export const ONBOARDING_KEY = 'mu.onboarding.v1';

export function onboardingSeen(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try {
    return Boolean(storage?.getItem(ONBOARDING_KEY));
  } catch {
    // No storage (a locked-down profile): never nag.
    return true;
  }
}

export function markOnboardingSeen(storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(ONBOARDING_KEY, new Date().toISOString());
  } catch {
    // Nothing to do: the guide just shows again next time.
  }
}

/** Someone new: nothing tells mu which model to start with. */
export const needsOnboarding = (settings: KyrnSettings): boolean => !settings.models.defaults.provider;

/** The wire formats the guide offers (OpenAI's two, Anthropic's); Google's is in the provider settings. */
export type GuideApi = Extract<EndpointType, 'openai-completions' | 'openai-responses' | 'anthropic-messages'>;

export type ApiModel = { api: GuideApi; baseUrl: string; key: string; model: string };

const isLoopback = (baseUrl: string): boolean => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
};

/** What is wrong with the typed endpoint, or undefined. A key may stay empty only for a service on this machine. */
export function apiModelProblem(input: ApiModel): 'baseUrl' | 'key' | 'model' | undefined {
  if (!isSafeEndpoint(input.baseUrl.trim())) return 'baseUrl';
  if (!input.key.trim() && !isLoopback(input.baseUrl.trim())) return 'key';
  if (!input.model.trim()) return 'model';
  return undefined;
}

/** The word of a host a provider is named after: `deepseek` of `api.deepseek.com`, or '' when it has none. */
function hostWord(hostname: string): string {
  const label = hostname.split('.').find((part) => !['api', 'www'].includes(part));
  const word = suggestProviderId(label ?? '');
  return word && PROVIDER_ID.test(word) ? word : '';
}

/**
 * A readable id from the address: `https://api.deepseek.com/v1` -> `deepseek`, or `deepseek-custom` when pi has a
 * built-in provider of that name (a models.json entry under a built-in id reroutes it instead of adding one).
 */
export function providerIdFor(baseUrl: string, taken: ReadonlySet<string>): string {
  let base = 'custom';
  try {
    const host = new URL(baseUrl).hostname;
    // A numeric LAN address is not a name (`192` of 192.168.x.x). Call it local, and show the host as the label.
    if (isLoopback(baseUrl) || isPrivateNetworkHost(host)) base = 'local';
    else base = hostWord(host) || base;
  } catch {
    // An address that does not parse is caught by the check before this is ever called.
  }
  const free = (id: string) => !taken.has(id) && !RESERVED_PROVIDER_IDS.has(id) && PROVIDER_ID.test(id);
  if (free(base)) return base;
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? `${base}-custom` : `${base}-custom-${n}`;
    if (free(id)) return id;
  }
}

/**
 * The display name of the provider the guide adds, which the provider settings and the guide's summary show: the id
 * when it is the address's own word (`moonshot`), else the address's host (`localhost:11434`, or `api.deepseek.com`
 * beside pi's own deepseek). An id like `local` or `deepseek-custom` is English words, and a name is read in any
 * language.
 */
export function providerNameFor(baseUrl: string, id: string): string {
  try {
    const url = new URL(baseUrl);
    if (!isLoopback(baseUrl) && id === hostWord(url.hostname)) return id;
    // The store takes a name of at most 80 characters.
    return url.host.slice(0, 80) || id;
  } catch {
    return id;
  }
}

/**
 * The draft with the typed endpoint as a new provider and its model as the startup model. `previous` is the id the
 * guide added the last time through (going back and changing the address must not leave a second provider behind).
 */
export function withApiModel(draft: Draft, input: ApiModel, previous?: string): { draft: Draft; id: string } {
  const models = draft.settings.models;
  const kept = models.providers.filter((provider) => !(provider.isNew && provider.id === previous));
  const id = providerIdFor(input.baseUrl.trim(), new Set(kept.map((provider) => provider.id)));
  const provider = {
    ...blankProvider(id),
    name: providerNameFor(input.baseUrl.trim(), id),
    api: input.api,
    baseUrl: input.baseUrl.trim(),
    models: [{ ...blankModel(input.model.trim()), name: input.model.trim() }],
  };
  const { [previous ?? '']: _dropped, ...providerKeys } = draft.providerKeys;
  return {
    id,
    draft: {
      ...draft,
      providerKeys: input.key.trim() ? { ...providerKeys, [id]: input.key.trim() } : providerKeys,
      settings: {
        ...draft.settings,
        models: {
          ...models,
          providers: [...kept, provider],
          defaults: { ...models.defaults, provider: id, model: input.model.trim() },
        },
      },
    },
  };
}

/** The draft with a model of an account mu is already signed in to as the startup model. */
export function withSignedInModel(draft: Draft, provider: string, model: string, previous?: string): Draft {
  const models = draft.settings.models;
  const kept = models.providers.filter((entry) => !(entry.isNew && entry.id === previous));
  const { [previous ?? '']: _dropped, ...providerKeys } = draft.providerKeys;
  return {
    ...draft,
    providerKeys,
    settings: {
      ...draft.settings,
      models: { ...models, providers: kept, defaults: { ...models.defaults, provider, model } },
    },
  };
}
