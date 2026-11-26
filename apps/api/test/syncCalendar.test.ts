import { beforeEach, describe, expect, test } from 'vitest';
import type { Job } from '@prisma/client';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type CalendarDeltaPage, type GraphEvent } from '../src/graph/client';
import { syncCalendarHandler } from '../src/jobs/handlers/syncCalendar';
import { scheduleCalendarSync } from '../src/calendar/schedule';
import { fakeGraph, resetDb } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser } from './factory';

beforeEach(async () => {
  await resetDb();
  boxes = 0;
});

const ADDRESS = 'maya@daitpartners.com';
const DAY = 86_400_000;
const LINK = 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=1';

let boxes = 0;
async function mailbox(over: { status?: string; syncCalendar?: boolean; state?: object; syncAt?: Date } = {}) {
  const user = await makeUser({ role: 'SALES_REPRESENTATIVE' });
  boxes += 1;
  const account = await prisma.emailAccount.create({
    data: {
      userId: user.id, address: boxes === 1 ? ADDRESS : `box${boxes}@daitpartners.com`, provider: 'microsoft', kind: 'personal', refreshTokenEnc: encrypt('rt'),
      status: over.status ?? 'connected', syncCalendar: over.syncCalendar ?? true,
      calendarSyncState: over.state ? { userId: user.id, ...over.state } : undefined,
      calendarSyncAt: over.syncAt ?? null,
    },
  });
  return { user, account };
}

let n = 0;
function event(over: Partial<GraphEvent> = {}): GraphEvent {
  n += 1;
  return {
    id: `e${n}`, subject: 'Discovery call', startsAt: '2026-11-25T10:00:00.000Z', endsAt: '2026-11-25T10:30:00.000Z', isAllDay: false, isCancelled: false,
    location: 'Teams', organizer: { name: 'Maya', address: ADDRESS }, attendees: ['ana@acme.com'], isOnline: true, ...over,
  };
}

/** Pages by URL; the start URL is `start`. Unscripted URLs return an empty final page. */
function scripted(pages: Record<string, CalendarDeltaPage | Error>) {
  const seen: string[] = [];
  const graph = fakeGraph({
    async calendarDeltaPage(_account, url) {
      seen.push(url);
      const page = pages[url] ?? (url.includes('startDateTime=') ? pages.start : undefined);
      if (page instanceof Error) throw page;
      return page ?? { events: [], removed: [], deltaLink: `${LINK}-done` };
    },
  });
  return { graph, seen };
}

const job = (accountId: number) => ({ id: 1, type: 'sync_calendar', payload: { accountId }, attempts: 0, maxAttempts: 1 }) as unknown as Job;
const final = (events: GraphEvent[], removed: string[] = []): CalendarDeltaPage => ({ events, removed, deltaLink: LINK });

async function row(userId: number, accountId: number, graphId: string, startsAt: Date, over: { updatedAt?: Date } = {}) {
  return prisma.calendarEvent.create({
    data: { userId, accountId, graphId, subject: graphId, startsAt, endsAt: new Date(startsAt.getTime() + 3600_000), updatedAt: over.updatedAt ?? new Date(Date.now() - DAY) },
  });
}

describe('calendar sync (3C)', () => {
  test("an all-day event at its zone's midnight is stored on its date, also for users east of UTC+12 (New Zealand, Tonga)", async () => {
    const { user, account } = await mailbox();
    await prisma.user.update({ where: { id: user.id }, data: { timezone: 'Pacific/Auckland' } });
    // 10–11 Mar 2030 in Auckland (UTC+13 in March) as Graph sends it in UTC.
    const holiday = event({ subject: 'Holiday', startsAt: '2030-03-09T11:00:00.000Z', endsAt: '2030-03-10T11:00:00.000Z', isAllDay: true, attendees: [] });
    const { graph } = scripted({ start: final([holiday]) });
    await syncCalendarHandler(job(account.id), { graph });
    expect(await prisma.calendarEvent.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
      startsAt: new Date('2030-03-10T00:00:00.000Z'), endsAt: new Date('2030-03-11T00:00:00.000Z'),
    });
  });

  test('a first run reads the 30-days-back to 180-days-ahead window and stores events with UTC times, all-day flag and lower-cased attendees', async () => {
    const { user, account } = await mailbox();
    const meeting = event({ attendees: ['Ana@Acme.com', 'bob@acme.com'] });
    const allDay = event({ subject: 'Offsite', startsAt: '2026-11-27T00:00:00.000Z', endsAt: '2026-11-28T00:00:00.000Z', isAllDay: true, attendees: [], isOnline: false, location: null });
    const { graph, seen } = scripted({ start: final([meeting, allDay]) });

    await syncCalendarHandler(job(account.id), { graph });

    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!);
    expect(url.pathname).toBe('/v1.0/me/calendarView/delta');
    expect(Math.round((Date.now() - Date.parse(url.searchParams.get('startDateTime')!)) / DAY)).toBe(30);
    expect(Math.round((Date.parse(url.searchParams.get('endDateTime')!) - Date.now()) / DAY)).toBe(180);
    const rows = await prisma.calendarEvent.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      accountId: account.id, graphId: meeting.id, subject: 'Discovery call', startsAt: new Date('2026-11-25T10:00:00.000Z'), endsAt: new Date('2026-11-25T10:30:00.000Z'),
      isAllDay: false, location: 'Teams', organizerName: 'Maya', organizerAddress: ADDRESS, attendeeAddresses: ['ana@acme.com', 'bob@acme.com'], isOnline: true,
      leadId: null, companyId: null,
    });
    expect(rows[1]).toMatchObject({ subject: 'Offsite', isAllDay: true, startsAt: new Date('2026-11-27T00:00:00.000Z'), location: null, attendeeAddresses: [], isOnline: false });
    const after = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.calendarSyncState).toMatchObject({ link: LINK, userId: user.id });
    expect((after.calendarSyncState as { full?: boolean }).full).toBeUndefined();
    expect(Date.now() - after.calendarSyncAt!.getTime()).toBeLessThan(60_000);
  });

  test('a later run continues from the stored link: changes are applied, removed and cancelled events deleted', async () => {
    const { user, account } = await mailbox({ state: { link: LINK, at: new Date().toISOString() }, syncAt: new Date(Date.now() - 3600_000) });
    const start = new Date('2026-11-25T10:00:00.000Z');
    await row(user.id, account.id, 'moved', start);
    await row(user.id, account.id, 'removed', start);
    await row(user.id, account.id, 'cancelled', start);
    await row(user.id, account.id, 'kept', start);
    const { graph, seen } = scripted({
      [LINK]: { events: [event({ id: 'moved', subject: 'Moved', startsAt: '2026-11-26T15:00:00.000Z', endsAt: '2026-11-26T16:00:00.000Z' }), event({ id: 'cancelled', isCancelled: true }), event({ id: 'new-cancelled', isCancelled: true })], removed: ['removed'], deltaLink: `${LINK}-2` },
    });

    await syncCalendarHandler(job(account.id), { graph });

    expect(seen).toEqual([LINK]);
    const rows = await prisma.calendarEvent.findMany({ where: { userId: user.id }, orderBy: { graphId: 'asc' } });
    expect(rows.map((r) => r.graphId)).toEqual(['kept', 'moved']);
    expect(rows[1]).toMatchObject({ subject: 'Moved', startsAt: new Date('2026-11-26T15:00:00.000Z') });
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).calendarSyncState).toMatchObject({ link: `${LINK}-2` });
  });

  test("an attendee who is a contact on an open lead the user can see links the event; a lead the user cannot see does not", async () => {
    const { user, account } = await mailbox();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const acme = await makeCompany({ website: 'https://acme.com' });
    const ana = await makeContact({ companyId: acme.id, businessEmail: 'ana@acme.com' });
    const lead = await makeLead({ companyId: acme.id, contactId: ana.id, assignedToId: user.id });
    const hiddenCo = await makeCompany({ website: 'https://hidden.com' });
    const ben = await makeContact({ companyId: hiddenCo.id, businessEmail: 'ben@hidden.com' });
    await makeLead({ companyId: hiddenCo.id, contactId: ben.id, assignedToId: other.id });
    const visible = event({ attendees: [ADDRESS, 'ANA@acme.com'] });
    const hidden = event({ attendees: ['ben@hidden.com'] });
    const { graph } = scripted({ start: final([visible, hidden]) });

    await syncCalendarHandler(job(account.id), { graph });

    const rows = await prisma.calendarEvent.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.graphId, r.leadId, r.companyId])).toEqual([[visible.id, lead.id, acme.id], [hidden.id, null, hiddenCo.id]]);
  });

  test("a rep's own open lead links the event even when another rep's lead at the company was updated more recently", async () => {
    const { user, account } = await mailbox();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const acme = await makeCompany({ website: 'https://acme.com' });
    const ana = await makeContact({ companyId: acme.id, businessEmail: 'ana@acme.com' });
    const mine = await makeLead({ companyId: acme.id, contactId: ana.id, assignedToId: user.id });
    const theirs = await makeLead({ companyId: acme.id, contactId: ana.id, assignedToId: other.id });
    await prisma.$executeRaw`UPDATE leads SET updated_at = ${new Date('2026-01-01T00:00:00Z')} WHERE id = ${mine.id}`;
    await prisma.$executeRaw`UPDATE leads SET updated_at = ${new Date('2026-06-01T00:00:00Z')} WHERE id = ${theirs.id}`;
    const byContact = event({ attendees: ['ana@acme.com'] });
    const byDomain = event({ attendees: ['new.person@acme.com'] });
    const { graph } = scripted({ start: final([byContact, byDomain]) });

    await syncCalendarHandler(job(account.id), { graph });

    const rows = await prisma.calendarEvent.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.graphId, r.leadId, r.companyId])).toEqual([[byContact.id, mine.id, acme.id], [byDomain.id, mine.id, acme.id]]);
  });

  test("a closed or archived lead the user can see never links an event (open leads only); the company still does", async () => {
    const { user, account } = await mailbox();
    const acme = await makeCompany({ website: 'https://acme.com' });
    const ana = await makeContact({ companyId: acme.id, businessEmail: 'ana@acme.com' });
    await makeLead({ companyId: acme.id, contactId: ana.id, assignedToId: user.id, status: 'Won' });
    await makeLead({ companyId: acme.id, contactId: ana.id, assignedToId: user.id, archivedAt: new Date() });
    const byContact = event({ attendees: ['ana@acme.com'] });
    const byDomain = event({ attendees: ['new.person@acme.com'] });
    const { graph } = scripted({ start: final([byContact, byDomain]) });

    await syncCalendarHandler(job(account.id), { graph });

    const rows = await prisma.calendarEvent.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.graphId, r.leadId, r.companyId])).toEqual([[byContact.id, null, acme.id], [byDomain.id, null, acme.id]]);
  });

  test('a run more than 24 hours after the last restart starts again from scratch and drops events no longer in the window', async () => {
    const { user, account } = await mailbox({ state: { link: LINK, at: new Date().toISOString() }, syncAt: new Date(Date.now() - 25 * 3600_000) });
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    await row(user.id, account.id, 'old', new Date(Date.now() - 40 * DAY));
    await row(user.id, account.id, 'still-there', new Date(Date.now() + DAY));
    await row(other.id, (await mailbox()).account.id, 'theirs', new Date(Date.now() - 40 * DAY));
    const { graph, seen } = scripted({ start: final([event({ id: 'still-there' })]) });

    await syncCalendarHandler(job(account.id), { graph });

    expect(seen[0]).toContain('startDateTime=');
    expect((await prisma.calendarEvent.findMany({ where: { userId: user.id } })).map((r) => r.graphId)).toEqual(['still-there']);
    expect(await prisma.calendarEvent.count({ where: { graphId: 'theirs' } })).toBe(1);
    expect(Date.now() - (await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).calendarSyncAt!.getTime()).toBeLessThan(60_000);
  });

  test('a long listing stops after 20 pages and continues in about a minute; old rows go only once the listing is complete', async () => {
    const { user, account } = await mailbox();
    await row(user.id, account.id, 'stale', new Date(Date.now() + DAY));
    const pages: Record<string, CalendarDeltaPage> = {};
    for (let i = 0; i < 25; i++) {
      pages[i === 0 ? 'start' : `https://graph.microsoft.com/v1.0/p/${i}`] = { events: [event()], removed: [], nextLink: `https://graph.microsoft.com/v1.0/p/${i + 1}` };
    }
    pages['https://graph.microsoft.com/v1.0/p/25'] = final([]);
    const { graph } = scripted(pages);

    await syncCalendarHandler(job(account.id), { graph });

    expect(await prisma.calendarEvent.count({ where: { graphId: { not: 'stale' } } })).toBe(20);
    expect(await prisma.calendarEvent.count({ where: { graphId: 'stale' } })).toBe(1);
    const mid = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(mid.calendarSyncState).toMatchObject({ link: 'https://graph.microsoft.com/v1.0/p/20', full: true });
    const next = await prisma.job.findFirstOrThrow({ where: { type: 'sync_calendar', status: 'queued' } });
    expect(next.payload).toEqual({ accountId: account.id });
    expect(next.runAt.getTime() - Date.now()).toBeGreaterThan(30_000);
    expect(next.runAt.getTime() - Date.now()).toBeLessThan(90_000);

    await syncCalendarHandler(job(account.id), { graph });

    expect(await prisma.calendarEvent.count()).toBe(25);
    const done = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(done.calendarSyncState).toMatchObject({ link: LINK });
    expect((done.calendarSyncState as { full?: boolean }).full).toBeUndefined();
    expect(done.calendarSyncAt!.getTime()).toBe(mid.calendarSyncAt!.getTime());
  });

  test('an expired delta link starts again from scratch', async () => {
    const { account } = await mailbox({ state: { link: LINK, at: new Date().toISOString() }, syncAt: new Date() });
    const fresh = event();
    const { graph, seen } = scripted({ [LINK]: new GraphError('graph_request_failed status=410', 410), start: final([fresh]) });
    await syncCalendarHandler(job(account.id), { graph });
    expect(seen[1]).toContain('startDateTime=');
    expect(await prisma.calendarEvent.count({ where: { graphId: fresh.id } })).toBe(1);
  });

  test('a revoked token puts the mailbox in error; other failures leave it connected and fail the run', async () => {
    const a = await mailbox();
    await syncCalendarHandler(job(a.account.id), scripted({ start: new GraphError('graph_request_failed status=401', 401) }));
    const after = await prisma.emailAccount.findUniqueOrThrow({ where: { id: a.account.id } });
    expect(after.status).toBe('error');
    expect(after.lastError).toContain('401');

    const b = await mailbox();
    await expect(syncCalendarHandler(job(b.account.id), scripted({ start: new GraphError('graph_request_failed status=503', 503) }))).rejects.toThrow('503');
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: b.account.id } })).status).toBe('connected');
  });

  test('a mailbox that is disconnected, has Sync calendar off, or belongs to a deactivated user is not read', async () => {
    const { graph, seen } = scripted({});
    const off = await mailbox({ syncCalendar: false });
    const gone = await mailbox({ status: 'disconnected' });
    const inactive = await mailbox();
    await prisma.user.update({ where: { id: inactive.user.id }, data: { isActive: false } });
    for (const a of [off, gone, inactive]) await syncCalendarHandler(job(a.account.id), { graph });
    expect(seen).toEqual([]);
  });

  test('Sync calendar switched off while a run is reading leaves nothing behind', async () => {
    const { user, account } = await mailbox();
    const graph = fakeGraph({
      async calendarDeltaPage() {
        await prisma.emailAccount.update({ where: { id: account.id }, data: { syncCalendar: false } });
        return final([event()]);
      },
    });
    await syncCalendarHandler(job(account.id), { graph });
    expect(await prisma.calendarEvent.count({ where: { userId: user.id } })).toBe(0);
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).calendarSyncState).toBeNull();
  });

  test('disconnected mid-run, then 503: the run fails and leaves nothing behind', async () => {
    const { user, account } = await mailbox();
    const graph = fakeGraph({
      async calendarDeltaPage(_account, url) {
        if (url.includes('startDateTime=')) return { events: [event(), event()], removed: [], nextLink: 'https://graph.microsoft.com/v1.0/p/2' };
        // The route has deleted the copy and disconnected; then Graph fails.
        await prisma.emailAccount.update({ where: { id: account.id }, data: { status: 'disconnected', refreshTokenEnc: '' } });
        throw new GraphError('graph_request_failed status=503', 503);
      },
    });
    await expect(syncCalendarHandler(job(account.id), { graph })).rejects.toThrow('503');
    expect(await prisma.calendarEvent.count({ where: { userId: user.id } })).toBe(0);
  });

  test('switched off mid-run, then 401: nothing is left behind', async () => {
    const { user, account } = await mailbox();
    const graph = fakeGraph({
      async calendarDeltaPage(_account, url) {
        if (url.includes('startDateTime=')) return { events: [event()], removed: [], nextLink: 'https://graph.microsoft.com/v1.0/p/2' };
        await prisma.emailAccount.update({ where: { id: account.id }, data: { syncCalendar: false } });
        throw new GraphError('graph_request_failed status=401', 401);
      },
    });
    await syncCalendarHandler(job(account.id), { graph });
    expect(await prisma.calendarEvent.count({ where: { userId: user.id } })).toBe(0);
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).calendarSyncState).toBeNull();
  });

  test('a failure while sync is still on keeps what was stored (read again next run)', async () => {
    const { user, account } = await mailbox();
    const graph = fakeGraph({
      async calendarDeltaPage(_account, url) {
        if (url.includes('startDateTime=')) return { events: [event()], removed: [], nextLink: 'https://graph.microsoft.com/v1.0/p/2' };
        throw new GraphError('graph_request_failed status=503', 503);
      },
    });
    await expect(syncCalendarHandler(job(account.id), { graph })).rejects.toThrow('503');
    expect(await prisma.calendarEvent.count({ where: { userId: user.id } })).toBe(1);
  });

  test('a recurring occurrence with a long Graph id is stored', async () => {
    const { user, account } = await mailbox();
    const id = `AAMk${'x'.repeat(400)}`;
    await syncCalendarHandler(job(account.id), scripted({ start: final([event({ id })]) }));
    expect((await prisma.calendarEvent.findFirstOrThrow({ where: { userId: user.id } })).graphId).toBe(id);
  });

  test('the same Graph id for two users gives each their own row', async () => {
    const a = await mailbox();
    const b = await mailbox();
    for (const box of [a, b]) await syncCalendarHandler(job(box.account.id), scripted({ start: final([event({ id: 'same', subject: `for ${box.user.id}` })]) }));
    expect((await prisma.calendarEvent.findMany({ where: { graphId: 'same' }, orderBy: { id: 'asc' } })).map((r) => [r.userId, r.accountId]))
      .toEqual([[a.user.id, a.account.id], [b.user.id, b.account.id]]);
  });
});

describe('calendar sync scheduling (3C)', () => {
  test('one job per connected mailbox with Sync calendar on, 5 minutes after its last run, never two', async () => {
    const recent = new Date(Date.now() - 60_000);
    const a = await mailbox({ state: { link: LINK, at: recent.toISOString() }, syncAt: recent });
    const b = await mailbox();
    await mailbox({ status: 'error' });
    await mailbox({ syncCalendar: false });
    expect(await scheduleCalendarSync(prisma)).toBe(2);
    expect(await scheduleCalendarSync(prisma)).toBe(0);
    const jobs = await prisma.job.findMany({ where: { type: 'sync_calendar' }, orderBy: { id: 'asc' } });
    expect(jobs.map((j) => j.payload)).toEqual([{ accountId: a.account.id }, { accountId: b.account.id }]);
    expect(jobs[0]!.runAt.getTime()).toBe(recent.getTime() + 5 * 60_000);
    expect(jobs[1]!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("no sync is queued for a deactivated user's mailbox", async () => {
    const { user } = await mailbox();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect(await scheduleCalendarSync(prisma)).toBe(0);
  });

  test('after a failed run the next one waits 5 minutes; a mail sync job does not count', async () => {
    const { account } = await mailbox({ state: { link: LINK, at: new Date(Date.now() - 3600_000).toISOString() } });
    const failedAt = new Date(Date.now() - 60_000);
    await prisma.job.create({ data: { type: 'sync_calendar', payload: { accountId: account.id }, status: 'failed', runAt: failedAt, updatedAt: failedAt } });
    await prisma.job.create({ data: { type: 'sync_mailbox', payload: { accountId: account.id }, status: 'queued', runAt: new Date() } });
    expect(await scheduleCalendarSync(prisma)).toBe(1);
    const next = await prisma.job.findFirstOrThrow({ where: { type: 'sync_calendar', status: 'queued' } });
    expect(Math.abs(next.runAt.getTime() - (failedAt.getTime() + 5 * 60_000))).toBeLessThan(1000);
  });
});
