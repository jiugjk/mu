import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { markOnboardingSeen, needsOnboarding, onboardingSeen } from './onboarding';
import { WelcomePage } from './page';

/** The routes the guide opens over: the home page, and the index that leads to it. */
const HOME_ROUTES = new Set(['/', '/guid']);

/**
 * Opens the first-run guide once, for someone with no startup model yet. Anyone else never sees it unasked.
 *
 * The app's layout runs it as it mounts, while the start screen still waits for mu: the settings are read and the
 * guide's code is loaded by then, and the guide is the first page drawn. Run from the home page, a first start drew the
 * home page, then the route loader for 300 ms, then the guide over both. Only the home page is left for the guide: a
 * reload or a link that opened another page keeps it.
 */
export function useFirstRunWelcome(): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Where the app is when the answer comes, not where it was when it asked.
  const where = useRef(pathname);
  where.current = pathname;
  useEffect(() => {
    if (onboardingSeen()) return;
    let live = true;
    void kyrnBridge.settings
      .invoke()
      .then(unwrap)
      .then(async (settings) => {
        if (!live) return;
        if (!needsOnboarding(settings)) {
          // Someone who set a model up before the guide existed does not need it.
          markOnboardingSeen();
          return;
        }
        // A page that failed to load is loaded again by its route.
        await WelcomePage.preload().catch((): undefined => undefined);
        if (live && HOME_ROUTES.has(where.current)) navigate('/welcome', { replace: true });
      })
      .catch((): undefined => undefined);
    return () => {
      live = false;
    };
  }, [navigate]);
}
