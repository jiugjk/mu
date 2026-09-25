import { KyrnError } from '../../../common/kyrn/errors';
import {
  mergeQqGateway,
  qqGatewayProblem,
  qqGatewayShapeOk,
  type QqGatewayInput,
} from '../../../common/kyrn/qqGateway';
import { atomic, parseObject, readOptional, serialise } from './config/files';
import { configPath } from './naming';
import { asRecord } from './piRpc';

/**
 * Writes the guide's QQ gateway into mu.json's `channels.qqbot`, leaving every other key in the file (judges,
 * features, other channel accounts) as it was. Refuses a gateway that is off or that failed the check: the guide
 * only calls this after the person turned it on and the fields passed.
 */
export function saveQqGateway(agentDir: string, input: QqGatewayInput): { saved: true } {
  if (!input.enabled || !qqGatewayShapeOk(input)) throw new KyrnError('invalid', 'Invalid QQ gateway');
  const problem = qqGatewayProblem(input);
  if (problem) throw new KyrnError('invalid', `Invalid QQ gateway (${problem})`);
  const path = configPath(agentDir);
  const raw = readOptional(path);
  const config = parseObject(raw, path);
  const channels = asRecord(config.channels);
  config.channels = { ...channels, qqbot: mergeQqGateway(asRecord(channels.qqbot), input) };
  atomic(path, serialise(config, raw));
  return { saved: true };
}
