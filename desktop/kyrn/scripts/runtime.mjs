// Explicit, checksum-verified runtime download. npm lifecycle scripts remain disabled.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('electron/package.json'));
const { downloadArtifact } = require('@electron/get');
const { extract } = require('@electron-internal/extract-zip');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const checksums = JSON.parse(await readFile(join(root, 'checksums.json'), 'utf8'));
const zip = await downloadArtifact({
  version,
  artifactName: 'electron',
  platform: process.platform,
  arch: process.arch,
  checksums,
});
await extract(zip, { dir: join(root, 'dist') });
await writeFile(
  join(root, 'path.txt'),
  process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron'
);
console.log(`Electron ${version} (${process.platform}/${process.arch}) ready`);
