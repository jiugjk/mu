import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { refreshManagedAgentCatalogAndAssistants } from '@/renderer/hooks/agent/useManagedAgents';

/**
 * After a change to what mu offers (a save, a sign-in, a sign-out): the backend checks mu again, and the model pickers
 * and the / menu read what it found. They read a snapshot the backend keeps from its last check of mu, which the app's
 * start makes. Without this, a model set up on a fresh profile was missing from the home page's pill (默认模型, with no
 * list) until the app was started again.
 */
export async function recheckMu(): Promise<void> {
  try {
    unwrap(await kyrnBridge.recheck.invoke());
  } catch {
    // mu did not answer the check. The pickers keep what they had; the next start checks again.
  }
  await refreshManagedAgentCatalogAndAssistants().catch((): undefined => undefined);
}
