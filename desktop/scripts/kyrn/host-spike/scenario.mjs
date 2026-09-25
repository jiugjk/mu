/**
 * What the spike has to prove, as checks against a live host. Transport-agnostic: the Electron driver and the
 * plain-Node driver both hand it `{ send(message), onMessage(handler) }`.
 */
export async function runScenario(link, label) {
  const events = [];
  const waiting = new Map();
  const watchers = new Set();
  let nextId = 0;
  let ready;
  const whenReady = new Promise((resolve) => {
    ready = resolve;
  });

  link.onMessage((message) => {
    const received = performance.timeOrigin + performance.now();
    if (message.type === 'ready') return ready(message.versions);
    if (message.type === 'response') {
      const pending = waiting.get(message.id);
      waiting.delete(message.id);
      return message.ok ? pending?.resolve(message.data) : pending?.reject(new Error(message.error));
    }
    events.push({ ...message, deliveryMs: received - message.at });
    for (const watch of watchers) watch();
  });

  const call = (command) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      link.send({ ...command, id });
    });
  /** Resolves with the first event at or after `from` that matches. No polling: it reacts to arrivals. */
  const until = (match, from = 0, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = events.find((entry, index) => index >= from && match(entry));
        if (!found) return false;
        watchers.delete(check);
        clearTimeout(timer);
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        watchers.delete(check);
        reject(new Error('Timed out waiting for an event'));
      }, timeoutMs);
      if (!check()) watchers.add(check);
    });
  const kind = (entry) =>
    entry.source === 'kyrn' ? `kyrn:${entry.event.kind}` : `${entry.source}:${entry.event.type ?? entry.event.kind}`;
  const isKind = (name) => (entry) => kind(entry) === name;

  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

  const startedAt = performance.now();
  const versions = await whenReady;
  const bootMs = Math.round(performance.now() - startedAt);
  const opened = await call({ type: 'open', preflightWaitMs: 150, tokensPerSecond: 600 });
  const openMs = Math.round(performance.now() - startedAt) - bootMs;

  // 1. One ordered stream: judgment events and session events share a sequence, and a turn has an explicit end.
  await call({
    type: 'script',
    judge: [{ turnType: 'chat' }],
    model: [{ thinking: 'The user greets me. A short answer is enough.', text: 'Hello. What are we building today?' }],
  });
  let mark = events.length;
  await call({ type: 'prompt', text: 'hello there' });
  const turn1 = events.slice(mark);
  const order = turn1.map(kind);
  const at = (name) => order.indexOf(name);
  check(
    'sequence numbers are gapless and increasing',
    events.every((entry, index) => entry.seq === index + 1),
    `${events.length} events`
  );
  check(
    'judgment events are interleaved in the same stream, before the turn they gate',
    at('kyrn:preflight.pending') >= 0 &&
      at('kyrn:preflight.pending') < at('kyrn:preflight.verdict') &&
      at('kyrn:preflight.verdict') < at('session:agent_start'),
    `pending@${at('kyrn:preflight.pending')} verdict@${at('kyrn:preflight.verdict')} agent_start@${at('session:agent_start')}`
  );
  check(
    'the prompt call resolves only after agent_settled (no get_state polling to find the end of a turn)',
    order.includes('session:agent_settled') &&
      order.lastIndexOf('session:agent_settled') >= order.lastIndexOf('session:message_end'),
    `last events: ${order.slice(-4).join(', ')}`
  );
  const thinkingDeltas = turn1.filter(
    (entry) => entry.event.type === 'message_update' && String(entry.event.kind).startsWith('thinking')
  ).length;
  check(
    'thinking streams as typed deltas with an explicit end',
    thinkingDeltas > 0 && turn1.some((entry) => entry.event.kind === 'thinking_end'),
    `${thinkingDeltas} thinking events`
  );

  // 2. Cancel is definitive: the stream itself says the turn is over and how it ended.
  await call({
    type: 'script',
    judge: [{ turnType: 'chat' }],
    model: [
      {
        thinking: 'Let me think about this for a long while. '.repeat(40),
        text: 'This text should never arrive in full. '.repeat(40),
      },
    ],
  });
  mark = events.length;
  const aborted = call({ type: 'prompt', text: 'write something long' });
  await until((entry) => entry.event.type === 'message_update', mark);
  const abortAt = performance.now();
  await call({ type: 'abort' });
  await aborted;
  const settled = await until(isKind('session:agent_settled'), mark);
  const abortMs = Math.round(performance.now() - abortAt);
  const afterAbort = await call({ type: 'entries' });
  const lastAssistant = afterAbort.findLast((entry) => entry.role === 'assistant');
  check(
    'abort ends the turn in the stream (agent_settled) and the stored message says why',
    Boolean(settled) && lastAssistant?.stopReason === 'aborted',
    `stopReason=${lastAssistant?.stopReason}, settled ${abortMs} ms after abort`
  );

  // 3. A verdict that arrives after the next message began is filed under the turn that asked.
  await call({
    type: 'script',
    judge: [{ turnType: 'edit', hold: true }, { turnType: 'chat' }],
    model: [{ text: 'Started without the verdict.' }, { text: 'Second answer.' }],
  });
  mark = events.length;
  await call({ type: 'prompt', text: 'refactor the session store' });
  const second = call({ type: 'prompt', text: 'and add tests' });
  await until((entry) => kind(entry) === 'kyrn:preflight.pending' && entry.event.turnId === 4, mark);
  await call({ type: 'release' });
  await second;
  await until((entry) => kind(entry) === 'kyrn:decision' && entry.event.turnId === 4, mark);
  const decisions = events.slice(mark).filter(isKind('kyrn:decision'));
  const turn4Began = events.find((entry) => kind(entry) === 'kyrn:preflight.pending' && entry.event.turnId === 4).seq;
  const late = decisions.findLast((entry) => entry.seq > turn4Began);
  check(
    'a verdict that arrives during turn 4 still says turn 3 asked (needs the engine `origin` fix in the loaded KYRN checkout)',
    late?.event.turnId === 3 && decisions.length === 2,
    `decisions in arrival order: ${decisions.map((entry) => `turn ${entry.event.turnId} @seq ${entry.seq}`).join(', ')}; turn 4 began @seq ${turn4Began}`
  );

  // 4. The session tree is reachable in-process: the primitive judged rewind needs.
  const before = await call({ type: 'tree' });
  const branch = await call({ type: 'entries' });
  const rewindTo = branch.find((entry) => entry.role === 'assistant');
  await call({ type: 'navigate', entryId: rewindTo.id });
  await call({ type: 'script', judge: [{ turnType: 'chat' }], model: [{ text: 'A different continuation.' }] });
  await call({ type: 'prompt', text: 'take the other road' });
  const after = await call({ type: 'tree' });
  const find = (nodes, id) => nodes.flatMap((node) => (node.id === id ? [node] : find(node.children, id)))[0];
  check(
    'navigate + prompt creates a second branch under the chosen entry, in the same session file',
    find(after.tree, rewindTo.id)?.children.length === 2 && after.leaf !== before.leaf,
    `children under ${rewindTo.id.slice(0, 8)}: ${find(after.tree, rewindTo.id)?.children.length}`
  );

  // 5. Dialogs the ACP bridge cancels today (`input`, `editor`) are served by the app.
  mark = events.length;
  const asking = call({ type: 'prompt', text: '/ask' });
  const request = await until((entry) => entry.source === 'ui' && entry.event.kind === 'request', mark);
  await call({ type: 'ui_response', request: request.event.request, value: 'ada' });
  await asking;
  const greeting = await until((entry) => entry.source === 'ui' && entry.event.kind === 'notify', mark);
  check(
    'an extension `input` dialog round-trips through the host',
    request.event.method === 'input' && greeting.event.message === 'hello ada',
    `${request.event.method} → "${greeting.event.message}"`
  );

  // 6. Reload: a fresh reader of the session file sees messages and judgments, with the asking turn on each judgment.
  const reloaded = await call({ type: 'reload' });
  const ledger = reloaded.filter((entry) => entry.customType === 'kyrn.decision');
  check(
    'the session file alone rebuilds the view: messages, abort reason and judgments with their asking turn',
    reloaded.some((entry) => entry.stopReason === 'aborted') &&
      ledger.length >= 3 &&
      ledger.every((entry) => typeof entry.origin?.turn === 'number'),
    `${reloaded.length} entries in the file, ${ledger.length} judgments, origins: ${ledger.map((entry) => entry.origin?.turn).join(',')}`
  );

  const delivery = events.map((entry) => entry.deliveryMs).toSorted((a, b) => a - b);
  const pct = (p) => Number(delivery[Math.min(delivery.length - 1, Math.floor(delivery.length * p))].toFixed(2));
  await call({ type: 'close' });
  return {
    label,
    versions,
    sessionFile: opened.sessionFile ? 'file-backed' : 'in-memory',
    timings: { hostBootMs: bootMs, openSessionMs: openMs, abortToSettledMs: abortMs },
    events: {
      total: events.length,
      bySource: Object.fromEntries(
        ['session', 'kyrn', 'ui'].map((source) => [source, events.filter((entry) => entry.source === source).length])
      ),
    },
    deliveryMs: { p50: pct(0.5), p95: pct(0.95), max: pct(1) },
    checks,
    passed: checks.every((entry) => entry.pass),
  };
}
