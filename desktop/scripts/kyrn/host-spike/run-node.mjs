/** The same host under plain Node (child_process.fork), as a baseline for the Electron run. */
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { runScenario } from './scenario.mjs';

const child = fork(join(import.meta.dirname, 'host-entry.mjs'), [], {
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const link = { send: (message) => child.send(message), onMessage: (handler) => child.on('message', handler) };
const guard = setTimeout(() => {
  console.error('spike timed out');
  child.kill('SIGKILL');
  process.exit(2);
}, 60000);
try {
  const report = await runScenario(link, 'node child_process.fork');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 2;
} finally {
  clearTimeout(guard);
  child.kill();
}
