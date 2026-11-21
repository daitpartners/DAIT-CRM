import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

/** Viewport used for both sides of a parity comparison (app and prototype). */
export const PARITY_VIEWPORT = { width: 1400, height: 1000 } as const;

/** Screenshots land here; the folder is gitignored and created on demand. */
export const PARITY_OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

/**
 * Captures the current app screen for a prototype-parity comparison: sets the viewport to 1400×1000, waits for
 * the network to go idle, and saves a full-page screenshot to `e2e/parity/out/<name>-app.png`. Returns the path.
 * The prototype side (`<name>-proto.png`) is captured by hand; see README.md in this folder.
 */
export async function captureParity(page: Page, name: string): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`captureParity: name must be kebab-case, got "${name}"`);
  mkdirSync(PARITY_OUT, { recursive: true });
  await page.setViewportSize(PARITY_VIEWPORT);
  await page.waitForLoadState('networkidle');
  const path = join(PARITY_OUT, `${name}-app.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}
