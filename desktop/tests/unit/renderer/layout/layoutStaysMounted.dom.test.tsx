import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Outlet, useNavigate } from 'react-router-dom';
import { SWRConfig } from 'swr';
import PanelRoute from '@/renderer/components/layout/Router';

const { catalog } = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  // The first-run check (firstRunGuide.dom.test.tsx) reads the settings; here it never hears back.
  kyrnBridge: { catalog: { invoke: catalog }, settings: { invoke: () => new Promise(() => {}) } },
  unwrap: (result: { data?: unknown }) => result.data,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@/renderer/components/layout/AppLoader', () => ({ default: () => <span>Loading</span> }));
vi.mock('@/renderer/components/layout/DocumentTitle', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/system/useCrossSessionRateLimitNotice', () => ({ useCrossSessionRateLimitNotice: () => {} }));
vi.mock('@renderer/pages/guid', () => ({ default: () => <p>home page</p> }));
vi.mock('@renderer/pages/conversation', () => ({ default: () => <p>conversation page</p> }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = '';
});

/** Stands in for the app's layout (sidebar, title bar, work panel): counts how often it is mounted. */
let layoutMounts = 0;
function Layout() {
  const navigate = useNavigate();
  React.useEffect(() => {
    layoutMounts += 1;
  }, []);
  return (
    <main>
      <button onClick={() => void navigate('/conversation/abc')}>to the conversation</button>
      <button onClick={() => void navigate('/guid')}>to home</button>
      <Outlet />
    </main>
  );
}

describe('the app layout', () => {
  it('stays mounted between a conversation and the other pages', async () => {
    catalog.mockResolvedValue({ ok: true, data: { assistants: [] } });
    layoutMounts = 0;
    window.location.hash = '#/guid';
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <PanelRoute layout={<Layout />} />
      </SWRConfig>
    );
    expect(await screen.findByText('home page')).toBeInTheDocument();
    expect(layoutMounts).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'to the conversation' }));
    expect(await screen.findByText('conversation page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'to home' }));
    expect(await screen.findByText('home page')).toBeInTheDocument();

    expect(layoutMounts).toBe(1);
    // Back from the conversation, the gate already knows mu is up: it does not cover the app again.
    expect(screen.queryByTestId('mu-startup')).not.toBeInTheDocument();
  });
});
