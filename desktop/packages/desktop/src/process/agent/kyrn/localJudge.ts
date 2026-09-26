import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Readable } from 'node:stream';
import { KyrnError } from '../../../common/kyrn/errors';
import type {
  LocalJudgeAction,
  LocalJudgeState,
  LocalJudgeSupport,
  LocalJudgeTask,
} from '../../../common/kyrn/localJudge';

/** What a task needs of a child process. */
export type TaskProcess = {
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
};

export type LocalJudgeDeps = {
  spawn: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => TaskProcess;
  /** Whether the judge's health check answers at this address. */
  health: (url: string) => Promise<boolean>;
  exists: (path: string) => boolean;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /**
   * Where the venv and the weights are: beside the sidecar in a checkout, in mu's home for the npm package, which
   * npm replaces on every update (the script decides the same way).
   */
  stateDir?: string;
  /** A file's text, or undefined when it cannot be read. */
  readFile: (path: string) => string | undefined;
  /** Whether a process with this id runs and may be signalled, as the script's `kill -0` asks. */
  alive: (pid: number) => boolean;
};

const ACTIONS: ReadonlySet<string> = new Set<LocalJudgeAction>(['setup', 'start', 'stop']);
/** How many of the script's lines are kept: enough for progress and for why it stopped. */
const OUTPUT_LINES = 12;
const LINE_CHARS = 300;
// oxlint-disable-next-line no-control-regex -- terminal colour codes are what this removes
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return typeof body.status === 'string';
  } catch {
    return false;
  }
}

const defaults = (): LocalJudgeDeps => ({
  spawn: (command, args, options) => nodeSpawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
  health,
  exists: existsSync,
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  home: homedir(),
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * Installs, starts and stops the local judge with the harness's script, one action at a time, and says where it
 * stands. Installing downloads (see `LOCAL_JUDGE_DOWNLOAD_MB`) and is only started with the person's consent.
 */
export class LocalJudge {
  private root: string;
  private deps: LocalJudgeDeps;
  private task?: LocalJudgeTask;
  private next = 0;

  /** @param root the harness checkout */
  constructor(root: string, deps: Partial<LocalJudgeDeps> = {}) {
    this.root = root;
    this.deps = { ...defaults(), ...deps };
  }

  private get url(): string {
    const { env } = this.deps;
    return `http://127.0.0.1:${env.MU_LOCAL_JUDGE_PORT || env.KYRN_LOCAL_JUDGE_PORT || '47823'}`;
  }

  /** The script's PATH: a Mac app gets a short one, and uv usually sits in one of these. */
  private path(): string {
    const { env, home, platform } = this.deps;
    const extra =
      platform === 'darwin'
        ? [join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
        : [];
    return [...extra, env.PATH ?? ''].filter(Boolean).join(delimiter);
  }

  private support(): LocalJudgeSupport {
    const { platform, arch, exists } = this.deps;
    if (platform !== 'darwin' || arch !== 'arm64') return 'platform';
    return this.path()
      .split(delimiter)
      .some((dir) => dir && exists(join(dir, 'uv')))
      ? 'ok'
      : 'uv';
  }

  private installed(): boolean {
    const { env, exists, stateDir } = this.deps;
    const home = stateDir ?? join(this.root, 'kyrn', 'local-judge');
    const models =
      env.MU_LOCAL_JUDGE_MODEL || env.KYRN_LOCAL_JUDGE_MODEL || join(home, 'models', 'laya-multilingual-coreml');
    return exists(join(home, '.venv', 'bin', 'python')) && exists(join(models, 'coreml_config.json'));
  }

  /**
   * Whether the judge was started by mu: the script keeps its pid in mu's home (`~/.mu/local-judge`, or `~/.kyrn` on
   * a machine whose home has not been moved), and only a live process named there can be stopped from here.
   */
  private started(): boolean {
    const { env, home, exists, readFile, alive } = this.deps;
    const muDir = exists(join(home, '.mu')) || !exists(join(home, '.kyrn')) ? join(home, '.mu') : join(home, '.kyrn');
    const runDir = env.MU_LOCAL_JUDGE_RUN_DIR || env.KYRN_LOCAL_JUDGE_RUN_DIR || join(muDir, 'local-judge');
    const pid = Number.parseInt(readFile(join(runDir, 'judge.pid'))?.trim() ?? '', 10);
    return pid > 0 && alive(pid);
  }

  async state(): Promise<LocalJudgeState> {
    const support = this.support();
    const installed = this.installed();
    const running = await this.deps.health(this.url);
    return {
      support,
      runtime: 'coreml',
      installed,
      running,
      url: this.url,
      ...(this.task ? { task: { ...this.task } } : {}),
    };
  }

  /**
   * Starts an action unless one is running. `setup` needs `consent` (the person agreed to the download) and a machine
   * that can run the judge; a setup that finishes goes on to start the judge, so one click ends with it running.
   */
  async run(action: LocalJudgeAction, consent = false): Promise<LocalJudgeState> {
    if (!ACTIONS.has(action)) throw new KyrnError('invalid', `Unknown local judge action: ${String(action)}`);
    if (this.task?.phase === 'running') return this.state();
    if (action === 'setup') {
      if (!consent) throw new KyrnError('invalid', 'Installing the local judge downloads files: it needs consent');
      if (this.support() !== 'ok') throw new KyrnError('invalid', 'This machine cannot install the local judge');
    }
    // A judge that answers but was not started by mu (another home, another user's session) cannot be stopped from
    // here: the script would say it is not running, and the panel would still show it running.
    if (action === 'stop' && !this.started() && (await this.deps.health(this.url))) {
      this.task = { id: ++this.next, action, phase: 'failed', output: [], problem: 'foreign' };
      return this.state();
    }
    const task: LocalJudgeTask = { id: ++this.next, action, phase: 'running', output: [] };
    this.task = task;
    this.step(task, action === 'setup' ? ['setup', 'start'] : [action]);
    return this.state();
  }

  private step(task: LocalJudgeTask, actions: LocalJudgeAction[]): void {
    const [action, ...rest] = actions;
    task.action = action;
    const say = (chunk: Buffer | string) => {
      const lines = String(chunk)
        .replace(ANSI, '')
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line));
      task.output = [...task.output, ...lines].slice(-OUTPUT_LINES);
    };
    let child: TaskProcess;
    try {
      child = this.deps.spawn('/bin/bash', [join(this.root, 'kyrn', 'bin', 'kyrn-judge-local'), action], {
        cwd: this.root,
        env: { ...this.deps.env, PATH: this.path() },
      });
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
      task.phase = 'failed';
      return;
    }
    child.stdout?.on('data', say);
    child.stderr?.on('data', say);
    let ended = false;
    child.on('error', (error) => {
      if (ended) return;
      ended = true;
      say(error.message);
      task.phase = 'failed';
    });
    child.on('close', (code) => {
      if (ended) return;
      ended = true;
      if (code !== 0) task.phase = 'failed';
      else if (rest.length) this.step(task, rest);
      else task.phase = 'done';
    });
  }
}
