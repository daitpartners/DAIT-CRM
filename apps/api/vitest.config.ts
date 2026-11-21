import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    // Database-backed tests can exceed the 5 s default on a loaded machine.
    testTimeout: 20000,
    hookTimeout: 20000,
    globalSetup: ['./test/global-setup.ts'],
    // test-only values, not secrets
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_unit',
      SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
      TEST_LOGIN: '1',
      LOCAL_ADMIN_LOGIN: '',
      MS_CLIENT_ID: '',
      PUBLIC_URL: 'http://localhost:5173',
      // Fixed test-only key (32 bytes of 0x07); never used outside tests.
      TOKEN_ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    },
  },
});
