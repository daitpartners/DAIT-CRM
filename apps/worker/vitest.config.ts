import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_unit',
      // Fixed test-only key (32 bytes of 0x07); never used outside tests.
      TOKEN_ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    },
  },
});
