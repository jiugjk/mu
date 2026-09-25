import {
  Book,
  Brain,
  Browser,
  Comments,
  Cpu,
  DocDetail,
  Gavel,
  History,
  Inbox,
  Info,
  Keyboard,
  LinkCloud,
  Login,
  MoreApp,
  Notes,
  Peoples,
  PeoplesTwo,
  Platte,
  Refresh,
  SwitchButton,
  System,
  User,
  Terminal,
  Tool,
  Toolkit,
} from '@icon-park/react';

/**
 * The settings rail: seven groups of short pages. No page holds more than twelve rows: a list that would run longer is
 * split into entries, and a group that would get too many entries hands the rest to a group of its own (the decision
 * points and the more features each have one). Never one long page, never a collapsed "advanced" part. Every entry is
 * its own route, `/settings/<id>`; pages that used to exist land on the one that holds their settings now (see
 * {@link RETIRED_SETTINGS_PATHS}).
 */
export type SettingsGroupId =
  | 'preferences'
  | 'models'
  | 'kernel'
  | 'decisions'
  | 'more-features'
  | 'capabilities'
  | 'system';

export type SettingsGroup = {
  id: SettingsGroupId;
  /** i18n key of the group's muted header in the rail. */
  labelKey: string;
};

export const SETTINGS_GROUPS = [
  { id: 'preferences', labelKey: 'settings.groups.preferences' },
  { id: 'models', labelKey: 'settings.groups.models' },
  { id: 'kernel', labelKey: 'settings.groups.kernel' },
  { id: 'decisions', labelKey: 'mu.sections.decisions' },
  { id: 'more-features', labelKey: 'mu.sections.moreFeatures' },
  { id: 'capabilities', labelKey: 'settings.groups.capabilities' },
  { id: 'system', labelKey: 'settings.groups.system' },
] as const satisfies readonly SettingsGroup[];

/**
 * The decision points' pages, one per group the harness puts them in. The experience library's points (the lessons)
 * are a page of their own: together with the rest of the context group they would run past twelve rows.
 */
export const DECISION_PAGES = ['input', 'context', 'memory', 'tools', 'turn', 'team'] as const;
export type DecisionPage = (typeof DECISION_PAGES)[number];

/** The pages of the features past the featured six, one per group; `other` takes every feature the others do not. */
export const FEATURE_PAGES = ['input', 'context', 'tools', 'turn', 'other'] as const;
export type FeaturePage = (typeof FEATURE_PAGES)[number];

export type SettingsPageId =
  | 'appearance'
  | 'system'
  | 'conversations'
  | 'providers'
  | 'default-model'
  | 'judges'
  | 'features'
  | 'personality'
  | `decisions-${DecisionPage}`
  | `more-features-${FeaturePage}`
  | 'skills'
  | 'tools'
  | 'assistants'
  | 'browser'
  | 'archived'
  | 'about';

export type SettingsPage = {
  id: SettingsPageId;
  group: SettingsGroupId;
  /** Route segment under `/settings/`. */
  path: SettingsPageId;
  /** The whole route: `/settings/<path>`. */
  route: `/settings/${SettingsPageId}`;
  /**
   * i18n key of the page's name where it stands alone — its title, the command palette, the phone's row of chips —
   * so it never needs its group to be understood.
   */
  labelKey: string;
  /** i18n key of the shorter label the rail shows under its group's header, when the group already says the rest. */
  railLabelKey?: string;
  Icon: unknown;
};

/** The rail's short name of a decision-point or more-features page: the group it shows. */
export const pageGroupLabelKey = (page: DecisionPage | FeaturePage): string =>
  page === 'other' ? 'mu.decisions.otherGroup' : `mu.decisions.groups.${page}`;

const DECISION_ICONS: Record<DecisionPage, unknown> = {
  input: Login,
  context: DocDetail,
  memory: Brain,
  tools: Tool,
  turn: Refresh,
  team: PeoplesTwo,
};

const FEATURE_ICONS: Record<FeaturePage, unknown> = {
  input: Keyboard,
  context: Notes,
  tools: Terminal,
  turn: History,
  other: MoreApp,
};

const decisionsEntry = (page: DecisionPage): SettingsPage => ({
  id: `decisions-${page}`,
  group: 'decisions',
  path: `decisions-${page}`,
  route: `/settings/decisions-${page}`,
  labelKey: `mu.pages.decisions.${page}`,
  railLabelKey: pageGroupLabelKey(page),
  Icon: DECISION_ICONS[page],
});

const moreFeaturesEntry = (page: FeaturePage): SettingsPage => ({
  id: `more-features-${page}`,
  group: 'more-features',
  path: `more-features-${page}`,
  route: `/settings/more-features-${page}`,
  labelKey: `mu.pages.features.${page}`,
  railLabelKey: pageGroupLabelKey(page),
  Icon: FEATURE_ICONS[page],
});

/** Every entry of the rail, flat and in display order; `group` says which header it sits under. */
export const SETTINGS_PAGES = [
  {
    id: 'appearance',
    group: 'preferences',
    path: 'appearance',
    route: '/settings/appearance',
    labelKey: 'settings.appearancePanel',
    Icon: Platte,
  },
  {
    id: 'system',
    group: 'preferences',
    path: 'system',
    route: '/settings/system',
    labelKey: 'settings.system',
    Icon: System,
  },
  {
    id: 'conversations',
    group: 'preferences',
    path: 'conversations',
    route: '/settings/conversations',
    labelKey: 'settings.conversations',
    Icon: Comments,
  },
  {
    id: 'providers',
    group: 'models',
    path: 'providers',
    route: '/settings/providers',
    labelKey: 'mu.sections.providers',
    Icon: LinkCloud,
  },
  {
    id: 'default-model',
    group: 'models',
    path: 'default-model',
    route: '/settings/default-model',
    labelKey: 'mu.sections.defaultModel',
    Icon: Cpu,
  },
  // The judge to ask, and under it the order of several judges and every field of each.
  {
    id: 'judges',
    group: 'kernel',
    path: 'judges',
    route: '/settings/judges',
    labelKey: 'mu.sections.judges',
    Icon: Gavel,
  },
  {
    id: 'features',
    group: 'kernel',
    path: 'features',
    route: '/settings/features',
    labelKey: 'mu.sections.features',
    Icon: SwitchButton,
  },
  {
    id: 'personality',
    group: 'kernel',
    path: 'personality',
    route: '/settings/personality',
    labelKey: 'mu.sections.personality',
    Icon: User,
  },
  // The decision points' context page holds the compaction settings too: one page for context.
  ...DECISION_PAGES.map(decisionsEntry),
  ...FEATURE_PAGES.map(moreFeaturesEntry),
  {
    id: 'skills',
    group: 'capabilities',
    path: 'skills',
    route: '/settings/skills',
    labelKey: 'settings.skills',
    Icon: Book,
  },
  {
    id: 'tools',
    group: 'capabilities',
    path: 'tools',
    route: '/settings/tools',
    labelKey: 'settings.tools',
    Icon: Toolkit,
  },
  {
    id: 'assistants',
    group: 'capabilities',
    path: 'assistants',
    route: '/settings/assistants',
    labelKey: 'settings.assistants',
    Icon: Peoples,
  },
  {
    id: 'browser',
    group: 'capabilities',
    path: 'browser',
    route: '/settings/browser',
    labelKey: 'settings.browserData.title',
    Icon: Browser,
  },
  {
    id: 'archived',
    group: 'system',
    path: 'archived',
    route: '/settings/archived',
    labelKey: 'settings.archived.navLabel',
    Icon: Inbox,
  },
  { id: 'about', group: 'system', path: 'about', route: '/settings/about', labelKey: 'settings.about', Icon: Info },
] as const satisfies readonly SettingsPage[];

/** Where the settings open from the sidebar: the first page of the models group, what a new user sets up first. */
export const SETTINGS_HOME = '/settings/providers';

/**
 * The options of the permission modes feature, which hold the mode a new conversation starts in. The feature acts at
 * the tools and safety decision points, so its switch is on that page of the more features.
 */
const PERMISSION_MODE_PAGE = '/settings/more-features-tools/permissions';

/**
 * Every settings route that no longer exists, and the page that took it over. Old links — a deep link, a button
 * elsewhere in the app, the six pages of the previous settings — land here with their query string kept.
 */
export const RETIRED_SETTINGS_PATHS: Record<string, string> = {
  // The six pages before the rail had groups.
  '/settings/models': '/settings/providers',
  '/settings/kernel': '/settings/judges',
  // The decision points and the other features were one page each before they got a group of their own.
  '/settings/decisions': '/settings/decisions-input',
  '/settings/more-features': '/settings/more-features-input',
  // mu's own sections when they lived under /settings/kyrn.
  '/settings/kyrn': '/settings/providers',
  '/settings/kyrn/models': '/settings/providers',
  '/settings/kyrn/permissions': PERMISSION_MODE_PAGE,
  '/settings/kyrn/judges': '/settings/judges',
  '/settings/kyrn/decisions': '/settings/decisions-input',
  '/settings/kyrn/features': '/settings/features',
  '/settings/kyrn/context': '/settings/decisions-context',
  '/settings/kyrn/:section': '/settings/providers',
  '/settings/model': '/settings/providers',
  // Runtime agents and the top-level assistants page: the assistants.
  '/settings/agent': '/settings/assistants',
  '/settings/agent/:id/repair': '/settings/assistants',
  '/assistants': '/settings/assistants',
  '/settings/skills-hub': '/settings/skills',
  '/settings/capabilities': '/settings/skills',
  '/settings/capabilities/skills/import-history': '/settings/skills/import-history',
  '/settings/display': '/settings/appearance',
  // Pages folded into others: the judge tiers are on the judges page, the compaction settings on the context page,
  // and the mode of a new conversation is an option of the permission modes feature.
  '/settings/judge-tiers': '/settings/judges',
  '/settings/context': '/settings/decisions-context',
  '/settings/permissions': PERMISSION_MODE_PAGE,
  // The web server mu no longer runs, the voice input and the desktop pet it no longer has: the page each sat next to.
  '/settings/webui': '/settings/system',
  '/settings/voice': '/settings/system',
  '/settings/pet': '/settings/appearance',
};

/**
 * Pages that used to hold other pages as tabs: `?tab=` names the page that holds that tab now. The skills page is
 * still a page of its own, so its link without a tab stays where it is.
 */
export const MOVED_SETTINGS_TABS: Record<string, Record<string, string>> = {
  '/settings/skills': { skills: '/settings/skills', tools: '/settings/tools', agents: '/settings/assistants' },
  '/settings/capabilities': { skills: '/settings/skills', tools: '/settings/tools' },
};

/** `target` with the query of the old link merged in: the old link's own parameters win over the target's. */
function withQuery(target: string, params: URLSearchParams): string {
  const [path, query] = target.split('?');
  const merged = new URLSearchParams(query);
  for (const [key, value] of params) merged.set(key, value);
  const text = merged.toString();
  return text ? `${path}?${text}` : path;
}

/**
 * Where a link to a page that took its tabs apart goes: the page that holds the named tab now, with every other
 * parameter kept. Undefined when the link names no tab that moved.
 */
export function movedSettingsTab(path: string, search: string): string | undefined {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  const target = tab ? MOVED_SETTINGS_TABS[path]?.[tab] : undefined;
  if (!target) return undefined;
  params.delete('tab');
  return withQuery(target, params);
}

/** Where a retired settings route (a key of {@link RETIRED_SETTINGS_PATHS}) sends a link, query string included. */
export function retiredSettingsTarget(from: string, search: string): string {
  return (
    movedSettingsTab(from, search) ??
    withQuery(RETIRED_SETTINGS_PATHS[from] ?? SETTINGS_HOME, new URLSearchParams(search))
  );
}

/**
 * The settings entry an extension anchored itself to, resolved to a page that exists now. An extension that names a
 * page that never existed keeps its own name and ends up unanchored, as before.
 */
export const SETTINGS_ANCHOR_REMAP: Record<string, SettingsPageId> = {
  models: 'providers',
  kernel: 'judges',
  decisions: 'decisions-input',
  'more-features': 'more-features-input',
  'mu-models': 'providers',
  'mu-permissions': 'more-features-tools',
  'mu-judges': 'judges',
  'mu-decisions': 'decisions-input',
  'mu-features': 'features',
  'mu-context': 'decisions-context',
  'judge-tiers': 'judges',
  context: 'decisions-context',
  permissions: 'more-features-tools',
  kyrn: 'providers',
  model: 'providers',
  agent: 'assistants',
  'skills-hub': 'skills',
  capabilities: 'skills',
  display: 'appearance',
  webui: 'system',
  voice: 'system',
  pet: 'appearance',
};

/** The entries whose sub-pages are one feature's options each: `<route>/<feature>`, and `/<part>` past the first. */
export const FEATURE_LIST_PAGES: readonly SettingsPageId[] = [
  'features',
  ...FEATURE_PAGES.map((page): SettingsPageId => `more-features-${page}`),
];

/** Whether `pathname` is the page at `route` or one of its own sub-pages (a skill's detail, a feature's options). */
export const isSettingsRouteActive = (pathname: string, route: string): boolean =>
  pathname === route || pathname.startsWith(`${route}/`);
