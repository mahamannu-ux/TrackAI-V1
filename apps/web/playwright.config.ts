import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * IT-T19i-01: the T19.9 walkthrough (docs/plan/TASK19_WALKTHROUGH.md) as one Playwright
 * regression, against the real API and the real web app on a seeded throwaway database.
 * Run it only through the root script, which wraps scripts/it-db.sh:
 *
 *   npm run e2e:task19-walkthrough
 *
 * The global setup seeds the database, then starts the local sign-in stub, the API and a
 * production build of the web app on free ports. Results and traces go to a temporary
 * directory, never into the repository. The steps share one seeded world, so they run in
 * order in one worker.
 */
const outputDir = process.env.TASK19I_OUTPUT_DIR ?? join(tmpdir(), 'trackai-task19i-e2e');

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './e2e/task19-walkthrough.setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: join(outputDir, 'results'),
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1600, height: 1100 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The workspace has Chromium preinstalled at a fixed path (CLAUDE.md); a Mac uses
    // Playwright's own download (`npx playwright install chromium`, once).
    ...(process.env.TASK19I_CHROMIUM ? { launchOptions: { executablePath: process.env.TASK19I_CHROMIUM } } : {}),
  },
});
