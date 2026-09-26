/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The settings rail works from the keyboard. Its rows were plain elements with a click handler: Tab skipped the whole
 * rail (it stopped once on the rail itself, which Chromium makes focusable when nothing inside it is), so another page
 * could be opened only by typing its name in the command palette. Now Tab reaches every row and Enter or Space opens
 * its page.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/renderer/hooks/system/useExtensionSettingsTabs', () => ({
  useExtensionSettingsTabs: () => [],
}));

vi.mock('@/renderer/hooks/system/useExtI18n', () => ({
  useExtI18n: () => ({ resolveExtTabName: (tab: { name: string }) => tab.name }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  resolveExtensionAssetUrl: (url?: string) => url,
}));

import SettingsSider from '@/renderer/pages/settings/components/SettingsSider';
import { SETTINGS_PAGES } from '@/renderer/pages/settings/settingsNav';

function Here() {
  const { pathname } = useLocation();
  return <output data-testid='here' data-path={pathname} />;
}

const renderRail = (collapsed = false) =>
  render(
    <MemoryRouter initialEntries={['/settings/providers']}>
      <SettingsSider collapsed={collapsed} />
      <Here />
    </MemoryRouter>
  );

const row = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-settings-id="${id}"]`) as HTMLElement;

describe('the settings rail and the keyboard', () => {
  afterEach(() => cleanup());

  it('puts every page in the Tab order as a named button', () => {
    const { container } = renderRail();

    for (const page of SETTINGS_PAGES) {
      const item = row(container, page.id);
      expect(item.getAttribute('role')).toBe('button');
      expect(item.tabIndex).toBe(0);
      expect(item.getAttribute('aria-label')).toBe(page.labelKey);
    }
    expect(screen.getByRole('button', { name: 'mu.sections.defaultModel' })).toBeInTheDocument();
  });

  it('opens a page with Enter or Space', () => {
    const { container } = renderRail();
    const [first, second] = SETTINGS_PAGES.filter((page) => page.id !== 'providers');

    fireEvent.keyDown(row(container, first.id), { key: 'Enter' });
    expect(screen.getByTestId('here').getAttribute('data-path')).toBe(`/settings/${first.path}`);

    fireEvent.keyDown(row(container, second.id), { key: ' ' });
    expect(screen.getByTestId('here').getAttribute('data-path')).toBe(`/settings/${second.path}`);
    expect(row(container, second.id).getAttribute('aria-current')).toBe('page');
  });

  it('keeps each page named when the rail is folded to its icons', () => {
    const { container } = renderRail(true);

    expect(row(container, 'default-model').getAttribute('aria-label')).toBe(
      SETTINGS_PAGES.find((page) => page.id === 'default-model')?.labelKey
    );
  });
});
