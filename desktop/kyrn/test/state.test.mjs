import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldEvents } from '../src/state.ts';
const envelope = (event, sequence = 1) => ({ sessionId: 's', sequence, at: 0, event });
const presentation = (kind, payload, sequence) =>
  envelope(
    {
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'kyrn.presentation.v1',
      statusText: JSON.stringify({ runtimeId: 'r', turnId: 1, kind, payload }),
    },
    sequence
  );

test('pending and verdict occupy one native card, with no invented reasoning', () => {
  const events = [
    envelope({ type: 'kyrn_submission', text: 'hi' }),
    presentation('preflight.pending', { judge: 'jev' }, 2),
  ];
  assert.equal(foldEvents(events).items[1].running, true);
  events.push(
    presentation('preflight.verdict', { state: 'applied', turnType: 'chat', gear: 'chat', latencyMs: 42 }, 3)
  );
  const state = foldEvents(events);
  assert.equal(state.items.length, 2);
  assert.equal(state.items[1].running, false);
  assert.equal(state.items[1].data.turnType, 'chat');
});
test('tool snapshots expose bee progress and final authoritative messages replace deltas', () => {
  const state = foldEvents([
    envelope({ type: 'message_start', message: { role: 'assistant' } }, 1),
    envelope({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'part' } }, 2),
    envelope({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'complete' }] } }, 3),
    envelope(
      {
        type: 'tool_execution_update',
        partialResult: { details: { snapshot: { bees: [{ name: 'a', status: 'tool' }] } } },
      },
      4
    ),
    envelope({ type: 'agent_settled' }, 5),
  ]);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].text, 'complete');
  assert.equal(state.swarm.bees[0].status, 'tool');
  assert.equal(state.busy, false);
});
test('timeout is shown as fallback, late verdict does not claim to have been applied', () => {
  const events = [
    presentation('preflight.pending', { judge: 'jev' }, 1),
    presentation('preflight.wait_end', { reason: 'timeout', waitedMs: 6000 }, 2),
  ];
  assert.equal(foldEvents(events).items[0].data.state, 'none');
  events.push(presentation('preflight.verdict', { state: 'late', turnType: 'research' }, 3));
  assert.equal(foldEvents(events).items[0].data.state, 'late');
});
