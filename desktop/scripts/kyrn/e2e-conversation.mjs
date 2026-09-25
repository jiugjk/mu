#!/usr/bin/env node
// Runs the mu conversation E2E test (tests/e2e/mu-conversation): builds the app into out/, then runs the test's own
// Playwright configuration. The exit code is the test's: 0 passed, anything else failed.
//
//   bun run e2e:conversation [--skip-build] [-- <playwright options>]
//
// MU_E2E_KEEP=1 keeps the throwaway profile (logs, sessions, the project) after a pass too; after a failure it is
// always kept, and its path is printed. tests/e2e/README.md has the rest.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build') || process.env.MU_E2E_SKIP_BUILD === '1';
const separator = args.indexOf('--');
const extra = separator >= 0 ? args.slice(separator + 1) : [];

/**
 * A package's command from the nearest `node_modules/.bin` at or above the checkout: a worktree under
 * `.claude/worktrees/` has none of its own and uses the main checkout's.
 */
function bin(name) {
  const file = process.platform === 'win32' ? `${name}.cmd` : name;
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', '.bin', file);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return join(root, 'node_modules', '.bin', file);
  }
}

function step(title, command, commandArgs) {
  console.log(`\n[mu e2e] ${title}`);
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(`[mu e2e] ${title} could not start: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

if (!skipBuild) {
  // Only errors: a working build's chunk report would bury the test's own output.
  const built = step('building the app (electron-vite)', bin('electron-vite'), [
    'build',
    '--config',
    'packages/desktop/electron.vite.config.ts',
    '--logLevel',
    'error',
  ]);
  if (built !== 0) process.exit(built);
} else if (!existsSync(join(root, 'out', 'main'))) {
  console.error('[mu e2e] --skip-build, but there is no build in out/. Run without --skip-build once.');
  process.exit(1);
}

const status = step('running the conversation test', bin('playwright'), [
  'test',
  '--config',
  'tests/e2e/mu-conversation/playwright.config.mjs',
  ...extra,
]);
console.log(status === 0 ? '\n[mu e2e] PASSED' : `\n[mu e2e] FAILED (exit ${status})`);
process.exit(status);
