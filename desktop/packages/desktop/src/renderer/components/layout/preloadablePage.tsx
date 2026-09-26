import React from 'react';

type PageModule = { default: React.ComponentType };

/** A page whose code loads on demand, and can also be loaded ahead of a visit. */
export type PreloadablePage = React.FC & {
  /** Loads the page's code. Once it is in, the page renders at once. A failed load is tried again at the next call. */
  preload: () => Promise<PageModule>;
};

/**
 * React.lazy, with a way to load the page before it is visited.
 *
 * A lazy page suspends on its first render however quickly its code arrives, and React then keeps the route loader
 * (a blank page with dots) up for at least 300 ms (react-dom's FALLBACK_THROTTLE_MS). So every first visit of a
 * settings page, of the scheduled tasks and of a conversation showed that loader for 300 ms, while the code itself was
 * in within a few milliseconds. A page loaded ahead renders its component directly and has nothing to suspend on.
 */
export function preloadablePage(load: () => Promise<PageModule>): PreloadablePage {
  let loaded: React.ComponentType | undefined;
  let loading: Promise<PageModule> | undefined;
  const preload = (): Promise<PageModule> =>
    (loading ??= load().then(
      (module) => {
        loaded = module.default;
        return module;
      },
      (error: unknown) => {
        loading = undefined;
        throw error;
      }
    ));
  // Its first render calls `preload`, whose promise sets `loaded` before React hears that it settled: the render React
  // retries then takes the loaded component, and the lazy one is never shown.
  const Lazy = React.lazy(preload);
  const Page: React.FC = () => {
    const Loaded = loaded;
    return Loaded ? <Loaded /> : <Lazy />;
  };
  return Object.assign(Page, { preload });
}

/**
 * Loads the pages ahead, one after another and each when the window is idle, so the loading never holds up what is on
 * screen or what the person does. A page that fails to load is left to its visit. Returns a function that stops before
 * the next page. Without idle callbacks (a test's DOM; Electron's Chromium has them) nothing is loaded ahead.
 */
export function preloadWhenIdle(pages: readonly PreloadablePage[]): () => void {
  if (typeof window.requestIdleCallback !== 'function') return () => {};
  let stopped = false;
  let handle: number | undefined;
  const next = (index: number): void => {
    if (stopped || index >= pages.length) return;
    handle = window.requestIdleCallback(() => {
      handle = undefined;
      void pages[index]
        .preload()
        .catch((): undefined => undefined)
        .then(() => next(index + 1));
    });
  };
  next(0);
  return () => {
    stopped = true;
    if (handle !== undefined) window.cancelIdleCallback(handle);
  };
}
