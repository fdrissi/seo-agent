import { defineConfig } from 'vitest/config';

/**
 * Two projects, one `npm test` (`vitest run` runs both):
 * - "default": unit and integration tests, parallel across files, 20 s per test.
 * - "e2e": tests/e2e acceptance runs (the full demo, new-user flows). They drive
 *   whole pipelines, so they get 120 s per test and run one file at a time,
 *   after the default project (groupOrder), so a loaded or slow CI runner does
 *   not time them out while the rest of the suite competes for CPU.
 * `npm run test:e2e` (vitest run tests/e2e) still selects only the e2e files.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Tests must never reach the network or real credentials; see tests/setup.ts.
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    projects: [
      {
        extends: true,
        test: {
          name: 'default',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/e2e/**', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
