import React, { Suspense } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadablePage, preloadWhenIdle } from '@/renderer/components/layout/preloadablePage';

// A page loaded on demand suspended on its first render however quickly its code came, and React then kept the route
// loader up for at least 300 ms: every first visit of a settings page, the scheduled tasks or a conversation showed a
// blank page with dots.

type PageModule = { default: React.ComponentType };
const page = (text: string): PageModule => ({ default: () => <p>{text}</p> });

/** Draws `Page` under a Suspense, and returns the loader's render count. */
function show(Page: React.FC) {
  const loader = vi.fn(() => <span>loading</span>);
  const Loader = () => loader();
  render(
    <Suspense fallback={<Loader />}>
      <Page />
    </Suspense>
  );
  return loader;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'requestIdleCallback');
  Reflect.deleteProperty(window, 'cancelIdleCallback');
});

describe('a page loaded ahead', () => {
  it('draws at once, with no loader', async () => {
    const Page = preloadablePage(async () => page('settings page'));
    await Page.preload();
    const loader = show(Page);
    expect(screen.getByText('settings page')).toBeInTheDocument();
    expect(loader).not.toHaveBeenCalled();
  });

  it('loads its code once, however often it is asked for', async () => {
    const load = vi.fn(async () => page('about page'));
    const Page = preloadablePage(load);
    await Promise.all([Page.preload(), Page.preload()]);
    show(Page);
    expect(screen.getByText('about page')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('tries a failed load again at the next call', async () => {
    const load = vi
      .fn<() => Promise<PageModule>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValue(page('tools page'));
    const Page = preloadablePage(load);
    await expect(Page.preload()).rejects.toThrow('Failed to fetch');
    await Page.preload();
    show(Page);
    expect(screen.getByText('tools page')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('a page not loaded ahead', () => {
  it('shows the loader until its code is in, then the page', async () => {
    let arrive!: (module: PageModule) => void;
    const Page = preloadablePage(() => new Promise<PageModule>((resolve) => (arrive = resolve)));
    const loader = show(Page);
    expect(screen.getByText('loading')).toBeInTheDocument();
    await act(async () => arrive(page('scheduled tasks')));
    expect(await screen.findByText('scheduled tasks')).toBeInTheDocument();
    expect(loader).toHaveBeenCalled();
  });
});

describe('loading pages while the window is idle', () => {
  /** Idle callbacks that run only when the test says so. */
  function idleMoments() {
    const waiting = new Map<number, () => void>();
    let last = 0;
    const cancel = vi.fn((handle: number) => waiting.delete(handle));
    Object.assign(window, {
      requestIdleCallback: (callback: () => void) => {
        last += 1;
        waiting.set(last, callback);
        return last;
      },
      cancelIdleCallback: cancel,
    });
    return {
      waiting,
      cancel,
      /** Runs the idle callback waiting now, and what it started. */
      async pass() {
        const [handle, callback] = [...waiting][0];
        waiting.delete(handle);
        await act(async () => callback());
      },
    };
  }

  it('loads them one after another, each in an idle moment of its own', async () => {
    const idle = idleMoments();
    const loads = ['a', 'b', 'c'].map((name) => vi.fn(async () => page(name)));
    preloadWhenIdle(loads.map((load) => preloadablePage(load)));
    expect(loads[0]).not.toHaveBeenCalled();
    await idle.pass();
    expect(loads.map((load) => load.mock.calls.length)).toEqual([1, 0, 0]);
    await idle.pass();
    expect(loads.map((load) => load.mock.calls.length)).toEqual([1, 1, 0]);
    await idle.pass();
    expect(loads.map((load) => load.mock.calls.length)).toEqual([1, 1, 1]);
    expect(idle.waiting.size).toBe(0);
  });

  it('goes on past a page that failed to load, and leaves that one to its visit', async () => {
    const idle = idleMoments();
    const broken = vi.fn(async (): Promise<PageModule> => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    const next = vi.fn(async () => page('next'));
    preloadWhenIdle([preloadablePage(broken), preloadablePage(next)]);
    await idle.pass();
    await idle.pass();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('stops before the next page when asked', async () => {
    const idle = idleMoments();
    const loads = ['a', 'b'].map((name) => vi.fn(async () => page(name)));
    const stop = preloadWhenIdle(loads.map((load) => preloadablePage(load)));
    await idle.pass();
    stop();
    expect(idle.cancel).toHaveBeenCalledTimes(1);
    expect(idle.waiting.size).toBe(0);
    expect(loads[1]).not.toHaveBeenCalled();
  });

  it('loads nothing ahead where the window has no idle callbacks', () => {
    const load = vi.fn(async () => page('a'));
    const stop = preloadWhenIdle([preloadablePage(load)]);
    stop();
    expect(load).not.toHaveBeenCalled();
  });
});
