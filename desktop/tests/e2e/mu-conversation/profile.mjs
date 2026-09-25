// The throwaway world the mu conversation E2E test runs the app in: a home folder, Electron's user data, mu's agent
// folder, a project folder and a view of the harness, all under one temporary folder. Nothing the app writes can land
// in the person's own ~/.mu, app data or harness checkout:
//
// - HOME (and CFFIXED_USER_HOME, which Core Foundation reads on macOS) is a fresh folder, so `~/.mu`, `~/Library` and
//   every dotfile an agent or tool touches are the test's own.
// - AIONUI_E2E_USER_DATA_DIR moves Electron's user data and logs (configureChromium.ts).
// - MU_AGENT_DIR is a folder of its own, apart from `<home>/.mu/agent`, so the test also shows that every part of the
//   app and of mu uses the one the person named.
// - The harness is run through a view of the checkout (symlinks) whose own `.env` is the test's: a checkout keeps its
//   keys in `<root>/.env`, and the app writes a provider's key there. The checkout's own `.env` is never opened.
// - The environment is built from a short list, not copied: no key or token of the person running the test reaches the
//   app.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

/** pi's minimum Node, the same as the harness launcher's. */
const MIN_NODE = [22, 19];

/** mu.json of the test's agent folder: the offline judge, and every decision point on its fallback. */
export const JUDGE_CONFIG = { tiers: ['mock'], modes: { default: 'off' } };

const versionOk = (version) => {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
};

/** The main checkout of a git worktree (its common git folder's parent), or the folder itself. */
export function mainCheckout(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return dirname(common);
  } catch {
    return root;
  }
}

/** The harness checkout (or npm package) to run: MU_ROOT / KYRN_ROOT, else `../KYRN` beside the desktop checkout. */
export function findHarnessSource(desktopRoot) {
  const named = process.env.MU_ROOT || process.env.KYRN_ROOT;
  const candidates = named
    ? [resolve(named)]
    : [join(desktopRoot, '..', 'KYRN'), join(mainCheckout(desktopRoot), '..', 'KYRN')];
  for (const root of candidates) {
    if (existsSync(join(root, 'kyrn', 'bin', 'mu.mjs'))) {
      const layout = existsSync(join(root, 'packages', 'coding-agent', 'package.json')) ? 'repo' : 'package';
      return { root: realpathSync(root), layout };
    }
  }
  throw new Error(
    `No mu harness found (looked in ${candidates.join(', ')}). Set MU_ROOT to a harness checkout or a mu-agent package.`
  );
}

/** The AionCore binary: AIONUI_BACKEND_BIN, the bundled one in this checkout or the main one, or `aioncore` on PATH. */
export function findBackend(desktopRoot) {
  if (process.env.AIONUI_BACKEND_BIN) return resolve(process.env.AIONUI_BACKEND_BIN);
  const name = process.platform === 'win32' ? 'aioncore.exe' : 'aioncore';
  const key = `${process.platform}-${process.arch}`;
  for (const root of [desktopRoot, mainCheckout(desktopRoot)]) {
    const candidate = join(root, 'resources', 'bundled-aioncore', key, name);
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error(
    'No aioncore binary found. Set AIONUI_BACKEND_BIN, or put it in resources/bundled-aioncore/<platform>-<arch>/.'
  );
}

/** A Node that can run mu (>= 22.19): MU_E2E_NODE, the one running this, one on PATH, or one from nvm. */
export function findNode() {
  const candidates = [];
  if (process.env.MU_E2E_NODE) candidates.push(process.env.MU_E2E_NODE);
  if (!process.versions.bun && /node(\.exe)?$/i.test(process.execPath)) candidates.push(process.execPath);
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) candidates.push(join(dir, exe));
  const nvm = join(process.env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node');
  if (existsSync(nvm)) {
    const versions = readdirSync(nvm).sort((a, b) => {
      const [x, y] = [a, b].map((v) => v.replace(/^v/, '').split('.').map(Number));
      for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
      return 0;
    });
    for (const version of versions) candidates.push(join(nvm, version, 'bin', exe));
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
      if (versionOk(version)) return { bin: candidate, dir: dirname(candidate), version };
    } catch {
      // Not runnable: try the next one.
    }
  }
  throw new Error(`No Node ${MIN_NODE.join('.')} or newer found. Set MU_E2E_NODE to one.`);
}

/**
 * A view of a harness checkout whose `.env` is its own: every entry of the checkout is linked, except the key files,
 * git's folder and `kyrn/bin`, which is copied (the launcher finds the checkout from where it really is).
 */
function harnessView(source, target) {
  mkdirSync(join(target, 'kyrn', 'bin'), { recursive: true });
  const skipped = (name) => name.startsWith('.env') || ['.git', '.claude', '.codex', 'kyrn'].includes(name);
  for (const name of readdirSync(source)) {
    if (!skipped(name)) symlinkSync(join(source, name), join(target, name));
  }
  for (const name of readdirSync(join(source, 'kyrn'))) {
    if (name !== 'bin' && !name.startsWith('.env')) symlinkSync(join(source, 'kyrn', name), join(target, 'kyrn', name));
  }
  for (const name of readdirSync(join(source, 'kyrn', 'bin'))) {
    const from = join(source, 'kyrn', 'bin', name);
    if (!statSync(from).isFile()) continue;
    const to = join(target, 'kyrn', 'bin', name);
    copyFileSync(from, to);
    chmodSync(to, statSync(from).mode & 0o777);
  }
  return target;
}

/**
 * Creates the profile. `root` defaults to a new folder in the system's temporary folder. Returns every path and the
 * environment the app is started with.
 */
export function createProfile({ desktopRoot, root, language = 'zh-CN' } = {}) {
  const base = realpathSync(root ?? mkdtempSync(join(tmpdir(), 'mu-e2e-')));
  const paths = {
    root: base,
    home: join(base, 'home'),
    userData: join(base, 'userData'),
    agentDir: join(base, 'agent'),
    project: join(base, 'project'),
    harness: join(base, 'harness'),
    logs: join(base, 'logs'),
  };
  for (const dir of [paths.home, paths.userData, paths.agentDir, paths.project, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(paths.project, 'README.md'), '# E2E project\n\nA folder for the mu conversation test.\n');
  // mu's judgment configuration: the offline `mock` judge, and every decision point off, so each one takes its fixed
  // fallback. The same run every time, and no judge is called. (MU_JUDGE=off would switch the whole judgment layer off,
  // permission modes and the board with it.)
  writeFileSync(join(paths.agentDir, 'mu.json'), `${JSON.stringify(JUDGE_CONFIG, null, 2)}\n`);

  const node = findNode();
  // The app replaces PATH with the login shell's (fix-path), which in this home is the system's, then adds every nvm
  // Node under the home: the chosen Node is linked there, so the adapter and mu find it after that too.
  const nvmVersion = join(
    paths.home,
    '.nvm',
    'versions',
    'node',
    node.version.startsWith('v') ? node.version : `v${node.version}`
  );
  mkdirSync(dirname(nvmVersion), { recursive: true });
  symlinkSync(dirname(node.dir), nvmVersion);

  const source = findHarnessSource(desktopRoot);
  const harnessRoot = source.layout === 'repo' ? harnessView(source.root, paths.harness) : source.root;
  const backend = findBackend(desktopRoot);

  const inherited = ['USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'];
  const env = {};
  for (const name of inherited) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    HOME: paths.home,
    CFFIXED_USER_HOME: paths.home,
    PATH: [node.dir, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    LANG: language === 'zh-CN' ? 'zh_CN.UTF-8' : 'en_US.UTF-8',
    NODE_ENV: 'production',
    // The app's own E2E switches: its user data in the profile, no mu:// registration, no tray, no update checks, no
    // single-instance lock, no devtools.
    AIONUI_E2E_TEST: '1',
    AIONUI_E2E_USER_DATA_DIR: paths.userData,
    AIONUI_DISABLE_AUTO_UPDATE: '1',
    AIONUI_DISABLE_DEVTOOLS: '1',
    AIONUI_BACKEND_BIN: backend,
    // The backend's Node.js runtime (about 50 MB from nodejs.org) is declined, as a person can decline it.
    MU_NODE_RUNTIME: 'later',
    KYRN_DESKTOP_ROOT: desktopRoot,
    MU_ROOT: harnessRoot,
    KYRN_ROOT: harnessRoot,
    MU_AGENT_DIR: paths.agentDir,
  });
  return { paths, env, node, backend, harness: { ...source, view: harnessRoot }, language };
}
