// Starts the mu desktop app for the conversation E2E test and keeps what it says: the main process's output, the
// renderer's console and page errors, and the backend's log folder. `problems()` lists the errors nothing handled,
// which fail the test; `leftoverProcesses()` lists what still runs from the profile after a quit.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mainCheckout } from './profile.mjs';

/** Lines of the main process's output that mean an error nothing handled. */
const MAIN_PROBLEMS = [
  /\[AionUi\] (uncaughtException|unhandledRejection)/,
  /render-process-gone/,
  /\[AionUi\] App initialization failed/,
  /Failed to initialize process/,
];
/** Lines of the logs that mean the adapter or mu met an error nothing handled. */
const ADAPTER_PROBLEMS = [
  /\[mu\] a promise failed and nothing handled it/,
  /\[mu\] the adapter stops on an error nothing handled/,
  /\[mu\] handling a .* event failed/,
  /\[mu\] the harness stopped by itself/,
  /\[mu\] the harness stopped reading its input/,
  /\bEPIPE\b/,
];
/**
 * Renderer console errors that mean a page broke: a route's error screen (the page caught the error, so it is no
 * page error), or an error React reports from a render.
 */
const RENDERER_PROBLEMS = [
  /\[Route\] Page failed to load or render/,
  /The above error occurred in/,
  /^error: (Uncaught )?(TypeError|ReferenceError|RangeError|SyntaxError)\b/,
];

/** Every file under a folder, recursively. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** Where an Electron package keeps its executable, under its `dist` folder. */
const ELECTRON_EXECUTABLE = {
  darwin: ['Electron.app', 'Contents', 'MacOS', 'Electron'],
  win32: ['electron.exe'],
}[process.platform] ?? ['electron'];

/**
 * The Electron executable to start: MU_E2E_ELECTRON, else ELECTRON_EXEC_PATH (what electron-vite and
 * `scripts/kyrn/start` start), else the one of this checkout's `electron` package, else the one `scripts/kyrn/start`
 * falls back to (`kyrn/node_modules/electron`, here or in the main checkout of a worktree).
 *
 * The package's own `dist` is read, never `require('electron')` of a package that has none: a checkout installed
 * without its install scripts has no Electron in the package, and a newer package's `require` downloads it then.
 */
export function electronBinary(desktopRoot) {
  const named = process.env.MU_E2E_ELECTRON || process.env.ELECTRON_EXEC_PATH;
  if (named) return named;
  const roots = [...new Set([desktopRoot, mainCheckout(desktopRoot)])];
  const packages = [
    ...roots.map((root) => {
      try {
        return dirname(createRequire(join(root, 'package.json')).resolve('electron/package.json'));
      } catch {
        return undefined;
      }
    }),
    ...roots.map((root) => join(root, 'kyrn', 'node_modules', 'electron')),
  ].filter(Boolean);
  for (const folder of packages) {
    const executable = join(folder, 'dist', ...ELECTRON_EXECUTABLE);
    if (existsSync(executable)) return executable;
  }
  throw new Error(
    `No Electron executable found (looked in ${packages.map((folder) => join(folder, 'dist')).join(', ')}). ` +
      'Set MU_E2E_ELECTRON (or ELECTRON_EXEC_PATH) to one.'
  );
}

/**
 * Starts the app. `run` names this start in the log files (the test starts the app twice). `electron` is Playwright's
 * Electron launcher (the test passes the one of @playwright/test, so its `expect` knows the pages); by default the
 * checkout's `playwright`. A packaged app is started when MU_E2E_APP names its executable; otherwise the build in
 * `<desktopRoot>/out`.
 */
export async function launchApp({ desktopRoot, profile, run, electron }) {
  const launcher = electron ?? createRequire(join(desktopRoot, 'package.json'))('playwright')._electron;
  const logs = profile.paths.logs;
  const mainLog = join(logs, `main-${run}.log`);
  const rendererLog = join(logs, `renderer-${run}.log`);
  const packaged = process.env.MU_E2E_APP;
  const args = [`--lang=${profile.language}`];
  if (!packaged) args.push(desktopRoot);
  if (process.platform === 'linux') args.push('--no-sandbox');
  const app = await launcher.launch({
    executablePath: packaged || electronBinary(desktopRoot),
    args,
    cwd: desktopRoot,
    env: profile.env,
    timeout: 120_000,
  });
  const state = { app, page: undefined, mainLog, rendererLog, pageErrors: [], consoleErrors: [], exited: false };
  const child = app.process();
  const keep = (chunk) => appendFileSync(mainLog, chunk);
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('exit', (code, signal) => {
    state.exited = true;
    appendFileSync(mainLog, `\n[e2e] the app exited (code ${code}, signal ${signal})\n`);
  });
  const isMain = (page) => !page.url().startsWith('devtools://');
  let page = app.windows().find(isMain);
  while (!page) {
    const next = await app.waitForEvent('window', { timeout: 90_000 });
    if (isMain(next)) page = next;
  }
  page.on('console', (message) => {
    const line = `${message.type()}: ${message.text()}`;
    appendFileSync(rendererLog, `${line}\n`);
    if (message.type() === 'error') state.consoleErrors.push(line);
  });
  page.on('pageerror', (error) => {
    const line = `pageerror: ${error.stack || error.message}`;
    appendFileSync(rendererLog, `${line}\n`);
    state.pageErrors.push(line);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(document.querySelector('#root')?.children.length), undefined, {
    timeout: 90_000,
  });
  state.page = page;
  return state;
}

/** Quits the app the way a person does (the app's own quit), and waits for it to be gone. */
export async function quitApp(state) {
  if (!state || state.exited) return;
  await state.app.evaluate(({ app }) => app.quit()).catch(() => {});
  const deadline = Date.now() + 30_000;
  while (!state.exited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  if (!state.exited) await state.app.close().catch(() => {});
}

/** The lines of a file that match any of the patterns. */
function matching(file, patterns) {
  if (!existsSync(file) || !statSync(file).isFile()) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => patterns.some((pattern) => pattern.test(line)));
}

/**
 * Errors nothing handled, in this start of the app: page errors, renderer console errors that mean a broken page, the
 * main process's own reports, and the adapter's and mu's reports in the logs (the backend logs the adapter's error
 * output).
 */
export function problems(state, profile, { ignore = [] } = {}) {
  const found = [
    ...state.pageErrors,
    ...state.consoleErrors.filter((line) => RENDERER_PROBLEMS.some((pattern) => pattern.test(line))),
    ...matching(state.mainLog, MAIN_PROBLEMS),
    ...matching(state.mainLog, ADAPTER_PROBLEMS),
    ...filesUnder(join(profile.paths.userData, 'logs')).flatMap((file) =>
      matching(file, ADAPTER_PROBLEMS).map((line) => `${file}: ${line}`)
    ),
  ];
  return [...new Set(found)].filter((line) => !ignore.some((pattern) => pattern.test(line)));
}

/** Every process as { pid, ppid, command }, or none where `ps` is not there to ask (Windows). */
function processes() {
  if (process.platform === 'win32') return [];
  try {
    return execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter(Boolean)
      .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
  } catch {
    return [];
  }
}

/** The processes started under `pid` (the app's main process: the backend, the adapter, mu and their children). */
export function processTree(pid) {
  const all = processes();
  const found = [];
  const parents = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of all) {
      if (parents.has(entry.ppid) && !parents.has(entry.pid)) {
        parents.add(entry.pid);
        found.push({ pid: entry.pid, command: entry.command });
        grew = true;
      }
    }
  }
  return found;
}

/**
 * What still runs after a quit: any of `seen` (processes the app started, gathered while it ran) that is alive, and
 * any process whose command line names the profile's folder (the backend's data folder, Electron's user data, mu from
 * the profile's view of the harness).
 */
export function leftoverProcesses(profile, seen = []) {
  const running = processes().filter((entry) => entry.pid !== process.pid);
  // The same pid and command line: a pid the system has given to another process since is not a leftover.
  const seenCommands = new Map(seen.map((entry) => [entry.pid, entry.command]));
  return running
    .filter((entry) => seenCommands.get(entry.pid) === entry.command || entry.command.includes(profile.paths.root))
    .filter((entry) => !entry.command.startsWith('ps -axww'))
    .map(({ pid, command }) => ({ pid, command }));
}
