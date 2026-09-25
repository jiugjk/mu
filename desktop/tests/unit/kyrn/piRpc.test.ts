import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiRpc, stoppedReport, type JsonRecord } from '../../../packages/desktop/src/process/agent/kyrn/piRpc.ts';

const ROOT = join(__dirname, '../../..');
const PI_RPC = join(ROOT, 'packages/desktop/src/process/agent/kyrn/piRpc.ts');

/**
 * PiRpc against small Node scripts standing in for mu (a `.mjs` launcher runs on this Node, as mu.mjs does on
 * Windows): what the adapter does when mu stops reading, stops by itself, or writes the way Windows does.
 */
const dirs: string[] = [];
const ports: PiRpc[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const port of ports.splice(0)) port.close();
  // On Windows mu is ended through taskkill, which takes a moment: until then its folder cannot be removed.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Starts `script` as mu and collects what it sends. */
function start(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kyrn-rpc-'));
  dirs.push(dir);
  const launcher = join(dir, 'mu.mjs');
  writeFileSync(launcher, script);
  const events: JsonRecord[] = [];
  const port = new PiRpc(launcher, dir, undefined, (event) => events.push(event));
  ports.push(port);
  return { port, events };
}

/** A mu that answers every command with `data`, lines ended as `eol`. */
const answering = (eol: string, data: JsonRecord) => `
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: ${JSON.stringify(data)} }) + ${JSON.stringify(eol)});
});
`;

describe('PiRpc, the adapter’s line to mu', () => {
  // Node cannot close its own input on Windows (libuv keeps descriptors 0 to 2 open): this mu cannot be played there.
  const windows = process.platform === 'win32';
  it.skipIf(windows)('survives a mu that stopped reading: an answer to it ends nothing but that mu', async () => {
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
    // Closing its input and lingering is what a crashing mu looks like from here, for a moment.
    const { port, events } = start(`
import { closeSync } from 'node:fs';
closeSync(0);
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
setTimeout(() => {}, 5000);
`);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'ready')).toBe(true), { timeout: 5000 });
    port.respond({ id: 'ui-1', value: '允许这一次' });
    port.respond({ id: 'ui-2', cancelled: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'kyrn_rpc_closed')).toBe(true), {
      timeout: 5000,
    });
    await expect(port.send({ type: 'get_state' })).rejects.toThrow('mu process is closed');
    // The closed port takes further answers without a word.
    expect(() => port.respond({ id: 'ui-3', cancelled: true })).not.toThrow();
    expect(events.filter((event) => event.type === 'kyrn_rpc_closed')).toHaveLength(1);
    // A mu that cannot be written to is ended, and the log says so.
    await vi.waitFor(
      () => expect(logged.join('')).toContain('[mu] the harness stopped reading its input and was ended'),
      {
        timeout: 5000,
      }
    );
  });

  it('fails the requests in flight when mu stops by itself, and logs why with the end of its error output', async () => {
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
    const { port, events } = start(`
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', () => {
  process.stderr.write('Error: something broke\\r\\n    at crash (mu.js:1:1)\\r\\n');
  process.exit(3);
});
`);
    await expect(port.send({ type: 'get_state' })).rejects.toThrow('mu process exited');
    expect(events.at(-1)).toEqual({ type: 'kyrn_rpc_closed' });
    await vi.waitFor(() => expect(logged.join('')).toContain('stopped by itself'), { timeout: 5000 });
    expect(logged.join('')).toBe(
      '[mu] the harness stopped by itself (exit code 3); the end of its error output:\n' +
        '[mu harness] Error: something broke\n' +
        '[mu harness]     at crash (mu.js:1:1)\n'
    );
  });

  it('logs nothing when the adapter ended mu itself', async () => {
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
    const { port, events } = start(answering('\n', {}));
    await port.send({ type: 'get_state' });
    port.close();
    await vi.waitFor(() => expect(events.some((event) => event.type === 'kyrn_rpc_closed')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(logged.join('')).not.toContain('stopped by itself');
  });

  it('reads Windows line ends and UTF-8 split across writes', async () => {
    const { port, events } = start(`
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  const bytes = Buffer.from(JSON.stringify({ type: 'response', id: command.id, success: true, data: { text: '不允许' } }) + '\\r\\n');
  // Cut inside a character: 不 is three bytes.
  const cut = bytes.indexOf(Buffer.from('不')) + 1;
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);
});
`);
    await expect(port.send({ type: 'get_state' })).resolves.toEqual({ text: '不允许' });
    expect(events.filter((event) => event.type === 'response')).toHaveLength(1);
  });

  it('keeps going when a listener fails on one event', async () => {
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-rpc-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'mu.mjs'), answering('\n', { ok: true }));
    let calls = 0;
    const port = new PiRpc(join(dir, 'mu.mjs'), dir, undefined, () => {
      calls += 1;
      if (calls === 1) throw new Error('listener bug');
    });
    ports.push(port);
    await expect(port.send({ type: 'get_state' })).resolves.toEqual({ ok: true });
    await expect(port.send({ type: 'get_state' })).resolves.toEqual({ ok: true });
    expect(logged.join('')).toContain('[mu] handling a response event failed: Error: listener bug');
  });

  it('passes mu’s own log lines on to the app’s log as they come, and nothing else of its error output', async () => {
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
    // As the harness logs a promise nothing handled in RPC mode (kyrn-judge's rejections.ts), and a line cut in two.
    start(`
process.stderr.write('[mu] a promise failed and nothing handled it; mu goes on: Error: x\\n[mu]     at y (b.ts:1:1)\\r\\nnoise that stays out\\n[mu] cut ');
setTimeout(() => process.stderr.write('across writes\\n'), 50);
setTimeout(() => {}, 5000);
`);
    await vi.waitFor(() => expect(logged.join('')).toContain('across writes'), { timeout: 5000 });
    expect(logged.join('')).toBe(
      '[mu harness] a promise failed and nothing handled it; mu goes on: Error: x\n' +
        '[mu harness]     at y (b.ts:1:1)\n' +
        '[mu harness] cut across writes\n'
    );
  });

  it('survives logging to an error output nobody reads any more', async () => {
    // AionCore stops reading the adapter's error output at the first line that is not UTF-8, and closes it: a write
    // after that fails (EPIPE). The adapter runs in a process of its own here, whose error output is closed at once.
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-rpc-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'mu.mjs'), `process.stderr.write('Error: gone\\n'); process.exit(3);\n`);
    // CommonJS, as tsx runs the adapter's sources.
    writeFileSync(
      join(dir, 'adapter.ts'),
      `
import { PiRpc } from ${JSON.stringify(PI_RPC)};
new PiRpc(${JSON.stringify(join(dir, 'mu.mjs'))}, ${JSON.stringify(dir)}, undefined, (event) => {
  if (event.type !== 'kyrn_rpc_closed') return;
  // Past the report, and past the failed write's error.
  setTimeout(() => {
    process.stdout.write('alive\\n');
    process.exit(0);
  }, 1500);
});
`
    );
    const tsx = createRequire(join(ROOT, 'package.json')).resolve('tsx/cli');
    const adapter = spawn(process.execPath, [tsx, join(dir, 'adapter.ts')], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    adapter.stderr.destroy();
    let out = '';
    adapter.stdout.on('data', (chunk: Buffer) => {
      out += String(chunk);
    });
    const code = await new Promise<number | null>((resolve) => adapter.on('exit', resolve));
    expect({ code, out: out.trim() }).toEqual({ code: 0, out: 'alive' });
  }, 20000);
});

describe('stoppedReport', () => {
  it('names the exit and at most the last 40 lines, each marked as mu’s', () => {
    expect(stoppedReport(null, 'SIGKILL', '')).toBe(
      '[mu] the harness stopped by itself (exit code none, signal SIGKILL)\n'
    );
    expect(stoppedReport(null, 'SIGTERM', '', true)).toBe(
      '[mu] the harness stopped reading its input and was ended (exit code none, signal SIGTERM)\n'
    );
    // mu's own log lines are in the log already.
    expect(stoppedReport(1, null, '[mu] a promise failed\nError: boom\n')).toBe(
      '[mu] the harness stopped by itself (exit code 1); the end of its error output:\n[mu harness] Error: boom\n'
    );
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\r\n');
    const report = stoppedReport(1, null, `${lines}\r\n\r\n`).trimEnd().split('\n');
    expect(report).toHaveLength(41);
    expect(report[1]).toBe('[mu harness] line 10');
    expect(report.at(-1)).toBe('[mu harness] line 49');
  });
});
