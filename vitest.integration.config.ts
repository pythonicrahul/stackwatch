import { defineConfig } from 'vitest/config';

/** Slow, real-child-process tests (spawns the built daemon, hits a real
 * HTTP health check, sends a real SIGTERM). Kept out of the fast default
 * `npm test` loop — run explicitly via `npm run test:integration`, which
 * builds the daemon first (see package.json's `pretest:integration`). */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
