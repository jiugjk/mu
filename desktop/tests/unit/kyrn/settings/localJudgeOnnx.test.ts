import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OnnxLocalJudge,
  usesOnnxJudge,
  wantsLocalJudge,
  type JudgeChild,
  type OnnxJudgeDeps,
} from '@/process/agent/kyrn/localJudgeOnnx';
import type { BundleCheck } from '@process/services/localJudgeOnnx/bundle';

const HOME = '/home/someone';
// Spelled by this machine's join, as the judge builds the folder whatever platform it is told it runs on.
const FOLDER = join(HOME, '.mu', 'local-judge', 'laya-multilingual-onnx');
const READY: BundleCheck = { paths: {}, missing: [], wrong: [], ready: true };
const EMPTY: BundleCheck = { paths: {}, missing: ['model.onnx', 'onnx_config.json'], wrong: [], ready: false };

/** A judge process the test drives: it prints, reports and exits when told to. */
function child() {
  const events = new EventEmitter();
  const process = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on: (event: string, listener: (...args: never[]) => void) => events.on(event, listener),
    kill: vi.fn(() => {
      setImmediate(() => events.emit('exit', 0));
      return true;
    }),
  };
  return {
    process: process as unknown as JudgeChild & { kill: ReturnType<typeof vi.fn> },
    say: (text: string) => process.stderr.write(text),
    send: (message: unknown) => events.emit('message', message),
    exit: (code: number) => events.emit('exit', code),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function judge(patch: Partial<OnnxJudgeDeps> = {}) {
  const children: ReturnType<typeof child>[] = [];
  const forked: NodeJS.ProcessEnv[] = [];
  const open = vi.fn(async () => undefined);
  const check = vi.fn(async () => READY);
  const local = new OnnxLocalJudge({
    platform: 'win32',
    arch: 'x64',
    home: HOME,
    env: { PATH: 'C:\\Windows' },
    health: async () => false,
    check,
    open,
    fork: (env) => {
      forked.push(env);
      const next = child();
      children.push(next);
      return next.process;
    },
    ...patch,
  });
  return { local, children, forked, open, check };
}

describe('which machines run the ONNX judge', () => {
  it('is Windows and Linux on x64 or arm64, and an Apple Silicon Mac only when asked', () => {
    expect(usesOnnxJudge('win32', 'x64', {})).toBe(true);
    expect(usesOnnxJudge('win32', 'arm64', {})).toBe(true);
    expect(usesOnnxJudge('linux', 'x64', {})).toBe(true);
    expect(usesOnnxJudge('linux', 'ia32', {})).toBe(false);
    expect(usesOnnxJudge('darwin', 'arm64', {})).toBe(false);
    expect(usesOnnxJudge('darwin', 'arm64', { MU_LOCAL_JUDGE_RUNTIME: 'onnx' })).toBe(true);
    expect(usesOnnxJudge('darwin', 'x64', { MU_LOCAL_JUDGE_RUNTIME: 'onnx' })).toBe(false);
  });

  it('reads whether mu.json asks a local judge at any tier', () => {
    const config = (tiers: string[]) =>
      JSON.stringify({ judges: { laya: { type: 'local' }, jev: { type: 'jev' } }, tiers });
    expect(wantsLocalJudge(config(['laya']))).toBe(true);
    expect(wantsLocalJudge(config(['jev', 'laya']))).toBe(true);
    expect(wantsLocalJudge(config(['jev']))).toBe(false);
    expect(wantsLocalJudge('{ // a comment\n "judges": {"l": {"type": "local"}}, "tiers": ["l"], }')).toBe(true);
    expect(wantsLocalJudge('')).toBe(false);
    expect(wantsLocalJudge('not json')).toBe(false);
  });
});

describe('the ONNX local judge as the app manages it', () => {
  it('says where the model goes, what is missing and whether the judge answers', async () => {
    const { local } = judge({ check: async () => EMPTY });
    expect(await local.state()).toEqual({
      support: 'ok',
      runtime: 'onnx',
      installed: false,
      running: false,
      url: 'http://127.0.0.1:47823',
      model: { folder: FOLDER, missing: ['model.onnx', 'onnx_config.json'], wrong: [] },
    });
    const moved = judge({ env: { MU_LOCAL_JUDGE_ONNX_DIR: 'D:\\models\\laya', MU_LOCAL_JUDGE_PORT: '5000' } });
    expect(await moved.local.state()).toMatchObject({
      installed: true,
      url: 'http://127.0.0.1:5000',
      model: { folder: 'D:\\models\\laya' },
    });
  });

  it('never downloads, and refuses what this machine cannot do', async () => {
    const { local } = judge();
    await expect(local.run('setup', true)).rejects.toThrow('does not download');
    await expect(local.run('run' as never)).rejects.toThrow('Unknown');
    await expect(judge({ platform: 'darwin', arch: 'x64' }).local.run('start')).rejects.toThrow('cannot run');
  });

  it('opens the model folder for the person to put the files in', async () => {
    const { local, open } = judge();
    await local.run('locate');
    expect(open).toHaveBeenCalledWith(FOLDER);
  });

  it('checks the files (with hashes) before starting, and says which are missing', async () => {
    const check = vi.fn(async () => EMPTY);
    const { local, forked } = judge({ check });
    await local.run('start');
    await settle();
    expect(check).toHaveBeenCalledWith(FOLDER, true);
    expect(forked).toHaveLength(0);
    expect((await local.state()).task).toMatchObject({
      action: 'start',
      phase: 'failed',
      problem: 'missing',
      output: ['Checking the model files', 'Missing: model.onnx, onnx_config.json'],
    });
  });

  it('starts the judge process with the folder and port, and is done when it reports ready', async () => {
    const { local, children, forked } = judge();
    expect((await local.run('start')).task).toMatchObject({ action: 'start', phase: 'running' });
    await settle();
    expect(forked[0]).toMatchObject({
      PATH: 'C:\\Windows',
      MU_LOCAL_JUDGE_ONNX_DIR: FOLDER,
      MU_LOCAL_JUDGE_PORT: '47823',
    });
    children[0].say('[12:00:00] loading the model\n');
    await settle();
    expect((await local.state()).task?.output).toContain('[12:00:00] loading the model');
    // A second start while this one runs does nothing.
    await local.run('start');
    expect(forked).toHaveLength(1);
    children[0].send({ type: 'ready', provider: 'cpu' });
    expect((await local.state()).task).toMatchObject({ phase: 'done' });
  });

  it('does not start a second judge when one already answers', async () => {
    const { local, forked } = judge({ health: async () => true });
    await local.run('start');
    await settle();
    expect(forked).toHaveLength(0);
    expect((await local.state()).task).toMatchObject({ phase: 'done' });
  });

  it.each([
    [{ type: 'failed', reason: 'port' }, 'port'],
    [{ type: 'failed', reason: 'runtime' }, 'runtime'],
    [{ type: 'failed', reason: 'crash' }, 'stopped'],
  ])('words why the judge process failed (%j)', async (message, problem) => {
    const { local, children } = judge();
    await local.run('start');
    await settle();
    children[0].send(message);
    children[0].exit(1);
    expect((await local.state()).task).toMatchObject({ phase: 'failed', problem });
  });

  it('calls a judge process that ends before it is ready stopped', async () => {
    const { local, children } = judge();
    await local.run('start');
    await settle();
    children[0].exit(1);
    expect((await local.state()).task).toMatchObject({ phase: 'failed', problem: 'stopped' });
  });

  it('stops the judge it started, also while the model is still loading', async () => {
    const { local, children } = judge();
    await local.run('start');
    await settle();
    const stopping = await local.run('stop');
    expect(stopping.task).toMatchObject({ action: 'stop', phase: 'running' });
    expect(children[0].process.kill).toHaveBeenCalled();
    await settle();
    expect((await local.state()).task).toMatchObject({ action: 'stop', phase: 'done' });
  });

  it('cannot stop a judge someone else started', async () => {
    const { local } = judge({ health: async () => true });
    await local.run('stop');
    await settle();
    expect((await local.state()).task).toMatchObject({ action: 'stop', phase: 'failed', problem: 'foreign' });
  });
});

describe('starting by itself at app start', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const agentDir = (config: object) => {
    dir = mkdtempSync(join(tmpdir(), 'mu-agent-'));
    writeFileSync(join(dir, 'mu.json'), JSON.stringify(config));
    return dir;
  };
  const LOCAL = { judges: { laya: { type: 'local' } }, tiers: ['laya'] };

  it('starts when mu.json asks for a local judge and the checked model is there', async () => {
    const { local, forked } = judge();
    expect(await local.autoStart(agentDir(LOCAL))).toBe(true);
    await settle();
    expect(forked).toHaveLength(1);
  });

  it('does not start for another judge, without the model, or when one already answers', async () => {
    expect(await judge().local.autoStart(agentDir({ judges: { jev: { type: 'jev' } }, tiers: ['jev'] }))).toBe(false);
    expect(await judge({ check: async () => EMPTY }).local.autoStart(agentDir(LOCAL))).toBe(false);
    expect(await judge({ health: async () => true }).local.autoStart(agentDir(LOCAL))).toBe(false);
    expect(await judge({ platform: 'darwin', arch: 'arm64' }).local.autoStart(agentDir(LOCAL))).toBe(false);
  });
});
