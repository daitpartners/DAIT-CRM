import { describe, expect, test, vi } from 'vitest';
import { startWorker } from '@dait-crm/api/worker';

describe('worker launcher', () => {
  test('startWorker polls and stops cleanly when asked', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listenersBefore = process.listenerCount('SIGTERM');
    const controller = new AbortController();
    const sendMail = vi.fn(async () => undefined);
    setTimeout(() => controller.abort(), 50);
    await expect(startWorker({ graph: { sendMail }, pollMs: 10_000, signal: controller.signal })).resolves.toBeUndefined();
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore);
  });
});
