import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Outlet } from 'react-router-dom';
import { SWRConfig } from 'swr';
import PanelRoute from '@/renderer/components/layout/Router';
import { ONBOARDING_KEY } from '@/renderer/pages/welcome/onboarding';

// A first start drew the home page, then the route loader for 300 ms while the guide's code came, then the guide over
// both: the sidebar showed up and went away again. The check now runs while the start screen waits for mu.

const { catalog, settings, home, loader } = vi.hoisted(() => ({
  catalog: vi.fn(),
  settings: vi.fn(),
  home: vi.fn(() => null),
  loader: vi.fn(() => null),
}));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { catalog: { invoke: catalog }, settings: { invoke: settings } },
  unwrap: (result: { data?: unknown }) => result.data,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@/renderer/components/layout/AppLoader', () => ({ default: loader }));
vi.mock('@/renderer/components/layout/DocumentTitle', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/system/useCrossSessionRateLimitNotice', () => ({ useCrossSessionRateLimitNotice: () => {} }));
vi.mock('@renderer/pages/guid', () => ({ default: () => home() ?? <p>home page</p> }));
vi.mock('@renderer/pages/welcome', () => ({ default: () => <p>the guide</p> }));

/** mu's settings as the check reads them: with or without the model new conversations start on. */
const withModel = (provider: string) => ({ ok: true, data: { models: { defaults: { provider } } } });

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '#/guid';
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = '';
});

const Layout = () => <Outlet />;
function start() {
  const started = Promise.withResolvers<unknown>();
  catalog.mockReturnValue(started.promise);
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <PanelRoute layout={<Layout />} />
    </SWRConfig>
  );
  return () => started.resolve({ ok: true, data: { assistants: [] } });
}

describe('the first-run guide at the first start', () => {
  it('is the first page drawn: no home page and no route loader before it', async () => {
    settings.mockResolvedValue(withModel(''));
    const muIsUp = start();
    // While mu starts, the settings were read and the guide's code loaded: the app is on the guide's route already.
    await waitFor(() => expect(window.location.hash).toBe('#/welcome'));
    expect(screen.getByTestId('mu-startup')).toBeInTheDocument();
    muIsUp();
    expect(await screen.findByText('the guide')).toBeInTheDocument();
    expect(home).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });

  it('is not shown to someone with a startup model, who lands on the home page and is never asked again', async () => {
    settings.mockResolvedValue(withModel('relay'));
    const muIsUp = start();
    await waitFor(() => expect(localStorage.getItem(ONBOARDING_KEY)).toBeTruthy());
    muIsUp();
    expect(await screen.findByText('home page')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/guid');
  });

  it('is not shown again once it was seen: the settings are not even read', async () => {
    localStorage.setItem(ONBOARDING_KEY, '2026-09-26T00:00:00.000Z');
    const muIsUp = start();
    muIsUp();
    expect(await screen.findByText('home page')).toBeInTheDocument();
    expect(settings).not.toHaveBeenCalled();
  });
});
