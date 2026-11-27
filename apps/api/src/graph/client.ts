import { ConfidentialClientApplication } from '@azure/msal-node';
import type { EmailAccount, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { decrypt, encrypt } from '../crypto/tokens.js';
import { readRefreshToken, type MsEnv } from '../auth/microsoft.js';
import type { GraphBody } from '../mail/html.js';

/**
 * A file sent with a message (Graph fileAttachment, inline in the request: Graph takes at most 4 MB per request, so the
 * caller keeps attachments under that with room for the rest; see MAX_PDF_BASE64 in quotations/send.ts).
 */
export interface MailAttachment {
  name: string;
  contentType: string;
  contentBase64: string;
  /** Template pictures (24 Nov 2026): a picture the HTML shows as `cid:<contentId>`, not listed as an attachment. */
  isInline?: boolean;
  contentId?: string;
}

export interface MailMessage {
  to: string[];
  cc?: string[];
  /** Release 2C Mailer: hidden copies. */
  bcc?: string[];
  subject: string;
  html: string;
  text: string;
  /** Release 3A: the quotation PDF; template pictures (inline) and attachments (24 Nov 2026). */
  attachments?: MailAttachment[];
}

/** Folders mail sync reads (Graph well-known names). */
export type MailFolder = 'inbox' | 'sentitems' | 'drafts' | 'archive' | 'deleteditems';

/** A message as sync stores it (addresses lower-cased). */
export interface GraphMessage {
  id: string;
  subject: string;
  from: { name: string; address: string } | null;
  to: string[];
  cc: string[];
  /** Hidden copies (from `bccRecipients`): Graph returns them on the sender's own copies only. */
  bcc: string[];
  receivedAt: string;
  sentAt: string | null;
  isRead: boolean;
  isDraft: boolean;
  conversationId: string | null;
  internetMessageId: string | null;
  hasAttachments: boolean;
  /** HTML as Graph sends it (asked for with `outlook.body-content-type="html"`); sync sanitises it before storing. */
  body: GraphBody;
  /**
   * Web-mail release 2: the Outlook flag. `due` is Graph's `dueDateTime` exactly as sent (Graph sends UTC unless asked
   * otherwise, so 27 Nov in Asia/Kolkata arrives as `2026-11-26T18:30:00`); the sync turns it into the user's own day.
   */
  flag: { status: GraphFlagStatus; due: { dateTime: string; timeZone: string } | null };
}

export type GraphFlagStatus = 'notFlagged' | 'flagged' | 'complete';

/** A message's attachment as listed by Graph (web-mail release 2): never stored, read on demand. */
export interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  /**
   * Web-mail release 3: what the HTML's `cid:` refers to (a fileAttachment's contentId), read only by getDraft; absent
   * or null otherwise.
   */
  contentId?: string | null;
  /** file = bytes (fileAttachment), item = an attached message or event, reference = a link to a cloud file. */
  kind: 'file' | 'item' | 'reference';
}

/**
 * A flag to set (web-mail release 2): a due day with its start day (`YYYY-MM-DD`, midnight in `timeZone`, the user's
 * zone), flagged with no dates (both null), Mark complete, or Clear flag (`notFlagged`).
 */
export type GraphFlag =
  | { status: 'notFlagged' }
  | { status: 'complete' }
  | { status: 'flagged'; start: string | null; due: string | null; timeZone: string };

/** Mail sent from an existing message (reply, reply all, forward). */
export interface GraphResponseMessage {
  to: string[];
  cc?: string[];
  html: string;
}

/**
 * A draft's fields as the CRM writes them (web-mail release 3); `from` is a send-as address, left out when unset so
 * Outlook sends from the mailbox itself.
 */
export interface DraftFields {
  subject: string;
  html: string;
  to: string[];
  cc: string[];
  bcc: string[];
  from?: string | null;
}

/** An Outlook draft as Graph returns it (web-mail release 3): addresses lower-cased, `html` the body as HTML. */
export interface GraphDraft {
  id: string;
  conversationId: string | null;
  subject: string;
  html: string;
  to: string[];
  cc: string[];
  bcc: string[];
  lastModified: string;
  attachments: GraphAttachment[];
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

/** One page of a mailbox search: each message with the id of the folder it sits in, and the link to continue from. */
export interface SearchPage {
  items: { folderId: string; message: GraphMessage }[];
  nextLink?: string;
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
  /** Web-mail release 2: a message's attachments (inline pictures included). */
  listAttachments(account: EmailAccount, graphId: string): Promise<GraphAttachment[]>;
  /** One attachment's bytes; more than `maxBytes` is `GraphError('attachment_too_large', 413)`, never read in full. */
  attachmentContent(account: EmailAccount, graphId: string, attachmentId: string, maxBytes: number): Promise<Buffer>;
  markRead(account: EmailAccount, graphId: string, isRead: boolean): Promise<void>;
  moveTo(account: EmailAccount, graphId: string, folder: 'inbox' | 'archive' | 'deleteditems'): Promise<void>;
  /** Web-mail release 2: set, complete or clear the Outlook flag. */
  setFlag(account: EmailAccount, graphId: string, flag: GraphFlag): Promise<void>;
  /** Web-mail release 2: delete permanently (from Deleted items). */
  deleteMessage(account: EmailAccount, graphId: string): Promise<void>;
  reply(account: EmailAccount, graphId: string, msg: GraphResponseMessage): Promise<void>;
  replyAll(account: EmailAccount, graphId: string, msg: GraphResponseMessage): Promise<void>;
  forward(account: EmailAccount, graphId: string, msg: GraphResponseMessage): Promise<void>;
  /**
   * One message's body as HTML (a message synced before bodies were stored as HTML, opened in the reader); `timeoutMs`
   * shortens the usual request timeout.
   */
  messageBody(account: EmailAccount, graphId: string, opts?: { timeoutMs?: number }): Promise<GraphBody>;
  /** Web-mail release 1 (backfill): one page of a whole-mailbox search (start with searchStartUrl). */
  searchPage(account: EmailAccount, url: string): Promise<SearchPage>;
  /** Graph ids of the well-known folders sync reads; a folder the mailbox does not have (404) is left out. */
  folderIds(account: EmailAccount): Promise<Partial<Record<MailFolder, string>>>;
  /** Release 3C (the account's own calendar, read only): */
  calendarDeltaPage(account: EmailAccount, url: string): Promise<CalendarDeltaPage>;
  /** Web-mail release 3 (drafts in the account's own mailbox): a new draft in Drafts. */
  createDraft(account: EmailAccount, d: DraftFields): Promise<GraphDraft>;
  /** A reply, reply all or forward draft of a message, with Outlook's recipients, subject and quoted original. */
  createReplyDraft(account: EmailAccount, graphId: string, kind: 'reply' | 'replyAll' | 'forward'): Promise<GraphDraft>;
  /** A draft with its attachments (with their content-ids); a message that is no longer a draft (sent in Outlook) is `GraphError('not_a_draft', 409)`. */
  getDraft(account: EmailAccount, draftId: string): Promise<GraphDraft>;
  updateDraft(account: EmailAccount, draftId: string, d: DraftFields): Promise<void>;
  /** A file (or inline picture) uploaded to a draft. */
  addAttachment(account: EmailAccount, draftId: string, a: MailAttachment): Promise<{ id: string }>;
  removeAttachment(account: EmailAccount, draftId: string, attachmentId: string): Promise<void>;
  /** Sends a draft (Outlook moves it to Sent Items). */
  sendDraft(account: EmailAccount, draftId: string): Promise<void>;
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
  'subject', 'from', 'toRecipients', 'ccRecipients', 'bccRecipients', 'receivedDateTime', 'sentDateTime', 'isRead', 'isDraft',
  'conversationId', 'internetMessageId', 'hasAttachments', 'body', 'flag',
];
/** Immutable ids survive moves between folders, so a message keeps its row when archived. */
const IMMUTABLE = 'IdType="ImmutableId"';
/** Bodies as HTML, so the reader can show them formatted as Outlook does (owner, 23 Nov 2026). */
const HTML_BODY = 'outlook.body-content-type="html"';

/** Start of a folder's delta query: messages received since `since`. */
export function deltaStartUrl(folder: MailFolder, since: Date): string {
  const q = new URLSearchParams({ $select: SYNC_FIELDS.join(','), $filter: `receivedDateTime ge ${since.toISOString()}` });
  return `${GRAPH}/me/mailFolders/${folder}/messages/delta?${q.toString()}`;
}

/**
 * Start of a whole-mailbox search for messages to or from `address` received since `since` (date only), 50 a page,
 * with the fields sync stores and the folder each message is in. `"` and `\` are removed from the address so it cannot
 * break out of the quoted search.
 */
export function searchStartUrl(address: string, since: Date): string {
  const clean = address.replace(/["\\]/g, '').trim().toLowerCase();
  const q = new URLSearchParams({
    $search: `"participants:${clean} AND received>=${since.toISOString().slice(0, 10)}"`,
    $select: [...SYNC_FIELDS, 'parentFolderId'].join(','),
    $top: '50',
  });
  return `${GRAPH}/me/messages?${q.toString()}`;
}

/** The well-known folders sync reads, in order. */
const MAIL_FOLDERS: MailFolder[] = ['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems'];

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

/** Graph's body object; anything but HTML is taken as text. */
function bodyOf(v: unknown): GraphBody {
  const body = v as { contentType?: unknown; content?: unknown } | null | undefined;
  return { contentType: str(body?.contentType)?.toLowerCase() === 'html' ? 'html' : 'text', content: str(body?.content) ?? '' };
}

const FLAG_STATUSES = new Set<string>(['notFlagged', 'flagged', 'complete']);

/** Graph's followupFlag: an unknown status is not flagged; a due date without a zone is UTC (Graph's default). */
function flagOf(v: unknown): GraphMessage['flag'] {
  const flag = v as { flagStatus?: unknown; dueDateTime?: { dateTime?: unknown; timeZone?: unknown } | null } | null | undefined;
  const raw = str(flag?.flagStatus);
  const status = (raw && FLAG_STATUSES.has(raw) ? raw : 'notFlagged') as GraphFlagStatus;
  const dateTime = status === 'flagged' ? str(flag?.dueDateTime?.dateTime) : null;
  return { status, due: dateTime ? { dateTime, timeZone: str(flag?.dueDateTime?.timeZone) ?? 'UTC' } : null };
}

const ATTACHMENT_KINDS: Record<string, GraphAttachment['kind']> = {
  '#microsoft.graph.fileAttachment': 'file',
  '#microsoft.graph.itemAttachment': 'item',
  '#microsoft.graph.referenceAttachment': 'reference',
};

/** A Graph attachment entry (null without an id). */
function toAttachment(v: Record<string, unknown>): GraphAttachment | null {
  const id = str(v.id);
  if (!id) return null;
  return {
    id,
    name: str(v.name) ?? '',
    contentType: str(v.contentType) || 'application/octet-stream',
    size: typeof v.size === 'number' && Number.isFinite(v.size) && v.size >= 0 ? v.size : 0,
    isInline: v.isInline === true,
    ...(typeof v.contentId === 'string' && v.contentId.trim() ? { contentId: v.contentId.trim() } : {}),
    kind: ATTACHMENT_KINDS[str(v['@odata.type']) ?? ''] ?? 'file',
  };
}

/** A day as Graph's dateTimeTimeZone at midnight in `timeZone`. */
const midnight = (day: string, timeZone: string) => ({ dateTime: `${day}T00:00:00`, timeZone });

/** The PATCH body for a flag: Graph takes both dates or neither, so one day alone is sent as both. */
function flagBody(flag: GraphFlag): { flag: Record<string, unknown> } {
  if (flag.status !== 'flagged') return { flag: { flagStatus: flag.status } };
  const start = flag.start ?? flag.due;
  const due = flag.due ?? flag.start;
  if (!start || !due) return { flag: { flagStatus: 'flagged' } };
  return { flag: { flagStatus: 'flagged', startDateTime: midnight(start, flag.timeZone), dueDateTime: midnight(due, flag.timeZone) } };
}

/** Graph's fileAttachment for a file sent or uploaded; inline (shown as `cid:`) only with a content id. */
const fileAttachment = (a: MailAttachment) => ({
  '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType, contentBytes: a.contentBase64,
  ...(a.isInline && a.contentId ? { isInline: true, contentId: a.contentId } : {}),
});

/** The message fields a draft is created or updated with (`from` only for a send-as address). */
const draftBody = (d: DraftFields) => ({
  subject: d.subject,
  body: { contentType: 'HTML', content: d.html },
  toRecipients: recipients(d.to),
  ccRecipients: recipients(d.cc),
  bccRecipients: recipients(d.bcc),
  ...(d.from ? { from: { emailAddress: { address: d.from } } } : {}),
});

/** A Graph message as a GraphDraft (attachments only when expanded). */
function toDraft(v: Record<string, unknown>): GraphDraft {
  const attachments = Array.isArray(v.attachments) ? (v.attachments as Record<string, unknown>[]) : [];
  return {
    id: String(v.id),
    conversationId: str(v.conversationId),
    subject: str(v.subject) ?? '',
    html: bodyOf(v.body).content,
    to: addressList(v.toRecipients),
    cc: addressList(v.ccRecipients),
    bcc: addressList(v.bccRecipients),
    lastModified: str(v.lastModifiedDateTime) ?? new Date().toISOString(),
    attachments: attachments.map(toAttachment).filter((a): a is GraphAttachment => a !== null),
  };
}

const DRAFT_SELECT = 'subject,body,toRecipients,ccRecipients,bccRecipients,conversationId,lastModifiedDateTime,isDraft';
const REPLY_ACTIONS = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' } as const;

const tooLarge = () => new GraphError('attachment_too_large', 413);

/** A response body read up to `maxBytes`; reading stops (and the download is cancelled) once it passes the cap. */
async function cappedBody(res: Response, maxBytes: number): Promise<Buffer> {
  const length = Number(res.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** A delta entry as a GraphMessage. */
function toMessage(v: Record<string, unknown>): GraphMessage {
  const from = v.from as GraphAddress;
  const fromAddress = addressOf(from);
  return {
    id: String(v.id),
    subject: str(v.subject) ?? '',
    from: fromAddress ? { name: str(from?.emailAddress?.name) ?? '', address: fromAddress } : null,
    to: addressList(v.toRecipients),
    cc: addressList(v.ccRecipients),
    bcc: addressList(v.bccRecipients),
    receivedAt: str(v.receivedDateTime) ?? new Date().toISOString(),
    sentAt: str(v.sentDateTime),
    isRead: v.isRead !== false,
    isDraft: v.isDraft === true,
    conversationId: str(v.conversationId),
    internetMessageId: str(v.internetMessageId),
    hasAttachments: v.hasAttachments === true,
    body: bodyOf(v.body),
    flag: flagOf(v.flag),
  };
}

/** Zone names Graph or Windows may send for UTC (upper-cased). */
const UTC_ZONES = new Set(['UTC', 'ETC/UTC', 'ETC/GMT', 'GMT', 'COORDINATED UNIVERSAL TIME', 'TZONE://MICROSOFT/UTC']);

/**
 * A Graph dateTimeTimeZone in UTC (asked for with `outlook.timezone="UTC"`; a missing zone is taken as UTC) as an ISO
 * string; null when unreadable or in another zone (never stored at a wrong time).
 */
function utc(v: unknown): string | null {
  const tz = str((v as { timeZone?: unknown } | null | undefined)?.timeZone);
  if (tz && !UTC_ZONES.has(tz.trim().toUpperCase())) return null;
  const dt = str((v as { dateTime?: unknown } | null | undefined)?.dateTime);
  const at = dt ? Date.parse(`${dt.replace(/Z$/, '').replace(/(\.\d{3})\d*$/, '$1')}Z`) : NaN;
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** A calendar delta entry as a GraphEvent; null for one without readable UTC times (skipped). */
function toEvent(v: Record<string, unknown>): GraphEvent | null {
  const isAllDay = v.isAllDay === true;
  // An all-day event's times stay as sent (often its own zone's midnight in UTC): the sync puts them on the owner's
  // dates (allDayMidnight), which needs the owner's time zone.
  const startsAt = utc(v.start);
  const endsAt = utc(v.end);
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
  async function request(
    prefix: string, token: string, url: string, init: { method: string; body?: unknown; prefer?: string; timeoutMs?: number },
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        signal: AbortSignal.timeout(init.timeoutMs ?? SEND_TIMEOUT_MS),
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
  async function mailCall(account: EmailAccount, url: string, method: string, body?: unknown, prefer = IMMUTABLE, timeoutMs?: number): Promise<Response> {
    const token = await accessToken(account, GRAPH_MAIL_SCOPES);
    return request('graph_request_failed', token, url, { method, body, prefer, timeoutMs });
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
            ...(msg.attachments?.length
              ? { attachments: msg.attachments.map(fileAttachment) }
              : {}),
          },
          saveToSentItems: true,
        },
      });
    },

    async deltaPage(account, url) {
      // Stored links come from Graph; never send the token anywhere else.
      if (!url.startsWith(`${GRAPH}/`)) throw new Error('not_a_graph_link');
      const res = await mailCall(account, url, 'GET', undefined, `${IMMUTABLE}, odata.maxpagesize=50, ${HTML_BODY}`);
      const page = (await res.json()) as { value?: Record<string, unknown>[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
      const messages: GraphMessage[] = [];
      const removed: string[] = [];
      for (const v of page.value ?? []) {
        if (v['@removed']) removed.push(String(v.id));
        else messages.push(toMessage(v));
      }
      return { messages, removed, nextLink: page['@odata.nextLink'], deltaLink: page['@odata.deltaLink'] };
    },

    async listAttachments(account, graphId) {
      const res = await mailCall(account, `${messageUrl(graphId)}/attachments?$select=id,name,contentType,size,isInline`, 'GET');
      const body = (await res.json()) as { value?: Record<string, unknown>[] };
      return (body.value ?? []).map(toAttachment).filter((a): a is GraphAttachment => a !== null);
    },

    async attachmentContent(account, graphId, attachmentId, maxBytes) {
      // Attachment ids are base64 (`+`, `/`, `=`): encoded, so the id stays one path segment.
      const res = await mailCall(account, `${messageUrl(graphId)}/attachments/${encodeURIComponent(attachmentId)}/$value`, 'GET');
      try {
        return await cappedBody(res, maxBytes);
      } catch (err) {
        // The request's timeout also covers reading the body: a stalled download is retryable like a hung request.
        const name = (err as { name?: unknown } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') throw new GraphError('graph_request_failed timeout', 504);
        throw err;
      }
    },

    async markRead(account, graphId, isRead) {
      await mailCall(account, messageUrl(graphId), 'PATCH', { isRead });
    },

    async moveTo(account, graphId, folder) {
      await mailCall(account, `${messageUrl(graphId)}/move`, 'POST', { destinationId: folder });
    },

    async setFlag(account, graphId, flag) {
      await mailCall(account, messageUrl(graphId), 'PATCH', flagBody(flag));
    },

    async deleteMessage(account, graphId) {
      await mailCall(account, messageUrl(graphId), 'DELETE');
    },

    async reply(account, graphId, msg) {
      await mailCall(account, `${messageUrl(graphId)}/reply`, 'POST', {
        comment: msg.html,
        message: { toRecipients: recipients(msg.to), ccRecipients: recipients(msg.cc) },
      });
    },

    async replyAll(account, graphId, msg) {
      await mailCall(account, `${messageUrl(graphId)}/replyAll`, 'POST', {
        comment: msg.html,
        message: { toRecipients: recipients(msg.to), ccRecipients: recipients(msg.cc) },
      });
    },

    async forward(account, graphId, msg) {
      // Graph's forward takes toRecipients at the top level but no top-level ccRecipients: Cc goes in `message`.
      await mailCall(account, `${messageUrl(graphId)}/forward`, 'POST', {
        comment: msg.html,
        toRecipients: recipients(msg.to),
        message: { ccRecipients: recipients(msg.cc) },
      });
    },

    async messageBody(account, graphId, opts) {
      const res = await mailCall(account, `${messageUrl(graphId)}?$select=body`, 'GET', undefined, `${IMMUTABLE}, ${HTML_BODY}`, opts?.timeoutMs);
      return bodyOf(((await res.json()) as { body?: unknown }).body);
    },

    async searchPage(account, url) {
      // Next links come from Graph; never send the token anywhere else.
      if (!url.startsWith(`${GRAPH}/`)) throw new Error('not_a_graph_link');
      const res = await mailCall(account, url, 'GET', undefined, `${IMMUTABLE}, ${HTML_BODY}`);
      const page = (await res.json()) as { value?: Record<string, unknown>[]; '@odata.nextLink'?: string };
      return {
        items: (page.value ?? []).map((v) => ({ folderId: str(v.parentFolderId) ?? '', message: toMessage(v) })),
        nextLink: page['@odata.nextLink'],
      };
    },

    async folderIds(account) {
      // One at a time: the first call signs in and the rest reuse its token (parallel calls would each sign in).
      const ids: Partial<Record<MailFolder, string>> = {};
      for (const folder of MAIL_FOLDERS) {
        try {
          const res = await mailCall(account, `${GRAPH}/me/mailFolders/${folder}?$select=id`, 'GET', undefined, `${IMMUTABLE}, ${HTML_BODY}`);
          const id = str(((await res.json()) as { id?: unknown }).id);
          if (id) ids[folder] = id;
        } catch (err) {
          // A mailbox without the folder (often Archive): sync tolerates the same 404 per folder.
          if (!(err instanceof GraphError && err.status === 404)) throw err;
        }
      }
      return ids;
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

    async createDraft(account, d) {
      const res = await mailCall(account, `${GRAPH}/me/messages`, 'POST', draftBody(d), `${IMMUTABLE}, ${HTML_BODY}`);
      return toDraft((await res.json()) as Record<string, unknown>);
    },

    async createReplyDraft(account, graphId, kind) {
      const res = await mailCall(account, `${messageUrl(graphId)}/${REPLY_ACTIONS[kind]}`, 'POST', {}, `${IMMUTABLE}, ${HTML_BODY}`);
      return toDraft((await res.json()) as Record<string, unknown>);
    },

    async getDraft(account, draftId) {
      const url = `${messageUrl(draftId)}?$select=${DRAFT_SELECT}&$expand=attachments($select=id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId)`;
      const res = await mailCall(account, url, 'GET', undefined, `${IMMUTABLE}, ${HTML_BODY}`);
      const v = (await res.json()) as Record<string, unknown>;
      if (v.isDraft === false) throw new GraphError('not_a_draft', 409);
      return toDraft(v);
    },

    async updateDraft(account, draftId, d) {
      await mailCall(account, messageUrl(draftId), 'PATCH', draftBody(d));
    },

    async addAttachment(account, draftId, a) {
      const res = await mailCall(account, `${messageUrl(draftId)}/attachments`, 'POST', fileAttachment(a));
      const id = str(((await res.json()) as { id?: unknown }).id);
      if (!id) throw new GraphError('graph_request_failed attachment_without_id', 502);
      return { id };
    },

    async removeAttachment(account, draftId, attachmentId) {
      await mailCall(account, `${messageUrl(draftId)}/attachments/${encodeURIComponent(attachmentId)}`, 'DELETE');
    },

    async sendDraft(account, draftId) {
      await mailCall(account, `${messageUrl(draftId)}/send`, 'POST', undefined, IMMUTABLE, SEND_TIMEOUT_MS);
    },
  };
}
