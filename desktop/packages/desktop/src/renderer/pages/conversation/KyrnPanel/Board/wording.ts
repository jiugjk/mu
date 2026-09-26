import type { BoardUpdate } from './board';

/**
 * A fixed board in the reader's language. When the model does not answer in time the harness writes the board from
 * fixed sentences (`by: 'rules'`), in Chinese or English only, picked by what the person typed rather than by the
 * app's language. Those sentences carry no words of their own beyond the facts, so they are rebuilt here from the
 * facts: how far (`done`/`total`), what now (`phase` plus `focusText`, the task's own words) and `confirmCodes`. A part
 * with no wording in this language keeps the harness's sentence; a board the model wrote is its own words and stays.
 * The contract is the harness's kyrn/docs/features/presentation-codes.md (board.update).
 *
 * A fixed board's "now" names a stage as going on ("wrapping up", "changing the code"). Once the run has ended the
 * board's state says how it ended, and a stage under it would misread it: a fixed board that ended has no "now".
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;
/** Whether the app has a wording for a key. */
type Has = (key: string) => boolean;

export type BoardWords = { now: string; progress: string; confirm: string[] };

const KEY = 'common.kyrn.boardView.codes';

export function boardWords(update: BoardUpdate, t: Translate, has: Has, number: (value: number) => string): BoardWords {
  const over = update.by === 'rules' && update.ended;
  const said = { now: over ? '' : update.now, progress: update.progress, confirm: update.confirm };
  // An older harness sends no codes: its sentence may name the item being worked on, which the facts here lack.
  if (update.by !== 'rules' || !update.confirmCodes) return said;

  const { done, total } = update;
  const progressKey =
    total === 0 ? `${KEY}.progress.none` : done === total ? `${KEY}.progress.all` : `${KEY}.progress.some`;
  const progress = has(progressKey)
    ? t(progressKey, { done: number(done), total: number(total), count: total })
    : said.progress;

  const nowKey = `${KEY}.now.${update.phase ?? 'unclear'}`;
  const base = has(nowKey) ? t(nowKey) : undefined;
  const now = over
    ? ''
    : !base
      ? said.now
      : !update.focusText
        ? base
        : has(`${KEY}.now.focus`)
          ? t(`${KEY}.now.focus`, { now: base, focus: update.focusText })
          : // The harness's sentence names the item: without a way to say it here, keep that sentence.
            said.now;

  const confirm = update.confirm.map((line, index) => {
    const code = update.confirmCodes?.[index];
    return code && has(`${KEY}.confirm.${code}`) ? t(`${KEY}.confirm.${code}`) : line;
  });
  return { now, progress, confirm };
}
