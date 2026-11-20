import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_unit',
      SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
      TEST_LOGIN: '1',
      LOCAL_ADMIN_LOGIN: '',
      MS_CLIENT_ID: '',
      PUBLIC_URL: 'http://localhost:5173',
    },
  },
});
