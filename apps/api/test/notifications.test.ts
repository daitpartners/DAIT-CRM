import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { resetDb } from './helpers';
import { makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(resetDb);

const req = (method: 'GET' | 'POST', url: string, cookie?: string) =>
  app.inject({ method, url, headers: cookie ? { cookie } : {} });

describe('notifications API', () => {
  it('notifications list, read, read-all, count', async () => {
    expect((await req('GET', '/api/notifications')).statusCode).toBe(401);
    const me = await makeUser();
    const other = await makeUser();
    const cookie = await signIn(app, me);
    const mk = (userId: number, text: string, minutesAgo: number, isRead = false) =>
      prisma.notification.create({ data: { userId, text, isRead, createdAt: new Date(Date.now() - minutesAgo * 60_000) } });
    const oldest = await mk(me.id, 'Oldest', 30, true);
    const middle = await mk(me.id, 'Middle', 20);
    const newest = await mk(me.id, 'Newest', 10);
    const theirs = await mk(other.id, 'Not mine', 5);

    const all = await req('GET', '/api/notifications', cookie);
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ total: 3, unread: 2 });
    expect(all.json().items.map((n: { id: number }) => n.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(all.json().items[0]).toMatchObject({ id: newest.id, text: 'Newest', detail: null, link: null, isRead: false });

    const unread = await req('GET', '/api/notifications?unread=1&page=1&pageSize=1', cookie);
    expect(unread.json()).toMatchObject({ total: 2, unread: 2 });
    expect(unread.json().items.map((n: { id: number }) => n.id)).toEqual([newest.id]);
    expect((await req('GET', '/api/notifications?unread=yes', cookie)).statusCode).toBe(400);

    expect((await req('GET', '/api/notifications/count', cookie)).json()).toEqual({ unread: 2 });

    const read = await req('POST', `/api/notifications/${middle.id}/read`, cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ unread: 1 });
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: middle.id } })).isRead).toBe(true);
    // Someone else's notification is not found and stays unread.
    expect((await req('POST', `/api/notifications/${theirs.id}/read`, cookie)).statusCode).toBe(404);
    expect((await req('POST', '/api/notifications/abc/read', cookie)).statusCode).toBe(404);

    const readAll = await req('POST', '/api/notifications/read-all', cookie);
    expect(readAll.json()).toEqual({ unread: 0 });
    expect((await req('GET', '/api/notifications/count', cookie)).json()).toEqual({ unread: 0 });
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).isRead).toBe(false);
  });
});
