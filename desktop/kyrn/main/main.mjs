import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RpcHost } from './rpc-host.mjs';
import { readProjectFile, saveProjectFile } from './files.mjs';
import { Preferences } from './preferences.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.KYRN_ROOT || join(here, '../../../KYRN'));
const launcher = join(root, 'kyrn/bin/kyrn');
const run = promisify(execFile);
app.setName('KYRN');
app.setPath('userData', join(app.getPath('appData'), 'KYRN Desktop'));
if (!app.requestSingleInstanceLock()) app.exit(0);
const home = app.getPath('userData');
mkdirSync(join(home, 'events'), { recursive: true, mode: 0o700 });
const indexPath = join(home, 'sessions.json');
const preferences = new Preferences(home, process.env.KYRN_AGENT_DIR || join(app.getPath('home'), '.kyrn/agent'));
let catalog = [];
try {
  catalog = JSON.parse(readFileSync(indexPath, 'utf8'));
} catch {}
const sessions = new Map();
let window;
const saveIndex = () => writeFileSync(indexPath, JSON.stringify(catalog, null, 2), { mode: 0o600 });
const journal = (id) => join(home, 'events', `${id}.jsonl`);
const persistent = (event) => !['message_update', 'tool_execution_update', 'response'].includes(event.type);

function emit(session, event) {
  const envelope = { sessionId: session.id, sequence: ++session.sequence, at: Date.now(), event };
  session.events.push(envelope);
  if (session.events.length > 6000) session.events.splice(0, session.events.length - 6000);
  if (persistent(event)) appendFileSync(journal(session.id), `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  if (event.type === 'agent_start') session.busy = true;
  if (event.type === 'agent_settled' || event.type === 'kyrn_host_exit') session.busy = false;
  if (event.type === 'kyrn_host_exit') session.dialogs.clear();
  if (event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(event.method))
    session.dialogs.set(event.id, event);
  if (window && !window.isDestroyed()) window.webContents.send('kyrn:event', envelope);
}

async function attach(meta) {
  if (sessions.has(meta.id) && !sessions.get(meta.id).host.stopped) return sessions.get(meta.id);
  let events = [];
  if (existsSync(journal(meta.id))) {
    try {
      events = readFileSync(journal(meta.id), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .slice(-6000);
    } catch {}
  }
  const session = { ...meta, sequence: events.at(-1)?.sequence || 0, events, busy: false, dialogs: new Map() };
  sessions.set(meta.id, session);
  const config = preferences.effective(meta.cwd);
  session.host = new RpcHost({
    launcher,
    cwd: meta.cwd,
    session: meta.file,
    env: { KYRN_JUDGE: config.judge, KYRN_JUDGE_MODE: config.mode },
    onEvent: (event) => emit(session, event),
  });
  try {
    const models = await session.host.send({ type: 'get_available_models' });
    session.models = models.models;
    if (!meta.file) {
      const selected = session.models.find((model) => `${model.provider}/${model.id}` === config.model);
      if (selected) await session.host.send({ type: 'set_model', provider: selected.provider, modelId: selected.id });
      const available = await session.host.send({ type: 'get_available_thinking_levels' });
      if (available.levels.includes(config.thinking))
        await session.host.send({ type: 'set_thinking_level', level: config.thinking });
    }
    const state = await session.host.send({ type: 'get_state' });
    meta.file = state.sessionFile;
    session.state = state;
    session.levels = (await session.host.send({ type: 'get_available_thinking_levels' })).levels;
    saveIndex();
    emit(session, { type: 'kyrn_host_ready', model: state.model });
  } catch (error) {
    emit(session, { type: 'kyrn_error', message: error.message });
  }
  return session;
}

function requireSession(id) {
  const session = sessions.get(id);
  if (!session) throw new Error('请先打开任务');
  return session;
}
const snapshot = (session) => ({
  id: session.id,
  cwd: session.cwd,
  title: session.title,
  events: session.events,
  busy: session.busy,
  state: session.state,
  models: session.models || [],
  levels: session.levels || [],
  dialogs: [...session.dialogs.values()],
});

const handlers = {
  bootstrap: async () => ({
    root,
    ready: existsSync(launcher),
    sessions: catalog.map((meta) => ({ id: meta.id, cwd: meta.cwd, title: meta.title })),
  }),
  create: async ({ cwd: existing }) => {
    let selected = existing;
    if (selected && !catalog.some((item) => item.cwd === selected)) throw new Error('请通过目录选择器添加项目');
    if (!selected) {
      const picked = await dialog.showOpenDialog(window, {
        title: '选择 KYRN 项目',
        defaultPath: root,
        properties: ['openDirectory'],
      });
      if (picked.canceled) return null;
      selected = picked.filePaths[0];
    }
    const cwd = await realpath(selected);
    const meta = { id: randomUUID(), cwd, title: '新任务' };
    catalog.unshift(meta);
    saveIndex();
    return snapshot(await attach(meta));
  },
  open: async ({ id }) => {
    const meta = catalog.find((item) => item.id === id);
    if (!meta) throw new Error('任务不存在');
    return snapshot(await attach(meta));
  },
  prompt: async ({ id, text, behavior }) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 200000) throw new Error('请输入有效消息');
    const session = requireSession(id);
    if (session.submitting) throw new Error('正在提交，请稍候');
    session.submitting = true;
    const midRun = session.busy;
    session.busy = true;
    const meta = catalog.find((item) => item.id === id);
    if (meta.title === '新任务') {
      meta.title = text.slice(0, 36);
      session.title = meta.title;
      saveIndex();
    }
    emit(session, { type: 'kyrn_submission', text, behavior: midRun ? behavior : undefined });
    try {
      // pi's prompt acknowledgement can arrive after the turn ends. Do not hold the IPC call open.
      void session.host
        .send({
          type: 'prompt',
          message: text,
          ...(midRun ? { streamingBehavior: behavior === 'steer' ? 'steer' : 'followUp' } : {}),
        })
        .then(async () => {
          if (text.trim().startsWith('/')) {
            const state = await session.host.send({ type: 'get_state' });
            session.busy = state.isStreaming || state.isCompacting;
            emit(session, { type: 'kyrn_state', busy: session.busy });
          }
        })
        .catch((error) => {
          session.busy = false;
          emit(session, { type: 'kyrn_error', message: error.message });
        })
        .finally(() => {
          session.submitting = false;
        });
      return { accepted: true };
    } catch (error) {
      session.busy = midRun;
      session.submitting = false;
      throw error;
    }
  },
  abort: async ({ id }) => requireSession(id).host.send({ type: 'abort' }),
  model: async ({ id, provider, modelId }) => {
    const session = requireSession(id);
    if (session.busy) throw new Error('请等待本轮结束再切换模型');
    if (!session.models.some((model) => model.provider === provider && model.id === modelId))
      throw new Error('模型不在已登录的可用列表中');
    await session.host.send({ type: 'set_model', provider, modelId });
    session.state = await session.host.send({ type: 'get_state' });
    session.levels = (await session.host.send({ type: 'get_available_thinking_levels' })).levels;
    return session.state;
  },
  thinking: async ({ id, level }) => {
    const session = requireSession(id);
    if (session.busy) throw new Error('请等待本轮结束再切换思考强度');
    const { levels } = await session.host.send({ type: 'get_available_thinking_levels' });
    if (!levels.includes(level)) throw new Error('当前模型不支持该思考强度');
    await session.host.send({ type: 'set_thinking_level', level });
    session.state = await session.host.send({ type: 'get_state' });
    return { state: session.state, levels };
  },
  preferences: async () => preferences.read(),
  savePreferences: async ({ scope, cwd, values }) => {
    if (scope === 'project' && !catalog.some((item) => item.cwd === cwd)) throw new Error('项目不存在');
    return preferences.save(scope, cwd, values);
  },
  swarm: async ({ id, action, name }) => {
    if (!['stop', 'kill'].includes(action) || (name && !/^[\w.-]{1,80}$/.test(name))) throw new Error('无效蜂群操作');
    return requireSession(id).host.send({ type: 'prompt', message: `/swarm ${action}${name ? ` ${name}` : ''}` });
  },
  respond: async ({ id, requestId, value, confirmed, cancelled }) => {
    const session = requireSession(id);
    if (!session.dialogs.has(requestId)) throw new Error('审批已失效');
    session.host.respond({ id: requestId, value, confirmed, cancelled });
    session.dialogs.delete(requestId);
    emit(session, { type: 'kyrn_approval_resolved', id: requestId });
  },
  files: async ({ id }) => {
    const { cwd } = requireSession(id);
    const result = await run('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd,
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return [...new Set(result.stdout.split('\n'))]
      .filter((path) => path && !/(^|\/)(\.env($|\.)|auth\.json$|node_modules\/)/.test(path))
      .slice(0, 3000);
  },
  read: async ({ id, path }) => readProjectFile(requireSession(id).cwd, path),
  save: async ({ id, path, text, revision }) => saveProjectFile(requireSession(id).cwd, path, text, revision),
  diff: async ({ id }) => {
    const { cwd } = requireSession(id);
    const opts = { cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024 };
    const args = ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv'];
    const paths = [
      '--',
      '.',
      ':(exclude)**/.env',
      ':(exclude)**/.env.*',
      ':(exclude)**/auth.json',
      ':(exclude)**/*.pem',
      ':(exclude)**/*.key',
    ];
    const [working, staged] = await Promise.all([
      run('git', [...args, ...paths], opts),
      run('git', [...args, '--cached', ...paths], opts),
    ]);
    return { working: working.stdout, staged: staged.stdout };
  },
};

function createWindow() {
  window = new BrowserWindow({
    width: 1460,
    height: 960,
    minWidth: 1000,
    minHeight: 680,
    title: 'KYRN',
    backgroundColor: '#f8f9fb',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  if (process.env.KYRN_RENDERER_URL) window.loadURL(process.env.KYRN_RENDERER_URL);
  else window.loadFile(join(here, '../dist/index.html'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
  );
  ipcMain.handle('kyrn:request', async (event, method, args = {}) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('Invalid caller');
    if (!Object.hasOwn(handlers, method)) throw new Error('Unknown command');
    return handlers[method](args);
  });
  createWindow();
});
app.on('second-instance', () => {
  if (!window || window.isDestroyed()) createWindow();
  else {
    window.show();
    window.focus();
  }
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
let quitting = false;
app.on('before-quit', (event) => {
  if (!quitting && [...sessions.values()].some((session) => session.busy)) {
    event.preventDefault();
    void dialog
      .showMessageBox({
        type: 'question',
        message: '有任务正在运行，退出将停止这些任务。',
        buttons: ['继续运行', '停止并退出'],
        defaultId: 0,
        cancelId: 0,
      })
      .then((result) => {
        if (result.response === 1) {
          quitting = true;
          app.quit();
        }
      });
    return;
  }
  for (const session of sessions.values()) session.host.close();
});
