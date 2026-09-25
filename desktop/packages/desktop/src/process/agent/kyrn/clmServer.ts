import { clmServer, type ClmServerState } from '../../../common/kyrn/clm';
import { assertEndpoint } from './config/models';
import { asRecord } from './piRpc';

/**
 * How the CLM server behind a judge's address is, asked from the main process (a browser page may not call it: the
 * server allows no other origin). GET /health, open to anyone, says whether it answers, whether its encoder does and
 * which models it serves; GET /v1/models asks for the key when the server has one. No key is sent: a saved key stays
 * in the harness's .env, and a server that wants one says so without it.
 */
export async function checkClmServer(baseUrl: string, send: typeof fetch = fetch): Promise<ClmServerState> {
  const server = clmServer(baseUrl);
  // The rule for every address mu sends a judge's questions to: they hold what the person wrote.
  assertEndpoint(server);
  const get = (path: string) =>
    send(`${server}${path}`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
  const started = Date.now();
  let health: Record<string, unknown>;
  try {
    health = asRecord(await (await get('/health')).json());
  } catch {
    return { status: 'down' };
  }
  if (health.ok !== true) return { status: 'down' };
  const latencyMs = Date.now() - started;
  let keyRequired = false;
  try {
    keyRequired = (await get('/v1/models')).status === 401;
  } catch {
    // It answered its health check a moment ago; whether it wants a key shows at the first question.
  }
  const models = Array.isArray(health.models) ? health.models : [];
  return {
    status: health.embedder === false ? 'encoderDown' : 'ready',
    models: models.filter((model): model is string => typeof model === 'string').slice(0, 50),
    mock: health.mock === true,
    keyRequired,
    latencyMs,
  };
}
