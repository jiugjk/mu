import { EventEmitter } from 'node:events';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LocalJudge, type LocalJudgeDeps, type TaskProcess } from '@/process/agent/kyrn/localJudge';

const ROOT = '/harness';
const HOME = '/Users/someone';
const ESC = String.fromCharCode(27);

/** A child process the test ends by hand, and says what it prints. */
function child() {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = {
    stdout,
    stderr,
    on: (event: string, listener: (...args: never[]) => void) => events.on(event, listener),
  } as TaskProcess;
  return {
    process,
    print: (text: string) => stdout.write(text),
    fail: (text: string) => stderr.write(text),
    exit: async (code: number) => {
      await new Promise((resolve) => setImmediate(resolve));
      events.emit('close', code);
    },
  };
}

function judge(patch: Partial<LocalJudgeDeps> = {}, files: string[] = []) {
  const spawned: { command: string; args: string[]; path?: string }[] = [];
  const children: ReturnType<typeof child>[] = [];
  const found = new Set(files);
  const local = new LocalJudge(ROOT, {
    platform: 'darwin',
    arch: 'arm64',
    home: HOME,
    env: { PATH: ['/usr/bin', '/bin'].join(delimiter) },
    exists: (path) => found.has(path),
    health: async () => false,
    spawn: (command, args, options) => {
      spawned.push({ command, args, path: options.env.PATH });
      const next = child();
      children.push(next);
      return next.process;
    },
    ...patch,
  });
  return { local, spawned, children };
}

// Spelled by this machine's join and delimiter, as the judge builds its paths whatever platform it is told it runs on.
const UV = join(HOME, '.local', 'bin', 'uv');
const PYTHON = join(ROOT, 'kyrn', 'local-judge', '.venv', 'bin', 'python');
const WEIGHTS = join(ROOT, 'kyrn', 'local-judge', 'models', 'laya-multilingual-coreml', 'coreml_config.json');

describe('the local judge as the app manages it', () => {
  it('says whether this machine can run it, whether it is installed and whether it answers', async () => {
    expect((await judge({ platform: 'win32', arch: 'x64' }).local.state()).support).toBe('platform');
    expect((await judge({ arch: 'x64' }).local.state()).support).toBe('platform');
    expect((await judge().local.state()).support).toBe('uv');
    // A Mac app's PATH is short: uv is looked for where its installer puts it.
    expect(await judge({}, [UV, PYTHON, WEIGHTS]).local.state()).toEqual({
      support: 'ok',
      runtime: 'coreml',
      installed: true,
      running: false,
      url: 'http://127.0.0.1:47823',
    });
    const up = judge({ health: async (url) => url === 'http://127.0.0.1:47823', env: {} }, [UV, PYTHON]);
    expect(await up.local.state()).toMatchObject({ installed: false, running: true });
  });

  it('installs only with consent on a machine that can run it, then starts it, one action at a time', async () => {
    const { local, spawned, children } = judge({}, [UV]);
    await expect(local.run('setup')).rejects.toThrow('consent');
    await expect(local.run('run' as never)).rejects.toThrow('Unknown');
    const unsupported = judge({ arch: 'x64' });
    await expect(unsupported.local.run('setup', true)).rejects.toThrow('cannot install');

    const started = await local.run('setup', true);
    expect(started.task).toMatchObject({ id: 1, action: 'setup', phase: 'running' });
    expect(spawned[0]).toMatchObject({
      command: '/bin/bash',
      args: [join(ROOT, 'kyrn', 'bin', 'kyrn-judge-local'), 'setup'],
    });
    expect(spawned[0].path?.split(delimiter)[0]).toBe(join(HOME, '.local', 'bin'));
    // A second click while it works starts nothing.
    await local.run('start');
    expect(spawned).toHaveLength(1);

    children[0].print(`${ESC}[32mResolved 26 packages${ESC}[0m\nDownloading 12%\rDownloading 64%\r`);
    children[0].fail('warning: slow mirror\n');
    await children[0].exit(0);
    expect(spawned[1].args[1]).toBe('start');
    const starting = await local.state();
    expect(starting.task).toMatchObject({ action: 'start', phase: 'running' });
    expect(starting.task?.output).toEqual([
      'Resolved 26 packages',
      'Downloading 12%',
      'Downloading 64%',
      'warning: slow mirror',
    ]);
    await children[1].exit(0);
    expect((await local.state()).task).toMatchObject({ action: 'start', phase: 'done' });
  });

  it('stops at a failed setup, keeping its last words, and can be tried again', async () => {
    const { local, spawned, children } = judge({}, [UV]);
    await local.run('setup', true);
    children[0].fail('uv: error: no route to host\n');
    await children[0].exit(1);
    const failed = await local.state();
    expect(failed.task).toMatchObject({ action: 'setup', phase: 'failed', output: ['uv: error: no route to host'] });
    expect(spawned).toHaveLength(1);
    const again = await local.run('setup', true);
    expect(again.task).toMatchObject({ id: 2, phase: 'running', output: [] });
  });
});
