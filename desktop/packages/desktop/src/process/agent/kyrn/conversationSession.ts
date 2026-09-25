import { text } from './piRpc';

/** How many conversations' agents are remembered; the oldest is forgotten first. */
const REMEMBERED = 512;

export type ConversationSession = { extra: Record<string, unknown>; sessionId: string };

/**
 * Finds the adapter session behind a conversation. The work panel reads a conversation's kernel record every second,
 * even while the window is in the background, and each read used to fetch the whole conversation from the backend
 * (a request and three log lines every second or two, all day). A conversation's agent never changes, so its id is
 * asked for once and remembered. Its session can change (a rewind, a reopen), so that binding is read every time.
 *
 * `fetchExtra`: the conversation's `extra` from the backend; it validates the id and throws for a bad one.
 * `bindingOf`: the session bound to the conversation and agent, or '' when there is none yet.
 */
export function conversationSessions(
  fetchExtra: (conversationId: string) => Promise<Record<string, unknown>>,
  bindingOf: (conversationId: string, agentId: string) => string
) {
  const agents = new Map<string, string>();
  const conversation = async (conversationId: string): Promise<ConversationSession> => {
    const extra = await fetchExtra(conversationId);
    const agentId = text(extra.agent_id);
    if (agentId) {
      agents.delete(conversationId);
      agents.set(conversationId, agentId);
      const oldest = agents.keys().next().value;
      if (agents.size > REMEMBERED && oldest !== undefined) agents.delete(oldest);
    }
    return { extra, sessionId: bindingOf(conversationId, agentId) };
  };
  return {
    /** The conversation's `extra`, fresh from the backend, and its session. */
    conversation,
    /** Its session alone: no request once the conversation's agent is known. */
    session: async (conversationId: string): Promise<string> => {
      const agentId = agents.get(conversationId);
      return agentId === undefined
        ? (await conversation(conversationId)).sessionId
        : bindingOf(conversationId, agentId);
    },
  };
}
