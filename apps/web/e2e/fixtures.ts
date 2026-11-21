import { expect, type Page } from '@playwright/test';

export const MAYA = 'maya.pillai@daitpartners.com'; // Administrator
export const ARJUN = 'arjun.mehta@daitpartners.com'; // Sales Representative
export const NEHA = 'neha.kapoor@daitpartners.com'; // Manager (seeded personal mailbox)

/** Signs in through the test-login route (cookie lands in the page's context), then opens the dashboard. */
export async function signInAs(page: Page, email: string): Promise<void> {
  const res = await page.request.post('/api/auth/test-login', { data: { email } });
  expect(res.status()).toBe(204);
  await page.goto('/');
}
