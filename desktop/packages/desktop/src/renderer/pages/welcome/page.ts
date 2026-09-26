import { preloadablePage } from '@renderer/components/layout/preloadablePage';

/**
 * The first-run guide as a page of the router, whose code loads on its first visit or ahead of it. The first-run
 * check loads it before it opens the guide (useFirstRunWelcome), so the guide is drawn at once.
 */
export const WelcomePage = preloadablePage(() => import('./index'));
