import type { EmailAccount, Job } from '@prisma/client';
import { prisma } from '../../db.js';
import { enqueue, errorMessage } from '../queue.js';
import { GraphError, calendarDeltaStartUrl, isAuthFailure, type GraphEvent } from '../../graph/client.js';
import { isUniqueViolation } from '../../prismaErrors.js';
import { mailUser, matchCalendarEvent } from '../../mail/match.js';
import { dropCalendarCopy, type CalendarSyncState } from '../../calendar/schedule.js';
import { allDayMidnight } from '../../leads/dates.js';
import type { AuthUser } from '../../plugins/auth.js';
import type { SyncCalendarPayload } from '../types.js';
import type { JobContext } from '../runner.js';

/** The rolling window copied (owner-approved design, release 3C). */
export const WINDOW_BACK_DAYS = 30;
export const WINDOW_AHEAD_DAYS = 180;
export const MAX_PAGES = 20;
/** A delta link keeps the window it started with, so the sync starts afresh this often to roll the window. */
export const RESTART_EVERY_MS = 24 * 3600_000;
/** A run that stopped at the page cap continues this soon. */
const MORE_AFTER_MS = 60_000;
const DAY_MS = 86_400_000;

const isOwn = (account: EmailAccount, address: string) => [account.address, account.sendAs].some((a) => a?.toLowerCase() === address);

/**
 * Stores or updates one event for its owner; a cancelled one is deleted. The lead link follows the 3C rule (an
 * attendee or the organiser, not the mailbox itself, who is a contact on an open lead the user can see); only the
 * lead and company are kept. Every stored event is written, so a restart can tell which ones it did not see.
 */
async function storeEvent(account: EmailAccount, user: AuthUser, e: GraphEvent): Promise<void> {
  if (e.isCancelled) {
    await prisma.calendarEvent.deleteMany({ where: { userId: user.id, graphId: e.id } });
    return;
  }
  const attendees = [...new Set(e.attendees.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const organizerAddress = e.organizer?.address.trim().toLowerCase() || null;
  const counterparts = [...attendees, ...(organizerAddress ? [organizerAddress] : [])].filter((a) => !isOwn(account, a));
  const { leadId, companyId } = await matchCalendarEvent(prisma, user, { counterparts, ownAddress: account.address });
  // All-day: midnight to midnight UTC of its dates in the owner's zone.
  const when = (iso: string) => (e.isAllDay ? allDayMidnight(new Date(iso), user.timezone) : new Date(iso));
  const data = {
    accountId: account.id, subject: e.subject.slice(0, 500), startsAt: when(e.startsAt), endsAt: when(e.endsAt), isAllDay: e.isAllDay,
    location: e.location?.slice(0, 500) ?? null, organizerName: e.organizer?.name ? e.organizer.name.slice(0, 255) : null,
    organizerAddress: organizerAddress?.slice(0, 320) ?? null, attendeeAddresses: attendees, isOnline: e.isOnline,
    leadId, companyId,
  };
  const where = { userId_graphId: { userId: user.id, graphId: e.id } };
  try {
    await prisma.calendarEvent.upsert({ where, create: { userId: user.id, graphId: e.id, ...data }, update: data });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await prisma.calendarEvent.update({ where, data }); // a concurrent run created it first
  }
}

/**
 * Sync calendar switched off, the mailbox disconnected or taken over while a run was reading: nothing the run stored
 * may stay. True when the copy was dropped.
 */
async function dropIfGone(accountId: number, userId: number): Promise<boolean> {
  const fresh = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!fresh || (fresh.status !== 'disconnected' && fresh.syncCalendar && fresh.userId === userId)) return false;
  await dropCalendarCopy(prisma, accountId);
  return true;
}

/**
 * Copies the owner's Outlook calendar (release 3C) from a connected personal mailbox with Sync calendar on: a Graph
 * calendar view delta over 30 days back to 180 days ahead, continued from the stored link, at most MAX_PAGES pages per
 * run (the rest a minute later). It starts afresh when there is no link, the link was read for another user, the last
 * restart is over 24 hours old, or Graph expired the link (410); when that first listing ends, the account's events it
 * did not see (outside the new window, or gone) are deleted. A revoked token puts the mailbox in `error`. Sync calendar
 * switched off or the mailbox disconnected meanwhile: the copy is dropped.
 */
export async function syncCalendarHandler(job: Job, ctx: JobContext): Promise<void> {
  const { accountId } = job.payload as unknown as SyncCalendarPayload;
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account || account.kind !== 'personal' || account.status !== 'connected' || !account.syncCalendar || account.userId === null) return;
  const user = await mailUser(prisma, account.userId);
  if (!user) return;

  const now = new Date();
  const saved = (account.calendarSyncState ?? {}) as CalendarSyncState;
  const startUrl = () => calendarDeltaStartUrl(new Date(now.getTime() - WINDOW_BACK_DAYS * DAY_MS), new Date(now.getTime() + WINDOW_AHEAD_DAYS * DAY_MS));
  let restarted = !saved.link || saved.userId !== user.id || !account.calendarSyncAt || now.getTime() - account.calendarSyncAt.getTime() > RESTART_EVERY_MS;
  let restartedAt = restarted ? now : account.calendarSyncAt!;
  let full = restarted || saved.full === true;
  let url = restarted ? startUrl() : saved.link!;
  let more = true;
  let skipped = 0;
  try {
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      let page;
      try {
        page = await ctx.graph.calendarDeltaPage(account, url);
      } catch (err) {
        if (err instanceof GraphError && err.status === 410 && !restarted) {
          restarted = full = true;
          restartedAt = now;
          url = startUrl();
          pages = -1;
          continue;
        }
        throw err;
      }
      // Changes are applied page by page: a run that fails keeps the old link, and reading it again is harmless.
      for (const e of page.events) await storeEvent(account, user, e);
      skipped += page.skipped ?? 0;
      if (page.removed.length) await prisma.calendarEvent.deleteMany({ where: { userId: user.id, graphId: { in: page.removed } } });
      if (!page.nextLink) {
        url = page.deltaLink ?? url;
        more = false;
        break;
      }
      url = page.nextLink;
    }
  } catch (err) {
    if (isAuthFailure(err)) {
      // Only the connection this run used: a mailbox disconnected or reconnected meanwhile keeps its new state.
      await prisma.emailAccount.updateMany({
        where: { id: account.id, status: 'connected', refreshTokenEnc: account.refreshTokenEnc },
        data: { status: 'error', lastError: errorMessage(err) },
      });
      await dropIfGone(account.id, user.id);
      return;
    }
    await dropIfGone(account.id, user.id);
    throw err;
  }
  if (skipped) console.warn(`sync_calendar: account ${account.id}: ${skipped} event(s) skipped (time not in UTC or unreadable)`);

  if (full && !more) await prisma.calendarEvent.deleteMany({ where: { accountId: account.id, updatedAt: { lt: restartedAt } } });
  const state: CalendarSyncState = { link: url, userId: user.id, ...(full && more ? { full: true } : {}), at: new Date().toISOString() };
  const stored = await prisma.emailAccount.updateMany({
    where: { id: account.id, status: 'connected', syncCalendar: true, userId: user.id },
    data: { calendarSyncState: state as object, calendarSyncAt: restartedAt },
  });
  if (stored.count === 0) {
    await dropIfGone(account.id, user.id);
    return;
  }
  if (more) await enqueue(prisma, 'sync_calendar', { accountId: account.id }, { runAt: new Date(Date.now() + MORE_AFTER_MS), maxAttempts: 1 });
}
