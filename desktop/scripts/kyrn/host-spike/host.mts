/**
 * Runtime host spike: pi's SDK and the KYRN judgment extension running INSIDE a process the app owns,
 * instead of behind `kyrn --mode rpc` + an ACP adapter. One ordered, typed stream leaves this process.
 *
 * Synthetic only: a faux model, a mock judge, temp directories. No real model, no real config, no credentials.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** parent → host */
export type HostCommand =
  | { id: number; type: 'open'; preflightWaitMs?: number; tokensPerSecond?: number }
  | { id: number; type: 'script'; model?: ScriptedReply[]; judge?: ScriptedVerdict[] }
  | { id: number; type: 'release' }
  | { id: number; type: 'prompt'; text: string }
  | { id: number; type: 'abort' }
  | { id: number; type: 'tree' }
  | { id: number; type: 'entries' }
  | { id: number; type: 'navigate'; entryId: string }
  | { id: number; type: 'reload' }
  | { id: number; type: 'ui_response'; request: string; value?: string; confirmed?: boolean; cancelled?: boolean }
  | { id: number; type: 'close' };

/** One assistant message of the faux model. */
export type ScriptedReply = {
  thinking?: string;
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
};
/** One answer of the mock judge; `holdMs` keeps it thinking, `hold: true` until a `release` command. */
export type ScriptedVerdict = { turnType: string; holdMs?: number; hold?: boolean };

/** host → parent. `seq` orders session events and judgment events in ONE sequence. */
export type HostMessage =
  | { type: 'ready'; versions: Record<string, string | undefined> }
  | { type: 'response'; id: number; ok: true; data?: unknown }
  | { type: 'response'; id: number; ok: false; error: string }
  | { type: 'event'; seq: number; at: number; source: 'session' | 'kyrn' | 'ui'; event: Record<string, unknown> };

type Port = { post(message: HostMessage): void; listen(handler: (command: HostCommand) => void): void };

function parentPort(): Port {
  // Electron utility process: a MessagePort with structured clone. Plain Node child: the IPC channel.
  const electron = (process as unknown as { parentPort?: ElectronParentPort }).parentPort;
  if (electron)
    return {
      post: (message) => electron.postMessage(message),
      listen: (handler) => electron.on('message', (event) => handler(event.data as HostCommand)),
    };
  if (!process.send) throw new Error('The host needs a parent: Electron utilityProcess or child_process.fork');
  return {
    post: (message) => void process.send?.(message),
    listen: (handler) => void process.on('message', (command) => handler(command as HostCommand)),
  };
}
type ElectronParentPort = {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
};

const root = process.env.KYRN_ROOT;
if (!root) throw new Error('KYRN_ROOT is required');
// pi and kyrn-judge are loaded from source, exactly as the CLI launcher runs them.
// oxlint-disable-next-line typescript/no-explicit-any
const load = (path: string): Promise<any> => import(pathToFileURL(join(root, path)).href);

const port = parentPort();
let seq = 0;
const emit = (source: 'session' | 'kyrn' | 'ui', event: Record<string, unknown>): void =>
  port.post({ type: 'event', seq: ++seq, at: performance.timeOrigin + performance.now(), source, event });

const [pi, ai, compat, authStorage, kyrn, kyrnConfig, mock] = await Promise.all([
  load('packages/coding-agent/src/index.ts'),
  load('packages/ai/src/index.ts'),
  load('packages/ai/src/compat.ts'),
  load('packages/coding-agent/src/core/auth-storage.ts'),
  load('packages/kyrn-judge/src/extension/kyrn-judge.ts'),
  load('packages/kyrn-judge/src/config.ts'),
  load('packages/kyrn-judge/src/providers/mock.ts'),
]);

const temp = mkdtempSync(join(tmpdir(), 'kyrn-host-spike-'));
const cwd = join(temp, 'project');
const agentDir = join(temp, 'agent');
const sessionsDir = join(temp, 'sessions');
for (const dir of [cwd, agentDir, sessionsDir]) mkdirSync(dir, { recursive: true });

const verdicts: ScriptedVerdict[] = [];
let releaseHeld: (() => void)[] = [];
// oxlint-disable-next-line typescript/no-explicit-any
let session: any;
// oxlint-disable-next-line typescript/no-explicit-any
let faux: any;
const dialogs = new Map<string, (answer: Extract<HostCommand, { type: 'ui_response' }>) => void>();

function uiContext(): unknown {
  const ask = (method: string, fields: Record<string, unknown>) =>
    new Promise<Extract<HostCommand, { type: 'ui_response' }>>((resolve) => {
      const request = `ui-${dialogs.size + 1}-${Date.now()}`;
      dialogs.set(request, resolve);
      emit('ui', { kind: 'request', request, method, ...fields });
    });
  const served: Record<string, unknown> = {
    select: async (title: string, options: string[]) => (await ask('select', { title, options })).value,
    confirm: async (title: string, message: string) => (await ask('confirm', { title, message })).confirmed === true,
    input: async (title: string, placeholder?: string) => (await ask('input', { title, placeholder })).value,
    editor: async (title: string, prefill?: string) => (await ask('editor', { title, prefill })).value,
    notify: (message: string, level?: string) => emit('ui', { kind: 'notify', message, level }),
    setTitle: (title: string) => emit('ui', { kind: 'title', title }),
    setStatus: (key: string, text: string | undefined) => {
      // In RPC mode the judgment events ride on this call as JSON. In-process they arrive typed, so that copy is dropped.
      if (key !== 'kyrn.presentation.v1') emit('ui', { kind: 'status', key, text });
    },
    onTerminalInput: () => () => {},
    getEditorText: () => '',
    getAllThemes: () => [],
  };
  // The rest of pi's UI surface (widgets, footers, custom components) is a no-op in this spike.
  return new Proxy(served, { get: (target, name: string) => target[name] ?? (() => undefined) });
}

async function open(command: Extract<HostCommand, { type: 'open' }>): Promise<unknown> {
  faux = compat.registerFauxProvider({ tokensPerSecond: command.tokensPerSecond ?? 0 });
  faux.setResponses([]);
  const model = faux.getModel();
  const auth = authStorage.AuthStorage.inMemory();
  await auth.modify(model.provider, async () => ({ type: 'api_key', key: 'faux-key' }));
  const modelRuntime = await pi.ModelRuntime.create({ credentials: auth, modelsPath: null, allowModelNetwork: false });
  new pi.ModelRegistry(modelRuntime).registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: 'faux-key',
    api: faux.api,
    models: faux.models.map((m: Record<string, unknown>) => ({
      id: m.id,
      name: m.name,
      api: m.api,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      baseUrl: m.baseUrl,
    })),
  });

  const judge = new mock.MockJudgeProvider(async () => {
    const verdict = verdicts.shift() ?? { turnType: 'chat' };
    if (verdict.hold) await new Promise<void>((resolve) => releaseHeld.push(resolve));
    else if (verdict.holdMs) await new Promise((resolve) => setTimeout(resolve, verdict.holdMs));
    return { turn_type: { type: 'choice', choice: verdict.turnType, probabilities: { [verdict.turnType]: 0.95 } } };
  });
  const judgment = kyrn.createKyrnJudgeExtension({
    provider: judge,
    mode: 'active',
    only: ['preflight'],
    config: kyrnConfig.parseConfig({ features: { preflight: { waitMs: command.preflightWaitMs ?? 6000 } } }),
    // The hook this spike is about: judgment events as objects, in this process, in order with session events.
    onPresentation: (event: Record<string, unknown>) => emit('kyrn', event),
  });
  // A dialog pi's ACP bridge cannot carry today: the adapter cancels `input` and `editor` requests.
  // oxlint-disable-next-line typescript/no-explicit-any
  const dialog = (api: any): void =>
    api.registerCommand('ask', {
      description: 'Spike: ask the app for a line of text',
      // oxlint-disable-next-line typescript/no-explicit-any
      handler: async (_args: string, ctx: any) => {
        const name = await ctx.ui.input('Who is asking?', 'name');
        ctx.ui.notify(`hello ${name ?? 'nobody'}`, 'info');
      },
    });

  const settingsManager = pi.SettingsManager.inMemory({});
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [judgment, dialog],
  });
  await resourceLoader.reload();
  const created = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    settingsManager,
    resourceLoader,
    sessionManager: pi.SessionManager.create(cwd, sessionsDir),
    noTools: 'builtin',
  });
  session = created.session;
  session.subscribe((event: Record<string, unknown>) => emit('session', slim(event)));
  await session.bindExtensions({ uiContext: uiContext(), mode: 'rpc' });
  return { sessionFile: session.sessionManager.getSessionFile(), model: `${model.provider}/${model.id}` };
}

/** Streaming events repeat the whole partial message; the wire format only needs the delta. */
function slim(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type !== 'message_update') return event;
  const update = (event.assistantMessageEvent ?? {}) as Record<string, unknown>;
  return { type: 'message_update', kind: update.type, delta: update.delta, contentIndex: update.contentIndex };
}

function reply(scripted: ScriptedReply): unknown {
  const content = [
    ...(scripted.thinking ? [ai.fauxThinking(scripted.thinking)] : []),
    ...(scripted.text ? [ai.fauxText(scripted.text)] : []),
    ...(scripted.tool ? [ai.fauxToolCall(scripted.tool.name, scripted.tool.args)] : []),
  ];
  return ai.fauxAssistantMessage(content, scripted.tool ? { stopReason: 'toolUse' } : {});
}

const tree = (nodes: Record<string, unknown>[]): unknown[] =>
  // oxlint-disable-next-line typescript/no-explicit-any
  nodes.map((node: any) => ({
    id: node.entry.id,
    type: node.entry.type,
    role: node.entry.message?.role,
    customType: node.entry.customType,
    children: tree(node.children ?? []),
  }));

async function handle(command: HostCommand): Promise<unknown> {
  switch (command.type) {
    case 'open':
      return open(command);
    case 'script':
      if (command.model) faux.appendResponses(command.model.map(reply));
      if (command.judge) verdicts.push(...command.judge);
      return undefined;
    case 'release':
      for (const release of releaseHeld) release();
      releaseHeld = [];
      return undefined;
    case 'prompt':
      // Resolves when the turn is over, not when it was accepted: no state polling needed to find the end.
      await session.prompt(command.text);
      return { leaf: session.sessionManager.getLeafId() };
    case 'abort':
      await session.abort();
      return undefined;
    case 'tree':
      return { leaf: session.sessionManager.getLeafId(), tree: tree(session.sessionManager.getTree()) };
    case 'entries':
      // oxlint-disable-next-line typescript/no-explicit-any
      return session.sessionManager.getBranch().map((entry: any) => ({
        id: entry.id,
        type: entry.type,
        role: entry.message?.role,
        stopReason: entry.message?.stopReason,
        customType: entry.customType,
        specId: entry.data?.specId,
        origin: entry.data?.origin,
      }));
    case 'navigate':
      return session.navigateTree(command.entryId, { summarize: false });
    case 'reload': {
      // What a restart sees: the same file, read by a fresh manager. View state must be derivable from it alone.
      const reopened = pi.SessionManager.open(session.sessionManager.getSessionFile(), sessionsDir);
      // Every entry of the file, abandoned branches included.
      // oxlint-disable-next-line typescript/no-explicit-any
      return reopened.getEntries().map((entry: any) => ({
        id: entry.id,
        type: entry.type,
        role: entry.message?.role,
        stopReason: entry.message?.stopReason,
        customType: entry.customType,
        origin: entry.data?.origin,
      }));
    }
    case 'ui_response': {
      const resolve = dialogs.get(command.request);
      if (!resolve) throw new Error(`No dialog ${command.request}`);
      dialogs.delete(command.request);
      resolve(command);
      return undefined;
    }
    case 'close':
      session?.dispose();
      faux?.unregister();
      rmSync(temp, { recursive: true, force: true });
      setTimeout(() => process.exit(0), 20);
      return undefined;
  }
}

port.listen((command) => {
  handle(command).then(
    (data) => port.post({ type: 'response', id: command.id, ok: true, data }),
    (error: unknown) =>
      port.post({
        type: 'response',
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
  );
});
port.post({
  type: 'ready',
  versions: { node: process.versions.node, electron: process.versions.electron, v8: process.versions.v8 },
});
