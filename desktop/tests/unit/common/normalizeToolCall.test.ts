import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall } from '@/common/chat/chatLib';
import { normalizeAcpToolCall } from '@/common/chat/normalizeToolCall';

describe('normalizeToolCall', () => {
  it('normalizes compact snake_case acp tool calls from history responses', () => {
    const result = normalizeAcpToolCall({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        _compact: {
          truncated: true,
          original_size: 90000,
          preview_chars: 4096,
        },
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          raw_input: { pattern: 'needle', path: '.' },
          content: [{ type: 'content', content: { type: 'text', text: 'preview' } }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result).toMatchObject({
      key: 'tool-1',
      name: 'rg',
      status: 'completed',
      description: '"needle" in .',
      output: 'preview',
      truncated: true,
      messageId: 'message-1',
      conversationId: 'conversation-1',
    });
  });

  it('ignores malformed ACP content items in compact history output', () => {
    const result = normalizeAcpToolCall({
      id: 'message-2',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-2',
          status: 'completed',
          title: 'Edit file',
          kind: 'edit',
          content: [null, 'invalid', { type: 'diff', path: '/workspace/file.ts', old_text: 'old', new_text: 'new' }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result?.output).toBe('[diff] /workspace/file.ts');
  });

  it('names a call whose result came without a title, so its row can be drawn', () => {
    // An ACP tool_call_update carries no title; when the call's first frame never reached the list, the row is built
    // from the result alone. Its name was undefined, and the row's kind icon threw on it: the conversation page fell
    // to the error screen.
    const result = normalizeAcpToolCall({
      id: 'message-3',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call_update',
          tool_call_id: 'call_e2e_4',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Successfully wrote to notes/hello.txt' } }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result?.name).toBe('');
    expect(result?.output).toBe('Successfully wrote to notes/hello.txt');
  });

  it('names such a call by its kind when the result says which', () => {
    const result = normalizeAcpToolCall({
      id: 'message-4',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: { session_update: 'tool_call_update', tool_call_id: 'call-5', status: 'failed', kind: 'execute' },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result?.name).toBe('execute');
  });

  describe('a call the person did not allow', () => {
    const REFUSAL =
      'The user did not allow this (rm -rf build). Do not try another way around it: ask them, or carry on without it.';
    const call = (status: string, text: string, rawOutput?: Record<string, unknown>) =>
      normalizeAcpToolCall({
        id: 'message-5',
        conversation_id: 'conversation-1',
        type: 'acp_tool_call',
        content: {
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'call-9',
            status,
            title: 'bash',
            kind: 'execute',
            raw_input: { command: 'rm -rf build' },
            content: [{ type: 'content', content: { type: 'text', text } }],
            ...(rawOutput ? { raw_output: rawOutput } : {}),
          },
        },
      } as unknown as IMessageAcpToolCall);

    it('is known by the bridge’s mark, as the relay passes it on', () => {
      expect(call('failed', REFUSAL, { content: [], mu: { answer: 'deny' } })?.denied).toBe(true);
    });

    it('is known by mu’s refusal in a conversation from before the mark', () => {
      expect(call('failed', REFUSAL)?.denied).toBe(true);
    });

    it('is not a call that failed by itself, or one that only quotes the words', () => {
      expect(call('failed', 'rm: build: Permission denied')).not.toHaveProperty('denied');
      expect(call('completed', REFUSAL)).not.toHaveProperty('denied');
      expect(call('failed', `echo "${REFUSAL}"\nexit 1`)).not.toHaveProperty('denied');
    });
  });
});
