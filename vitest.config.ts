import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts', 'tests/contract/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000, // starting a Postgres container
          fileParallelism: false, // tests share one container per run
        },
      },
    ],
  },
});
