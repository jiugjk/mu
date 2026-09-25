/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The settings rail is seven groups of short pages, and every place that used to be a page of its own still leads to
 * the page that holds its settings now. Both halves are tested here: the rail a person sees, and the redirects the
 * router installs for the retired paths and for the tabs that became pages.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/renderer/hooks/system/useExtensionSettingsTabs', () => ({
  useExtensionSettingsTabs: () => extensionTabs,
}));

vi.mock('@/renderer/hooks/system/useExtI18n', () => ({
  useExtI18n: () => ({ resolveExtTabName: (tab: { name: string }) => tab.name }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  resolveExtensionAssetUrl: (url?: string) => url,
}));

// What the router module pulls in besides the redirects under test.
vi.mock('@/renderer/components/layout/AppLoader', () => ({ default: () => <span>Loading</span> }));
vi.mock('@/renderer/components/layout/DocumentTitle', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/system/useCrossSessionRateLimitNotice', () => ({ useCrossSessionRateLimitNotice: () => {} }));
vi.mock('@/renderer/pages/settings/KyrnSettings/StartupGate', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

let extensionTabs: { id: string; name: string; url: string; position?: unknown }[] = [];

import { RetiredSettingsPath, WithMovedTabs } from '@/renderer/components/layout/Router';
import SettingsSider, { BUILTIN_TAB_IDS } from '@/renderer/pages/settings/components/SettingsSider';
import {
  DECISION_PAGES,
  FEATURE_LIST_PAGES,
  FEATURE_PAGES,
  MOVED_SETTINGS_TABS,
  RETIRED_SETTINGS_PATHS,
  SETTINGS_ANCHOR_REMAP,
  SETTINGS_GROUPS,
  SETTINGS_HOME,
  SETTINGS_PAGES,
  isSettingsRouteActive,
  retiredSettingsTarget,
} from '@/renderer/pages/settings/settingsNav';

/** Where the router is now: path with query, and the navigation state that came along. */
function Here() {
  const { pathname, search, state } = useLocation();
  return <output data-testid='here' data-path={`${pathname}${search}`} data-state={JSON.stringify(state ?? null)} />;
}

const here = () => screen.getByTestId('here');

function renderRail(path = '/settings/providers') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsSider />
      <Here />
    </MemoryRouter>
  );
}

const railRows = (root: ParentNode) =>
  [...root.querySelectorAll('[data-settings-id]')].map((row) => row.getAttribute('data-settings-id'));

const groupRows = (container: HTMLElement) =>
  Object.fromEntries(
    [...container.querySelectorAll('[data-settings-group]')].map((group) => [
      group.getAttribute('data-settings-group'),
      railRows(group),
    ])
  );

describe('the settings rail', () => {
  beforeEach(() => {
    extensionTabs = [];
  });
  afterEach(() => cleanup());

  it('shows seven groups under muted headers, each with its pages in order', () => {
    const { container } = renderRail();
    const groups = [...container.querySelectorAll('[data-settings-group]')];
    expect(groups.map((group) => group.getAttribute('data-settings-group'))).toEqual([
      'preferences',
      'models',
      'kernel',
      'decisions',
      'more-features',
      'capabilities',
      'system',
    ]);
    // A header is a label, not a row: it names the group and cannot be clicked.
    expect(groups.map((group) => group.querySelector('.settings-sider__group-header')?.textContent)).toEqual(
      SETTINGS_GROUPS.map((group) => group.labelKey)
    );
    expect(screen.getByRole('group', { name: 'settings.groups.kernel' })).toBeInTheDocument();
    expect(groupRows(container)).toEqual({
      preferences: ['appearance', 'system', 'conversations'],
      models: ['providers', 'default-model'],
      kernel: ['judges', 'features', 'personality'],
      decisions: [
        'decisions-input',
        'decisions-context',
        'decisions-memory',
        'decisions-tools',
        'decisions-turn',
        'decisions-team',
      ],
      'more-features': [
        'more-features-input',
        'more-features-context',
        'more-features-tools',
        'more-features-turn',
        'more-features-other',
      ],
      capabilities: ['skills', 'tools', 'assistants', 'browser'],
      system: ['archived', 'about'],
    });
    // No group runs long: the decision points and the other features were given groups of their own for that.
    for (const group of Object.values(groupRows(container))) expect(group.length).toBeLessThanOrEqual(6);
    expect(BUILTIN_TAB_IDS).toEqual(railRows(container));
    // No web server page any more, and no collapsed "advanced" entry anywhere.
    expect(container.querySelector('[data-settings-id="webui"]')).toBeNull();
    expect(container.querySelector('[data-settings-id*="advanced"]')).toBeNull();
  });

  it('keeps a flat list of every page, with its route and group, in rail order', () => {
    const groupIds = SETTINGS_GROUPS.map((group) => group.id);
    for (const page of SETTINGS_PAGES) {
      expect(page.path).toBe(page.id);
      expect(page.route).toBe(`/settings/${page.path}`);
      expect(groupIds).toContain(page.group);
      expect(page.labelKey).toMatch(/\./);
    }
    expect(new Set(SETTINGS_PAGES.map((page) => page.route)).size).toBe(SETTINGS_PAGES.length);
    // Flat, but each group's pages sit together, in the order of the groups.
    const order = SETTINGS_PAGES.map((page) => groupIds.indexOf(page.group));
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it('says under a group only what its header leaves out, and keeps the whole name for where a page stands alone', () => {
    const { container } = renderRail();
    const row = (id: string) => container.querySelector(`[data-settings-id="${id}"]`);
    // Under "Decision points", the row is "Context"; the page's own title and the palette say "Decision points: Context".
    expect(row('decisions-context')).toHaveTextContent('mu.decisions.groups.context');
    expect(row('more-features-other')).toHaveTextContent('mu.decisions.otherGroup');
    expect(row('decisions-memory')).toHaveTextContent('mu.decisions.groups.memory');
    const pages = Object.fromEntries(SETTINGS_PAGES.map((page) => [page.id, page]));
    expect(pages['decisions-context'].labelKey).toBe('mu.pages.decisions.context');
    expect(pages['more-features-other'].labelKey).toBe('mu.pages.features.other');
    // A page whose name needs no group keeps it in the rail too.
    expect(row('judges')).toHaveTextContent('mu.sections.judges');
    expect(DECISION_PAGES.map((page) => `decisions-${page}`)).toEqual(groupRows(container).decisions);
    expect(FEATURE_PAGES.map((page) => `more-features-${page}`)).toEqual(groupRows(container)['more-features']);
  });

  it('marks the page shown, also from one of its sub-pages, and goes to the page a row names', () => {
    const { container } = renderRail('/settings/more-features-input/preflight');
    const current = () =>
      [...container.querySelectorAll('[aria-current="page"]')].map((row) => row.getAttribute('data-settings-id'));
    expect(current()).toEqual(['more-features-input']);
    fireEvent.click(container.querySelector('[data-settings-id="judges"]') as Element);
    expect(here()).toHaveAttribute('data-path', '/settings/judges');
    expect(current()).toEqual(['judges']);
    cleanup();
    // The second page of a feature's options is still under its group's entry.
    renderRail('/settings/more-features-tools/packs/2');
    expect(
      [...document.querySelectorAll('[aria-current="page"]')].map((row) => row.getAttribute('data-settings-id'))
    ).toEqual(['more-features-tools']);
    expect(FEATURE_LIST_PAGES).toEqual(['features', ...FEATURE_PAGES.map((page) => `more-features-${page}`)]);
  });

  it('scrolls the rail just far enough to show the page shown, when it opens and whenever the page changes', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      // 关于 is the last row, below the fold of most windows: a link or the palette can open it directly.
      const { container } = renderRail('/settings/about');
      const scrolledRows = () => scroll.mock.contexts.map((row) => (row as Element).getAttribute('data-settings-id'));
      expect(scrolledRows()).toEqual(['about']);
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
      fireEvent.click(container.querySelector('[data-settings-id="archived"]') as Element);
      expect(scrolledRows()).toEqual(['about', 'archived']);
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
    } finally {
      scroll.mockRestore();
    }
  });

  it('puts an extension next to the page it anchors to, in that group; one without a place ends the capabilities', () => {
    extensionTabs = [
      {
        id: 'ext-after',
        name: 'After tools',
        url: 'about:blank',
        position: { relativeTo: 'tools', placement: 'after' },
      },
      {
        id: 'ext-before',
        name: 'Before judges',
        url: 'about:blank',
        position: { relativeTo: 'judges', placement: 'before' },
      },
      // Anchored to a page of the six-page settings: it stays next to the page that took that one over.
      { id: 'ext-old', name: 'Old kernel', url: 'about:blank', position: { relativeTo: 'kernel', placement: 'after' } },
      { id: 'ext-free', name: 'Free', url: 'about:blank' },
      { id: 'ext-lost', name: 'Lost', url: 'about:blank', position: { relativeTo: 'nowhere', placement: 'after' } },
    ];
    const { container } = renderRail();
    const rows = groupRows(container);
    expect(rows.kernel).toEqual(['ext-before', 'judges', 'ext-old', 'features', 'personality']);
    expect(rows.capabilities).toEqual([
      'skills',
      'tools',
      'ext-after',
      'assistants',
      'browser',
      'ext-free',
      'ext-lost',
    ]);
    fireEvent.click(container.querySelector('[data-settings-id="ext-after"]') as Element);
    expect(here()).toHaveAttribute('data-path', '/settings/ext/ext-after');
  });

  it('opens on the first page of the models group: what a new user sets up first', () => {
    expect(SETTINGS_HOME).toBe(SETTINGS_PAGES.find((page) => page.group === 'models')?.route);
  });
});

/** Follows a link through the router's redirects, as the app installs them, to where it lands. */
function follow(link: string, state?: unknown) {
  const url = new URL(link, 'mu://app');
  render(
    <MemoryRouter initialEntries={[{ pathname: url.pathname, search: url.search, state }]}>
      <Routes>
        {Object.keys(RETIRED_SETTINGS_PATHS).map((from) => (
          <Route key={from} path={from} element={<RetiredSettingsPath from={from} />} />
        ))}
        {Object.keys(MOVED_SETTINGS_TABS)
          .filter((path) => !(path in RETIRED_SETTINGS_PATHS))
          .map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <WithMovedTabs path={path}>
                  <Here />
                </WithMovedTabs>
              }
            />
          ))}
        <Route path='*' element={<Here />} />
      </Routes>
    </MemoryRouter>
  );
  const landed = here();
  cleanup();
  return { path: landed.getAttribute('data-path'), state: JSON.parse(landed.getAttribute('data-state') ?? 'null') };
}

const onAPage = (path: string) => SETTINGS_PAGES.some((page) => isSettingsRouteActive(path.split('?')[0], page.route));

describe('links to settings pages that no longer exist', () => {
  it('lands every retired path on a page of the rail, with its query string and its state', () => {
    const state = { openAssistantEditor: true, openAssistantId: 'writer' };
    for (const pattern of Object.keys(RETIRED_SETTINGS_PATHS)) {
      const link = pattern.replace(':section', 'unknown').replace(':id', 'claude');
      const { path, state: carried } = follow(`${link}?highlight=needle`, state);
      expect(onAPage(path ?? ''), `${link} landed on ${path}`).toBe(true);
      expect(new URL(path ?? '', 'mu://app').searchParams.get('highlight'), link).toBe('needle');
      expect(carried, link).toEqual(state);
    }
  });

  it('sends the six pages of the previous settings to the pages that hold them now', () => {
    const cases: [string, string][] = [
      ['/settings/models', '/settings/providers'],
      ['/settings/permissions', '/settings/more-features-tools/permissions'],
      ['/settings/kernel', '/settings/judges'],
      ['/settings/kernel?highlight=hive', '/settings/judges?highlight=hive'],
      ['/settings/skills', '/settings/skills'],
      ['/settings/skills?tab=skills', '/settings/skills'],
      ['/settings/skills?tab=tools', '/settings/tools'],
      ['/settings/skills?tab=agents&highlight=writer', '/settings/assistants?highlight=writer'],
      ['/settings/appearance', '/settings/appearance'],
      ['/settings/system', '/settings/system'],
    ];
    for (const [link, target] of cases) expect(follow(link).path, link).toBe(target);
  });

  it('sends the one page of decision points and the one of other features to the first page of their groups', () => {
    const cases: [string, string][] = [
      ['/settings/decisions', '/settings/decisions-input'],
      ['/settings/decisions?highlight=hive', '/settings/decisions-input?highlight=hive'],
      ['/settings/more-features', '/settings/more-features-input'],
      ['/settings/more-features?highlight=packs', '/settings/more-features-input?highlight=packs'],
    ];
    for (const [link, target] of cases) expect(follow(link).path, link).toBe(target);
    expect(SETTINGS_ANCHOR_REMAP.decisions).toBe('decisions-input');
    expect(SETTINGS_ANCHOR_REMAP['more-features']).toBe('more-features-input');
  });

  it('sends mu’s old sections, and the pages that were folded into others, to their own page again', () => {
    const cases: [string, string][] = [
      ['/settings/kyrn', '/settings/providers'],
      ['/settings/kyrn/models', '/settings/providers'],
      ['/settings/kyrn/judges', '/settings/judges'],
      ['/settings/kyrn/decisions', '/settings/decisions-input'],
      ['/settings/kyrn/features', '/settings/features'],
      ['/settings/kyrn/context', '/settings/decisions-context'],
      ['/settings/kyrn/permissions', '/settings/more-features-tools/permissions'],
      ['/settings/model', '/settings/providers'],
      ['/settings/agent', '/settings/assistants'],
      ['/settings/agent/claude/repair', '/settings/assistants'],
      ['/assistants', '/settings/assistants'],
      ['/settings/skills-hub', '/settings/skills'],
      ['/settings/capabilities', '/settings/skills'],
      ['/settings/capabilities?tab=tools&highlight=x', '/settings/tools?highlight=x'],
      ['/settings/capabilities/skills/import-history', '/settings/skills/import-history'],
      ['/settings/display', '/settings/appearance'],
      ['/settings/webui', '/settings/system'],
      // Pages folded into others: the judge tiers under the judge choice, the compaction settings on the context page,
      // and the mode of a new conversation on the page of the permission feature's options.
      ['/settings/judge-tiers', '/settings/judges'],
      ['/settings/context', '/settings/decisions-context'],
      ['/settings/context?highlight=limit', '/settings/decisions-context?highlight=limit'],
      ['/settings/permissions?x=1', '/settings/more-features-tools/permissions?x=1'],
      // Voice input and the desktop pet are gone: an old link opens the page each sat next to.
      ['/settings/voice', '/settings/system'],
      ['/settings/pet', '/settings/appearance'],
    ];
    for (const [link, target] of cases) expect(follow(link).path, link).toBe(target);
    // The tools, the assistants, the archive and About were folded into other pages; now they are pages.
    const routes = SETTINGS_PAGES.map((page) => page.route as string);
    for (const page of ['tools', 'assistants', 'archived', 'about']) {
      expect(routes).toContain(`/settings/${page}`);
      expect(RETIRED_SETTINGS_PATHS).not.toHaveProperty(`/settings/${page}`);
    }
  });

  it('lets an old link’s own parameters win over the target’s, and drops the tab it named', () => {
    expect(retiredSettingsTarget('/settings/capabilities', '?tab=tools&x=1')).toBe('/settings/tools?x=1');
    expect(retiredSettingsTarget('/settings/nothing-like-it', '?x=1')).toBe(`${SETTINGS_HOME}?x=1`);
  });

  it('resolves every extension anchor of the past to a page of the rail', () => {
    const ids = new Set<string>(SETTINGS_PAGES.map((page) => page.id));
    for (const [anchor, target] of Object.entries(SETTINGS_ANCHOR_REMAP)) expect(ids.has(target), anchor).toBe(true);
  });
});
