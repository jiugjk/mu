import type { TMessage } from '@/common/chat/chatLib';

/**
 * Where mu's permission question stands in the conversation. mu asks about a call once the call has started, so by
 * time the question comes after the call's row, and the outcome of a refused call would read above the question that
 * led to it. A question that names its call goes right before that call's row instead, at the call's time: the page
 * reads the question, then what came of it.
 *
 * The card names the call by mu's `toolCallId` (`rawInput.mu`, beside mu's codes). A card from before mu named it is
 * placed by the command it asks about, when a call of the same turn ran exactly that command.
 */

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The call a card of mu's asks about, or undefined for any other message (another agent's card has no mu codes). */
function askedAbout(message: TMessage): { id: string; command: string } | undefined {
  if (message.type !== 'acp_permission') return undefined;
  const input = record(message.content?.tool_call?.raw_input);
  if (!('mu' in input)) return undefined;
  // The relay snake-cases the keys it passes on; a stored card may have either spelling.
  const mu = record(input.mu);
  return { id: str(mu.toolCallId) || str(mu.tool_call_id), command: str(input.command) };
}

/** A tool call's id and the command it ran, or undefined for any other message. */
function callOf(message: TMessage): { id: string; command: string } | undefined {
  if (message.type !== 'acp_tool_call') return undefined;
  const update = record(message.content?.update);
  const input = record(update.raw_input ?? update.rawInput);
  return { id: str(update.tool_call_id) || str(update.toolCallId), command: str(input.command) };
}

/**
 * The list with each question of mu's right before the call it asks about. A list without such a card comes back as
 * it was.
 */
export function questionsBeforeCalls(list: TMessage[]): TMessage[] {
  const before = new Map<number, TMessage[]>();
  const moved = new Set<number>();
  list.forEach((message, index) => {
    const about = askedAbout(message);
    if (!about || (!about.id && !about.command)) return;
    for (let at = index - 1; at >= 0; at--) {
      const earlier = list[at];
      // A question is about a call of its own turn: the person's message before it ends the search.
      if (earlier.type === 'text' && earlier.position === 'right') return;
      const call = callOf(earlier);
      if (!call || !(about.id ? call.id === about.id : call.command === about.command)) continue;
      moved.add(index);
      const card = { ...message, created_at: earlier.created_at ?? message.created_at } as TMessage;
      before.set(at, [...(before.get(at) ?? []), card]);
      return;
    }
  });
  if (!moved.size) return list;
  return list.flatMap((message, index) => (moved.has(index) ? [] : [...(before.get(index) ?? []), message]));
}
