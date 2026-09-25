import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

/** One process owns one session. The renderer never spawns a model or sees credentials. */
export class RpcHost {
  pending = new Map();
  stopped = false;
  constructor({ launcher, cwd, session, onEvent, env = {}, spawnProcess = spawn }) {
    this.onEvent = onEvent;
    this.process = spawnProcess(launcher, ['--mode', 'rpc', ...(session ? ['--session', session] : [])], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, ...env, PI_SKIP_VERSION_CHECK: '1' },
    });
    this.process.stdout.setEncoding('utf8');
    const reader = createInterface({ input: this.process.stdout });
    reader.on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'response' && this.pending.has(event.id)) {
        const request = this.pending.get(event.id);
        this.pending.delete(event.id);
        clearTimeout(request.timer);
        if (event.success) request.resolve(event.data);
        else request.reject(new Error(event.error || 'KYRN command failed'));
      }
      this.onEvent(event);
    });
    // stderr can contain environment/provider diagnostics. Do not forward it to a renderer or a log.
    this.process.stderr.resume();
    this.process.on('error', () => this.finish('KYRN 启动失败，请检查本地 CLI 路径与 Node 环境。'));
    this.process.on('exit', (code, signal) => this.finish(`KYRN 进程结束 (${signal || code})`));
  }
  finish(reason) {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    this.pending.clear();
    this.onEvent({ type: 'kyrn_host_exit', reason });
  }
  send(command) {
    if (this.stopped) return Promise.reject(new Error('会话进程已结束，请重新打开任务。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error('KYRN 命令确认超时；请查看任务状态，勿重复提交。'));
        },
        command.type === 'prompt' ? 120000 : 20000
      );
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  respond(response) {
    if (!this.stopped) this.process.stdin.write(`${JSON.stringify({ ...response, type: 'extension_ui_response' })}\n`);
  }
  close() {
    if (this.stopped) return;
    const pid = this.process.pid;
    const signal = (name) => {
      try {
        if (process.platform === 'win32') this.process.kill(name);
        else process.kill(-pid, name);
      } catch {}
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 3000);
    timer.unref();
  }
}
