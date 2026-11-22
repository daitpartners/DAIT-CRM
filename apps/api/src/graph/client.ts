import { ConfidentialClientApplication } from '@azure/msal-node';
import type { EmailAccount, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { decrypt, encrypt } from '../crypto/tokens.js';
import { readRefreshToken, type MsEnv } from '../auth/microsoft.js';
import { nearestUtcMidnight } from '../leads/dates.js';

export interface MailMessage {
  to: string[];
  cc?: string[];
  /** Release 2C Mailer: hidden copies. */
  bcc?: string[];
  subject: string;
  html: string;
  text: string;
}

/** Folders mail sync reads (Graph well-known names). */
export type MailFolder = 'inbox' | 'sentitems' | 'drafts' | 'archive';

/** A message as sync stores it (addresses lower-cased). */
export interface GraphMessage {
  id: string;
  subject: string;
  from: { name: string; address: string } | null;
  to: string[];
  cc: string[];
  receivedAt: string;
  sentAt: string | null;
  isRead: boolean;
  isDraft: boolean;
  conversationId: string | null;
  internetMessageId: string | null;
  hasAttachments: boolean;
  bodyText: string;
}

/** One page of a delta query: changed messages, removed ids, and the link to continue from. */
export interface DeltaPage {
  messages: GraphMessage[];
  removed: string[];
  nextLink?: string;
  deltaLink?: string;
}

/** A calendar event as calendar sync stores it (release 3C): times in UTC, addresses lower-cased. */
export interface GraphEvent {
  id: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  isCancelled: boolean;
  location: string | null;
  organizer: { name: string; address: string } | null;
  /** Attendee addresses (the organiser apart unless listed). */
  attendees: string[];
  isOnline: boolean;
}

/** One page of a calendar view delta query. */
export interface CalendarDeltaPage {
  events: GraphEvent[];
  removed: string[];
  nextLink?: string;
  deltaLink?: string;
  /** Entries left out because their times were not in UTC or unreadable (present when any). */
  skipped?: number;
}

export interface GraphClient {
  sendMail(account: EmailAccount, msg: MailMessage): Promise<void>;
  /** Release 2B-2 (the account's own mailbox, delegated): */
  deltaPage(account: EmailAccount, url: string): Promise<DeltaPage>;
  attachmentNames(account: EmailAccount, graphId: string): Promise<string[]>;
  markRead(account: EmailAccount, graphId: string, isRead: boolean): Promise<void>;
  moveTo(account: EmailAccount, graphId: string, folder: 'archive' | 'inbox'): Promise<void>;
  reply(account: EmailAccount, graphId: string, msg: { to: string[]; cc?: string[]; html: string }): Promise<void>;
  /** Release 3C (the account's own calendar, read only): */
  calendarDeltaPage(account: EmailAccount, url: string): Promise<CalendarDeltaPage>;
}

export const GRAPH_SEND_SCOPES = [
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.Send.Shared',
  'offline_access',
];

/** Reading and changing the user's own mail (consented at connect time with CONNECT_SCOPES). */
export const GRAPH_MAIL_SCOPES = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'offline_access',
];

/**
 * Reading the user's own calendar (release 3C). Calendars.ReadWrite is the permission consented at connect time
 * (CONNECT_SCOPES); the CRM never writes to Outlook.
 */
export const GRAPH_CALENDAR_SCOPES = ['https://graph.microsoft.com/Calendars.ReadWrite', 'offline_access'];

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SYNC_FIELDS = [
  'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'sentDateTime', 'isRead', 'isDraft',
  'conversationId', 'internetMessageId', 'hasAttachments', 'body',
];
/** Immutable ids survive moves between folders, so a message keeps its row when archived. */
const IMMUTABLE = 'IdType="ImmutableId"';

/** Start of a folder's delta query: messages received since `since`. */
export function deltaStartUrl(folder: MailFolder, since: Date): string {
  const q = new URLSearchParams({ $select: SYNC_FIELDS.join(','), $filter: `receivedDateTime ge ${since.toISOString()}` });
  return `${GRAPH}/me/mailFolders/${folder}/messages/delta?${q.toString()}`;
}

/**
 * Start of a calendar view delta query over [start, end): recurring meetings come as single occurrences. The view
 * delta takes no $select or $filter, and its links keep this window.
 */
export function calendarDeltaStartUrl(start: Date, end: Date): string {
  const q = new URLSearchParams({ startDateTime: start.toISOString(), endDateTime: end.toISOString() });
  return `${GRAPH}/me/calendarView/delta?${q.toString()}`;
}

const messageUrl = (graphId: string) => `${GRAPH}/me/messages/${encodeURIComponent(graphId)}`;

/** Graph sendMail endpoint for the mailbox the account sends as (its own address unless `sendAs` names a shared one). */
export function sendMailUrl(account: Pick<EmailAccount, 'address' | 'sendAs'>): string {
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(account.sendAs ?? account.address)}/sendMail`;
}
export const SEND_TIMEOUT_MS = 20_000;

/** A Graph call failed; `status` is the HTTP status (401 for token problems). */
export class GraphError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GraphError';
  }
}

/** True when the mailbox needs reconnecting (expired/revoked consent), not for throttling or outages. */
export function isAuthFailure(err: unknown): boolean {
  if (err instanceof GraphError) return err.status === 401;
  const e = err as { errorCode?: unknown; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.errorCode === 'invalid_grant' || e.errorCode === 'interaction_required') return true;
  return typeof e.message === 'string' && /\binvalid_grant\b/.test(e.message);
}

const recipients = (list: string[] = []) => list.map((address) => ({ emailAddress: { address } }));

type GraphAddress = { emailAddress?: { name?: unknown; address?: unknown } } | null | undefined;
const addressOf = (r: GraphAddress): string => (typeof r?.emailAddress?.address === 'string' ? r.emailAddress.address.trim().toLowerCase() : '');
const addressList = (list: unknown): string[] => (Array.isArray(list) ? list.map((r) => addressOf(r as GraphAddress)).filter(Boolean) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A delta entry as a GraphMessage. */
function toMessage(v: Record<string, unknown>): GraphMessage {
  const from = v.from as GraphAddress;
  const fromAddress = addressOf(from);
  const body = v.body as { content?: unknown } | undefined;
  return {
    id: String(v.id),
    subject: str(v.subject) ?? '',
    from: fromAddress ? { name: str(from?.emailAddress?.name) ?? '', address: fromAddress } : null,
    to: addressList(v.toRecipients),
    cc: addressList(v.ccRecipients),
    receivedAt: str(v.receivedDateTime) ?? new Date().toISOString(),
    sentAt: str(v.sentDateTime),
    isRead: v.isRead !== false,
    isDraft: v.isDraft === true,
    conversationId: str(v.conversationId),
    internetMessageId: str(v.internetMessageId),
    hasAttachments: v.hasAttachments === true,
    bodyText: str(body?.content) ?? '',
  };
}

/**
 * A Graph dateTimeTimeZone in UTC (asked for with `outlook.timezone="UTC"`; a missing zone is taken as UTC) as an ISO
 * string; null when unreadable or in another zone (never stored at a wrong time).
 */
function utc(v: unknown): string | null {
  const tz = str((v as { timeZone?: unknown } | null | undefined)?.timeZone);
  if (tz && tz.trim().toUpperCase() !== 'UTC') return null;
  const dt = str((v as { dateTime?: unknown } | null | undefined)?.dateTime);
  const at = dt ? Date.parse(`${dt.replace(/Z$/, '').replace(/(\.\d{3})\d*$/, '$1')}Z`) : NaN;
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** A calendar delta entry as a GraphEvent; null for one without readable UTC times (skipped). */
function toEvent(v: Record<string, unknown>): GraphEvent | null {
  const isAllDay = v.isAllDay === true;
  // An all-day event is kept as midnight to midnight UTC of its dates (see nearestUtcMidnight).
  const day = (iso: string | null) => (iso && isAllDay ? nearestUtcMidnight(new Date(iso)).toISOString() : iso);
  const startsAt = day(utc(v.start));
  const endsAt = day(utc(v.end));
  if (!startsAt || !endsAt) return null;
  const organizer = v.organizer as GraphAddress;
  const organizerAddress = addressOf(organizer);
  const location = str((v.location as { displayName?: unknown } | undefined)?.displayName)?.trim();
  return {
    id: String(v.id),
    subject: str(v.subject) ?? '',
    startsAt,
    endsAt,
    isAllDay,
    isCancelled: v.isCancelled === true,
    location: location || null,
    organizer: organizerAddress ? { name: str(organizer?.emailAddress?.name) ?? '', address: organizerAddress } : null,
    attendees: addressList(v.attendees),
    isOnline: v.isOnlineMeeting === true,
  };
}

/** A GraphError for a failed response: status, Retry-After for throttling, and Graph's error code (never the body). */
async function responseError(prefix: string, res: Response): Promise<GraphError> {
  let code = '';
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    if (typeof body.error?.code === 'string') code = ` code=${body.error.code.slice(0, 100)}`;
  } catch {
    // Body is not JSON; the status is enough.
  }
  const retryAfter = res.status === 429 ? ` retry-after=${res.headers.get('Retry-After') ?? 'unknown'}` : '';
  return new GraphError(`${prefix} status=${res.status}${retryAfter}${code}`, res.status);
}

export function createGraphClient(env: MsEnv = process.env, db: PrismaClient = prisma): GraphClient {
  /**
   * Access tokens already obtained, by account, scopes and the stored refresh token (so a disconnected or reconnected
   * mailbox never reuses one), kept until 5 minutes before they expire. A mail sync makes many calls: one sign-in each
   * would delay every other job and risk Microsoft throttling.
   */
  const tokens = new Map<string, { token: string; until: number }>();

  /** An access token for the account (refresh-token grant); a rotated refresh token is stored encrypted. */
  async function accessToken(account: EmailAccount, scopes: string[]): Promise<string> {
    const key = `${account.id}|${scopes.join(' ')}|${account.refreshTokenEnc}`;
    const cached = tokens.get(key);
    if (cached && cached.until > Date.now()) return cached.token;
    const token = await freshToken(account, scopes);
    for (const [k, v] of tokens) if (v.until <= Date.now() || k.startsWith(`${account.id}|${scopes.join(' ')}|`)) tokens.delete(k);
    tokens.set(key, token);
    return token.token;
  }

  async function freshToken(account: EmailAccount, scopes: string[]): Promise<{ token: string; until: number }> {
    const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = env;
    if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) throw new Error('microsoft_not_configured');

    let refreshToken: string;
    try {
      refreshToken = decrypt(account.refreshTokenEnc);
    } catch {
      // TOKEN_ENCRYPTION_KEY changed (or the row was damaged): only reconnecting the mailbox fixes it.
      throw new GraphError('token_unreadable', 401);
    }

    // A fresh MSAL client per sign-in: refresh tokens never sit in a shared MSAL cache.
    const msal = new ConfidentialClientApplication({
      auth: {
        clientId: MS_CLIENT_ID,
        clientSecret: MS_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${MS_TENANT_ID}`,
      },
    });
    const result = await msal.acquireTokenByRefreshToken({ refreshToken, scopes });
    if (!result?.accessToken) throw new GraphError('graph_token_failed', 401);

    const rotated = readRefreshToken(msal.getTokenCache().serialize());
    if (rotated && rotated !== refreshToken) {
      await db.emailAccount.update({
        where: { id: account.id },
        data: { refreshTokenEnc: encrypt(rotated), tokenExpiresAt: result.expiresOn ?? null },
      });
    }
    const expires = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 30 * 60_000;
    return { token: result.accessToken, until: expires - 5 * 60_000 };
  }

  /** One Graph request; a hung request is treated like a 5xx (retried later, the mailbox stays connected). */
  async function request(prefix: string, token: string, url: string, init: { method: string; body?: unknown; prefer?: string }): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(init.prefer ? { Prefer: init.prefer } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new GraphError(`${prefix} timeout`, 504);
      throw err;
    }
    if (!res.ok) throw await responseError(prefix, res);
    return res;
  }

  /** A call on the account's own mailbox (immutable ids). */
  async function mailCall(account: EmailAccount, url: string, method: string, body?: unknown, prefer = IMMUTABLE): Promise<Response> {
    const token = await accessToken(account, GRAPH_MAIL_SCOPES);
    return request('graph_request_failed', token, url, { method, body, prefer });
  }

  return {
    async sendMail(account, msg) {
      const token = await accessToken(account, GRAPH_SEND_SCOPES);
      await request('graph_send_failed', token, sendMailUrl(account), {
        method: 'POST',
        body: {
          message: {
            subject: msg.subject,
            body: { contentType: 'HTML', content: msg.html },
            toRecipients: recipients(msg.to),
            ccRecipients: recipients(msg.cc),
            ...(msg.bcc?.length ? { bccRecipients: recipients(msg.bcc) } : {}),
          },
          saveToSentItems: true,
        },
      });
    },

    async deltaPage(account, url) {
      // Stored links come from Graph; never send the token anywhere else.
      if (!url.startsWith(`${GRAPH}/`)) throw new Error('not_a_graph_link');
      const res = await mailCall(account, url, 'GET', undefined, `${IMMUTABLE}, odata.maxpagesize=50, outlook.body-content-type="text"`);
      const page = (await res.json()) as { value?: Record<string, unknown>[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
      const messages: GraphMessage[] = [];
      const removed: string[] = [];
      for (const v of page.value ?? []) {
        if (v['@removed']) removed.push(String(v.id));
        else messages.push(toMessage(v));
      }
      return { messages, removed, nextLink: page['@odata.nextLink'], deltaLink: page['@odata.deltaLink'] };
    },

    async attachmentNames(account, graphId) {
      const res = await mailCall(account, `${messageUrl(graphId)}/attachments?$select=name`, 'GET');
      const body = (await res.json()) as { value?: { name?: unknown }[] };
      return (body.value ?? []).map((a) => str(a.name)).filter((n): n is string => !!n);
    },

    async markRead(account, graphId, isRead) {
      await mailCall(account, messageUrl(graphId), 'PATCH', { isRead });
    },

    async moveTo(account, graphId, folder) {
      await mailCall(account, `${messageUrl(graphId)}/move`, 'POST', { destinationId: folder });
    },

    async reply(account, graphId, msg) {
      await mailCall(account, `${messageUrl(graphId)}/reply`, 'POST', {
        comment: msg.html,
        message: { toRecipients: recipients(msg.to), ccRecipients: recipients(msg.cc) },
      });
    },

    async calendarDeltaPage(account, url) {
      if (!url.startsWith(`${GRAPH}/`)) throw new Error('not_a_graph_link');
      const token = await accessToken(account, GRAPH_CALENDAR_SCOPES);
      const res = await request('graph_request_failed', token, url, { method: 'GET', prefer: `${IMMUTABLE}, odata.maxpagesize=50, outlook.timezone="UTC"` });
      const page = (await res.json()) as { value?: Record<string, unknown>[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
      const events: GraphEvent[] = [];
      const removed: string[] = [];
      let skipped = 0;
      for (const v of page.value ?? []) {
        if (v['@removed']) removed.push(String(v.id));
        else {
          const event = toEvent(v);
          if (event) events.push(event);
          else skipped += 1;
        }
      }
      return { events, removed, nextLink: page['@odata.nextLink'], deltaLink: page['@odata.deltaLink'], ...(skipped ? { skipped } : {}) };
    },
  };
}
