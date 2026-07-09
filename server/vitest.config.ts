import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      // Integration tests only ever talk to TEST_DATABASE_URL. Overriding
      // DATABASE_URL here (to empty when unset) guarantees a developer's
      // real DATABASE_URL can never be touched by a test run.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    },
  },
});
