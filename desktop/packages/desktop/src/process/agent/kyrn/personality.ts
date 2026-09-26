import { KyrnError } from '../../../common/kyrn/errors';
import {
  PersonalityError,
  applyPersonalityAction,
  personalityState,
  type PersonalityAction,
  type PersonalityState,
} from '../../../common/kyrn/personality';
import {
  loadPersonality,
  personalityPath,
  writePersonality,
} from '../../../../../../../packages/kyrn-judge/src/personality/store.ts';

/** The personalities on disk, including the built-ins. A broken file is reported and not rewritten here. */
export function readPersonalityState(agentDir: string): PersonalityState {
  const loaded = loadPersonality(personalityPath(agentDir));
  return personalityState(loaded.file, loaded.invalid);
}

/** One change to the shared personality file. The next message, including one from QQ, uses the result. */
export function savePersonality(agentDir: string, action: PersonalityAction): PersonalityState {
  const path = personalityPath(agentDir);
  const loaded = loadPersonality(path);
  if (loaded.invalid) throw new KyrnError('invalidJson', 'Personality file is not valid JSON', { file: path });
  let next: ReturnType<typeof applyPersonalityAction>;
  try {
    next = applyPersonalityAction(loaded.file, action);
  } catch (error) {
    const problem = error instanceof PersonalityError ? error.problem : 'invalid';
    throw new KyrnError('invalid', problem, { problem });
  }
  try {
    writePersonality(path, next);
  } catch (error) {
    throw new KyrnError('unwritable', error instanceof Error ? error.message : String(error), { file: path });
  }
  return personalityState(next, false);
}
