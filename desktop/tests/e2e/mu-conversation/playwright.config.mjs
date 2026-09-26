// The conversation E2E test's own Playwright configuration: one serial file, one app, generous but bounded times.
// Run through `bun run e2e:conversation` (scripts/kyrn/e2e-conversation.mjs), which builds the app first.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'conversation.spec.mjs',
  // A step waits on the app, the backend and mu; the slowest (the first start, a relaunch) take well under a minute.
  timeout: 4 * 60_000,
  // The whole run: a stuck app fails the run instead of hanging a CI job.
  globalTimeout: 20 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: '../report/mu-conversation' }]]
    : [['list'], ['html', { open: 'never', outputFolder: '../report/mu-conversation' }]],
  use: { trace: 'off' },
  outputDir: '../results/mu-conversation',
});
