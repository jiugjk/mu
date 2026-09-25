import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: 4317, strictPort: true, fs: { allow: [root] } },
});
await server.listen();
const electronRoot = dirname(fileURLToPath(import.meta.resolve('electron/package.json')));
const binary = join(electronRoot, 'dist', readFileSync(join(electronRoot, 'path.txt'), 'utf8').trim());
const env = {
  ...process.env,
  KYRN_RENDERER_URL: 'http://127.0.0.1:4317',
  KYRN_ROOT: process.env.KYRN_ROOT || fileURLToPath(new URL('../../../KYRN', import.meta.url)),
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(binary, [root], { stdio: 'inherit', env });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code || 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
