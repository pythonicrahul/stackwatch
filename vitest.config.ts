import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Slow, real-child-process integration tests live outside the fast
    // default loop — see vitest.integration.config.ts + `npm run test:integration`.
    exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
    restoreMocks: true,
  },
});
