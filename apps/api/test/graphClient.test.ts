import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const msalState = vi.hoisted(() => ({
  refreshTokensSeen: [] as string[],
  scopes: [] as string[][],
  rotated: 'rotated-refresh-token' as string | undefined,
  error: undefined as Error | undefined,
}));

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    async acquireTokenByRefreshToken(req: { refreshToken: string; scopes: string[] }) {
      msalState.refreshTokensSeen.push(req.refreshToken);
      msalState.scopes.push(req.scopes);
      if (msalState.error) throw msalState.error;
      return { accessToken: 'access-token-xyz', expiresOn: new Date(Date.now() + 3600_000) };
    }
    getTokenCache() {
      return {
        serialize: () =>
          JSON.stringify({ RefreshToken: msalState.rotated ? { k: { secret: msalState.rotated } } : {} }),
      };
    }
  },
}));

import { prisma } from '../src/db';
import { decrypt, encrypt } from '../src/crypto/tokens';
import { calendarDeltaStartUrl, createGraphClient, deltaStartUrl, GRAPH_CALENDAR_SCOPES, GRAPH_MAIL_SCOPES, GRAPH_SEND_SCOPES, GraphError, isAuthFailure, searchStartUrl, SEND_TIMEOUT_MS } from '../src/graph/client';
import { resetDb } from './helpers';

const env = { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's' };
const msg = { to: ['a@example.com'], cc: ['b@example.com'], subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' };

async function account() {
  return prisma.emailAccount.create({
    data: { address: 'crm@daitpartners.com', provider: 'microsoft', kind: 'system', refreshTokenEnc: encrypt('original-rt'), status: 'connected' },
  });
}

beforeEach(async () => {
  await resetDb();
  msalState.refreshTokensSeen = [];
  msalState.scopes = [];
  msalState.rotated = 'rotated-refresh-token';
  msalState.error = undefined;
});

afterEach(() => vi.unstubAllGlobals());

describe('graph client', () => {
  test('sends mail with the access token and stores a rotated refresh token encrypted', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const acc = await account();

    await createGraphClient(env).sendMail(acc, msg);

    expect(msalState.refreshTokensSeen).toEqual(['original-rt']);
    expect(msalState.scopes[0]).toEqual(GRAPH_SEND_SCOPES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/crm%40daitpartners.com/sendMail');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token-xyz');
    expect(JSON.parse(init.body as string)).toEqual({
      message: {
        subject: 'Hello',
        body: { contentType: 'HTML', content: '<p>Hi</p>' },
        toRecipients: [{ emailAddress: { address: 'a@example.com' } }],
        ccRecipients: [{ emailAddress: { address: 'b@example.com' } }],
      },
      saveToSentItems: true,
    });

    const stored = await prisma.emailAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect(stored.refreshTokenEnc).not.toContain('rotated-refresh-token');
    expect(decrypt(stored.refreshTokenEnc)).toBe('rotated-refresh-token');
    expect(stored.tokenExpiresAt).toBeInstanceOf(Date);
  });

  test('sends through the shared mailbox named in sendAs', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const acc = await prisma.emailAccount.update({ where: { id: (await account()).id }, data: { sendAs: 'hello@daitpartners.com' } });
    await createGraphClient(env).sendMail(acc, msg);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/users/hello%40daitpartners.com/sendMail');
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/hello%40daitpartners.com/sendMail');
    expect(msalState.scopes[0]).toContain('https://graph.microsoft.com/Mail.Send.Shared');
  });

  test('sends attachments as Graph file attachments (release 3A quotation PDF)', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const acc = await account();
    await createGraphClient(env).sendMail(acc, { ...msg, attachments: [{ name: 'Q-2026-001-rev1.pdf', contentType: 'application/pdf', contentBase64: 'JVBERi0=' }] });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).message.attachments).toEqual([
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'Q-2026-001-rev1.pdf', contentType: 'application/pdf', contentBytes: 'JVBERi0=' },
    ]);
  });

  test('template pictures go as inline file attachments (isInline + contentId), regular attachments as before', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const acc = await account();
    await createGraphClient(env).sendMail(acc, {
      ...msg,
      html: '<p>Hi</p><img src="cid:dait-logo.png">',
      attachments: [
        { name: 'dait-logo.png', contentType: 'image/png', contentBase64: 'iVBORw0=', isInline: true, contentId: 'dait-logo.png' },
        { name: 'Brochure.pdf', contentType: 'application/pdf', contentBase64: 'JVBERi0=' },
      ],
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string).message;
    expect(sent.body).toEqual({ contentType: 'HTML', content: '<p>Hi</p><img src="cid:dait-logo.png">' });
    expect(sent.attachments).toEqual([
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'dait-logo.png', contentType: 'image/png', contentBytes: 'iVBORw0=', isInline: true, contentId: 'dait-logo.png' },
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'Brochure.pdf', contentType: 'application/pdf', contentBytes: 'JVBERi0=' },
    ]);
  });

  test('leaves the stored token alone when MSAL does not rotate it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
    msalState.rotated = undefined;
    const acc = await account();
    await createGraphClient(env).sendMail(acc, msg);
    const stored = await prisma.emailAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect(stored.refreshTokenEnc).toBe(acc.refreshTokenEnc);
  });

  test('429 error carries status and Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'TooManyRequests' } }), {
      status: 429, headers: { 'Retry-After': '30' },
    })));
    const err = await createGraphClient(env).sendMail(await account(), msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).message).toBe('graph_send_failed status=429 retry-after=30 code=TooManyRequests');
    expect(isAuthFailure(err)).toBe(false);
  });

  test('401 is an auth failure and never echoes the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })));
    const err = (await createGraphClient(env).sendMail(await account(), msg).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('graph_send_failed status=401');
    expect(isAuthFailure(err)).toBe(true);
    expect(err.message).not.toContain('access-token-xyz');
  });

  test('invalid_grant from MSAL is an auth failure', async () => {
    msalState.error = Object.assign(new Error('AADSTS70000: invalid_grant'), { errorCode: 'invalid_grant' });
    const err = await createGraphClient(env).sendMail(await account(), msg).catch((e: unknown) => e);
    expect(isAuthFailure(err)).toBe(true);
  });

  test('a timed-out request is retryable and the fetch carries a timeout signal', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);
    const err = await createGraphClient(env).sendMail(await account(), msg).catch((e: unknown) => e);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(504);
    expect((err as GraphError).message).toBe('graph_send_failed timeout');
    expect(isAuthFailure(err)).toBe(false);
  });

  test('missing Microsoft settings fail the send clearly', async () => {
    const err = (await createGraphClient({}).sendMail(await account(), msg).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('microsoft_not_configured');
  });
});

describe('graph client — mail sync and actions (2B-2)', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const call = (m: ReturnType<typeof vi.fn>, i = 0) => m.mock.calls[i] as unknown as [string, RequestInit];
  const headers = (init: RequestInit) => init.headers as Record<string, string>;

  test('deltaStartUrl asks one folder for the messages since a date, with the fields sync stores', () => {
    const url = deltaStartUrl('inbox', new Date('2026-08-24T00:00:00.000Z'));
    expect(url.startsWith('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('$filter')).toBe('receivedDateTime ge 2026-08-24T00:00:00.000Z');
    expect(q.get('$select')!.split(',')).toEqual(expect.arrayContaining(['subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'isRead', 'conversationId', 'hasAttachments', 'body', 'isDraft']));
  });

  test('deltaPage maps messages, removals and links, with immutable ids, HTML bodies and pages of 50', async () => {
    const fetchMock = vi.fn(async () => json({
      value: [
        {
          id: 'g1', subject: 'Re: Proposal', from: { emailAddress: { name: 'Ana Ruiz', address: 'Ana@Acme.com' } },
          toRecipients: [{ emailAddress: { address: 'maya@daitpartners.com' } }], ccRecipients: [{ emailAddress: { address: 'cc@acme.com' } }],
          receivedDateTime: '2026-11-20T10:00:00Z', sentDateTime: '2026-11-20T09:59:00Z', isRead: false, isDraft: false,
          conversationId: 'conv-1', internetMessageId: '<m1@acme.com>', hasAttachments: true, body: { contentType: 'html', content: '<p>Hello</p>' },
        },
        { id: 'g2', '@removed': { reason: 'deleted' } },
      ],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const page = await createGraphClient(env).deltaPage(await account(), 'https://graph.microsoft.com/v1.0/x');
    expect(page).toEqual({
      messages: [{
        id: 'g1', subject: 'Re: Proposal', from: { name: 'Ana Ruiz', address: 'ana@acme.com' }, to: ['maya@daitpartners.com'], cc: ['cc@acme.com'], bcc: [],
        receivedAt: '2026-11-20T10:00:00Z', sentAt: '2026-11-20T09:59:00Z', isRead: false, isDraft: false, conversationId: 'conv-1',
        internetMessageId: '<m1@acme.com>', hasAttachments: true, body: { contentType: 'html', content: '<p>Hello</p>' },
        flag: { status: 'notFlagged', due: null },
      }],
      removed: ['g2'],
      nextLink: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc',
      deltaLink: undefined,
    });
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://graph.microsoft.com/v1.0/x');
    expect(headers(init).Prefer).toContain('IdType="ImmutableId"');
    expect(headers(init).Prefer).toContain('odata.maxpagesize=50');
    expect(headers(init).Prefer).toContain('outlook.body-content-type="html"');
    expect(msalState.scopes[0]).toEqual(GRAPH_MAIL_SCOPES);
  });

  test('deltaStartUrl asks for bccRecipients; deltaPage maps them lower-cased', async () => {
    const q = new URL(deltaStartUrl('deleteditems', new Date('2026-08-24T00:00:00.000Z'))).searchParams;
    expect(q.get('$select')!.split(',')).toContain('bccRecipients');
    vi.stubGlobal('fetch', vi.fn(async () => json({
      value: [{ id: 'g1', bccRecipients: [{ emailAddress: { address: ' Hidden@Acme.com ' } }] }, { id: 'g2' }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d',
    })));
    const page = await createGraphClient(env).deltaPage(await account(), 'https://graph.microsoft.com/v1.0/x');
    expect(page.messages[0]!.bcc).toEqual(['hidden@acme.com']);
    expect(page.messages[1]!.bcc).toEqual([]);
  });

  test('deltaPage keeps a plain-text body as text, and a missing body as empty text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      value: [{ id: 'g1', body: { contentType: 'text', content: 'Hi' } }, { id: 'g2' }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d',
    })));
    const page = await createGraphClient(env).deltaPage(await account(), 'https://graph.microsoft.com/v1.0/x');
    expect(page.messages.map((m) => m.body)).toEqual([{ contentType: 'text', content: 'Hi' }, { contentType: 'text', content: '' }]);
  });

  test('messageBody reads one message\'s HTML body from the account\'s own mailbox (immutable id, mail scopes)', async () => {
    const fetchMock = vi.fn(async () => json({ id: 'id/1', body: { contentType: 'html', content: '<p>Hi</p>' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await createGraphClient(env).messageBody(await account(), 'id/1')).toEqual({ contentType: 'html', content: '<p>Hi</p>' });
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1?$select=body');
    expect(init.method).toBe('GET');
    expect(headers(init).Prefer).toContain('IdType="ImmutableId"');
    expect(headers(init).Prefer).toContain('outlook.body-content-type="html"');
    expect(msalState.scopes[0]).toEqual(GRAPH_MAIL_SCOPES);
  });

  test('messageBody takes a shorter timeout when asked (the reader does not wait 20 s)', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    })));
    const started = Date.now();
    const err = await createGraphClient(env).messageBody(await account(), 'slow', { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(504);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('messageBody: a message gone from the mailbox is a GraphError with status 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'ErrorItemNotFound' } }, 404)));
    const err = await createGraphClient(env).messageBody(await account(), 'gone').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(404);
  });

  test('deltaPage refuses a link that is not Graph (never sends the token elsewhere)', async () => {
    const fetchMock = vi.fn(async () => json({ value: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await createGraphClient(env).deltaPage(await account(), 'https://evil.example/delta').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('calendarDeltaStartUrl asks the calendar view delta for a window, with no $select or $filter', () => {
    const url = new URL(calendarDeltaStartUrl(new Date('2026-10-23T00:00:00.000Z'), new Date('2027-05-21T00:00:00.000Z')));
    expect(`${url.origin}${url.pathname}`).toBe('https://graph.microsoft.com/v1.0/me/calendarView/delta');
    expect(url.searchParams.get('startDateTime')).toBe('2026-10-23T00:00:00.000Z');
    expect(url.searchParams.get('endDateTime')).toBe('2027-05-21T00:00:00.000Z');
    expect([...url.searchParams.keys()].sort()).toEqual(['endDateTime', 'startDateTime']);
  });

  test('calendarDeltaPage maps events (UTC times, lower-cased addresses), cancellations, removals and links', async () => {
    const fetchMock = vi.fn(async () => json({
      value: [
        {
          id: 'ev1', subject: 'Discovery call', isAllDay: false, isCancelled: false, isOnlineMeeting: true,
          start: { dateTime: '2026-11-25T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-25T10:30:00.0000000', timeZone: 'UTC' },
          location: { displayName: 'Microsoft Teams Meeting' }, organizer: { emailAddress: { name: 'Ana Ruiz', address: 'Ana@Acme.com' } },
          attendees: [{ type: 'required', emailAddress: { name: 'Maya', address: 'Maya@DaitPartners.com' } }, { type: 'optional', emailAddress: { name: 'x' } }],
        },
        { id: 'ev2', subject: null, isAllDay: true, isCancelled: true, start: { dateTime: '2026-11-27T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-28T00:00:00.0000000', timeZone: 'UTC' }, location: { displayName: '' } },
        { id: 'ev3', '@removed': { reason: 'deleted' } },
      ],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=abc',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const page = await createGraphClient(env).calendarDeltaPage(await account(), 'https://graph.microsoft.com/v1.0/x');
    expect(page).toEqual({
      events: [
        {
          id: 'ev1', subject: 'Discovery call', startsAt: '2026-11-25T10:00:00.000Z', endsAt: '2026-11-25T10:30:00.000Z', isAllDay: false, isCancelled: false,
          location: 'Microsoft Teams Meeting', organizer: { name: 'Ana Ruiz', address: 'ana@acme.com' }, attendees: ['maya@daitpartners.com'], isOnline: true,
        },
        {
          id: 'ev2', subject: '', startsAt: '2026-11-27T00:00:00.000Z', endsAt: '2026-11-28T00:00:00.000Z', isAllDay: true, isCancelled: true,
          location: null, organizer: null, attendees: [], isOnline: false,
        },
      ],
      removed: ['ev3'],
      nextLink: undefined,
      deltaLink: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=abc',
    });
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://graph.microsoft.com/v1.0/x');
    expect(headers(init).Prefer).toContain('IdType="ImmutableId"');
    expect(headers(init).Prefer).toContain('odata.maxpagesize=50');
    expect(headers(init).Prefer).toContain('outlook.timezone="UTC"');
    expect(msalState.scopes[0]).toEqual(GRAPH_CALENDAR_SCOPES);
  });

  test('calendarDeltaPage keeps an all-day event\'s UTC times as sent (the sync places them on the owner\'s dates)', async () => {
    const at = (dateTime: string) => ({ dateTime, timeZone: 'UTC' });
    vi.stubGlobal('fetch', vi.fn(async () => json({
      value: [
        { id: 'east', subject: 'Holi', isAllDay: true, start: at('2030-03-09T18:30:00.0000000'), end: at('2030-03-10T18:30:00.0000000') },
        { id: 'west', subject: 'Offsite', isAllDay: true, start: at('2030-03-20T05:00:00.0000000'), end: at('2030-03-22T05:00:00.0000000') },
        { id: 'timed', subject: 'Late', isAllDay: false, start: at('2030-03-09T18:30:00.0000000'), end: at('2030-03-09T19:00:00.0000000') },
      ],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=abc',
    })));
    const page = await createGraphClient(env).calendarDeltaPage(await account(), 'https://graph.microsoft.com/v1.0/x');
    expect(page.events.map((e) => [e.id, e.startsAt, e.endsAt])).toEqual([
      ['east', '2030-03-09T18:30:00.000Z', '2030-03-10T18:30:00.000Z'],
      ['west', '2030-03-20T05:00:00.000Z', '2030-03-22T05:00:00.000Z'],
      ['timed', '2030-03-09T18:30:00.000Z', '2030-03-09T19:00:00.000Z'],
    ]);
  });

  test('calendarDeltaPage skips (and counts) an event whose times are not in UTC; a lower-case or missing zone is UTC', async () => {
    const at = (dateTime: string, timeZone?: string) => (timeZone ? { dateTime, timeZone } : { dateTime });
    vi.stubGlobal('fetch', vi.fn(async () => json({
      value: [
        { id: 'pst', subject: 'Wrong zone', start: at('2026-11-25T10:00:00.0000000', 'Pacific Standard Time'), end: at('2026-11-25T11:00:00.0000000', 'Pacific Standard Time') },
        { id: 'lower', subject: 'utc', start: at('2026-11-25T10:00:00.0000000', 'utc'), end: at('2026-11-25T11:00:00.0000000', 'utc') },
        { id: 'none', subject: 'no zone', start: at('2026-11-25T12:00:00.0000000'), end: at('2026-11-25T13:00:00.0000000') },
      ],
    })));
    const page = await createGraphClient(env).calendarDeltaPage(await account(), 'https://graph.microsoft.com/v1.0/x');
    expect(page.events.map((e) => [e.id, e.startsAt])).toEqual([['lower', '2026-11-25T10:00:00.000Z'], ['none', '2026-11-25T12:00:00.000Z']]);
    expect(page.skipped).toBe(1);
  });

  test('calendarDeltaPage takes the other names Graph or Windows use for UTC as UTC (any case)', async () => {
    const zones = ['Etc/UTC', 'etc/gmt', 'GMT', 'Coordinated Universal Time', 'tzone://Microsoft/Utc', 'TZONE://MICROSOFT/UTC'];
    vi.stubGlobal('fetch', vi.fn(async () => json({
      value: zones.map((timeZone, i) => ({
        id: `z${i}`, subject: timeZone,
        start: { dateTime: '2026-11-25T10:00:00.0000000', timeZone }, end: { dateTime: '2026-11-25T11:00:00.0000000', timeZone },
      })),
    })));
    const page = await createGraphClient(env).calendarDeltaPage(await account(), 'https://graph.microsoft.com/v1.0/x');
    expect(page.events.map((e) => e.startsAt)).toEqual(zones.map(() => '2026-11-25T10:00:00.000Z'));
    expect(page.skipped ?? 0).toBe(0);
  });

  test('calendarDeltaPage refuses a link that is not Graph', async () => {
    const fetchMock = vi.fn(async () => json({ value: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await createGraphClient(env).calendarDeltaPage(await account(), 'https://evil.example/delta').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('an expired delta link is a GraphError with status 410', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'SyncStateNotFound' } }, 410)));
    const err = await createGraphClient(env).deltaPage(await account(), 'https://graph.microsoft.com/v1.0/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(410);
    expect((err as GraphError).message).toBe('graph_request_failed status=410 code=SyncStateNotFound');
  });

  test('markRead, moveTo and reply call the message endpoints', async () => {
    const fetchMock = vi.fn(async (url: string) => json({}, url.endsWith('/reply') ? 202 : 200));
    vi.stubGlobal('fetch', fetchMock);
    const g = createGraphClient(env);
    const acc = await account();
    await g.markRead(acc, 'id/1', true);
    await g.moveTo(acc, 'id/1', 'archive');
    await g.reply(acc, 'id/1', { to: ['ana@acme.com'], cc: ['cc@acme.com'], html: '<div>Thanks</div>' });

    expect(call(fetchMock, 0)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1');
    expect(call(fetchMock, 0)[1].method).toBe('PATCH');
    expect(JSON.parse(call(fetchMock, 0)[1].body as string)).toEqual({ isRead: true });
    expect(call(fetchMock, 1)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1/move');
    expect(JSON.parse(call(fetchMock, 1)[1].body as string)).toEqual({ destinationId: 'archive' });
    expect(call(fetchMock, 2)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1/reply');
    expect(JSON.parse(call(fetchMock, 2)[1].body as string)).toEqual({
      comment: '<div>Thanks</div>',
      message: { toRecipients: [{ emailAddress: { address: 'ana@acme.com' } }], ccRecipients: [{ emailAddress: { address: 'cc@acme.com' } }] },
    });
    for (let i = 0; i < 3; i++) expect(headers(call(fetchMock, i)[1]).Prefer).toContain('IdType="ImmutableId"');
  });
});

describe('graph client — flags, moves, delete, attachments, reply all, forward (web-mail release 2)', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const call = (m: ReturnType<typeof vi.fn>, i = 0) => m.mock.calls[i] as unknown as [string, RequestInit];
  const headers = (init: RequestInit) => init.headers as Record<string, string>;
  const sentBody = (m: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(call(m, i)[1].body as string) as unknown;

  test('deltaStartUrl and searchStartUrl ask for flag', () => {
    expect(new URL(deltaStartUrl('inbox', new Date('2026-08-24T00:00:00Z'))).searchParams.get('$select')!.split(',')).toContain('flag');
    expect(new URL(searchStartUrl('a@acme.com', new Date('2026-08-24T00:00:00Z'))).searchParams.get('$select')!.split(',')).toContain('flag');
  });

  test('deltaPage maps flag status and keeps the due date and zone as Graph sent them (the sync converts to the user\'s day)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      value: [
        { id: 'g1', flag: { flagStatus: 'flagged', dueDateTime: { dateTime: '2026-11-27T00:00:00.0000000', timeZone: 'UTC' } } },
        { id: 'g2', flag: { flagStatus: 'complete' } },
        { id: 'g3', flag: { flagStatus: 'notFlagged' } },
        { id: 'g4' },
        { id: 'g5', flag: { flagStatus: 'somethingNew', dueDateTime: { dateTime: 7 } } },
        { id: 'g6', flag: { flagStatus: 'flagged', dueDateTime: { dateTime: '2026-11-26T18:30:00.0000000' } } },
      ],
    })));
    const page = await createGraphClient(env).deltaPage(await account(), 'https://graph.microsoft.com/v1.0/x');
    expect(page.messages.map((m) => m.flag)).toEqual([
      { status: 'flagged', due: { dateTime: '2026-11-27T00:00:00.0000000', timeZone: 'UTC' } },
      { status: 'complete', due: null },
      { status: 'notFlagged', due: null },
      { status: 'notFlagged', due: null },
      { status: 'notFlagged', due: null },
      { status: 'flagged', due: { dateTime: '2026-11-26T18:30:00.0000000', timeZone: 'UTC' } },
    ]);
  });

  test('setFlag sends flagStatus with start and due in the given zone; noDate sends neither; complete and clear only the status', async () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    const g = createGraphClient(env);
    const acc = await account();
    await g.setFlag(acc, 'id/1', { status: 'flagged', start: '2026-11-26', due: '2026-11-27', timeZone: 'Asia/Kolkata' });
    await g.setFlag(acc, 'id/1', { status: 'flagged', start: null, due: null, timeZone: 'Asia/Kolkata' });
    await g.setFlag(acc, 'id/1', { status: 'complete' });
    await g.setFlag(acc, 'id/1', { status: 'notFlagged' });
    // Graph needs both dates or neither: one alone is sent as both.
    await g.setFlag(acc, 'id/1', { status: 'flagged', start: null, due: '2026-11-30', timeZone: 'Europe/London' });

    for (let i = 0; i < 5; i++) {
      expect(call(fetchMock, i)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1');
      expect(call(fetchMock, i)[1].method).toBe('PATCH');
      expect(headers(call(fetchMock, i)[1]).Prefer).toContain('IdType="ImmutableId"');
    }
    expect(sentBody(fetchMock, 0)).toEqual({ flag: { flagStatus: 'flagged', startDateTime: { dateTime: '2026-11-26T00:00:00', timeZone: 'Asia/Kolkata' }, dueDateTime: { dateTime: '2026-11-27T00:00:00', timeZone: 'Asia/Kolkata' } } });
    expect(sentBody(fetchMock, 1)).toEqual({ flag: { flagStatus: 'flagged' } });
    expect(sentBody(fetchMock, 2)).toEqual({ flag: { flagStatus: 'complete' } });
    expect(sentBody(fetchMock, 3)).toEqual({ flag: { flagStatus: 'notFlagged' } });
    expect(sentBody(fetchMock, 4)).toEqual({ flag: { flagStatus: 'flagged', startDateTime: { dateTime: '2026-11-30T00:00:00', timeZone: 'Europe/London' }, dueDateTime: { dateTime: '2026-11-30T00:00:00', timeZone: 'Europe/London' } } });
  });

  test('moveTo deleteditems posts destinationId deleteditems with immutable ids', async () => {
    const fetchMock = vi.fn(async () => json({ id: 'id/1' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await createGraphClient(env).moveTo(await account(), 'id/1', 'deleteditems');
    expect(call(fetchMock)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1/move');
    expect(call(fetchMock)[1].method).toBe('POST');
    expect(sentBody(fetchMock)).toEqual({ destinationId: 'deleteditems' });
    expect(headers(call(fetchMock)[1]).Prefer).toContain('IdType="ImmutableId"');
    expect(msalState.scopes[0]).toEqual(GRAPH_MAIL_SCOPES);
  });

  test('deleteMessage sends DELETE on the message', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await createGraphClient(env).deleteMessage(await account(), 'id/1');
    expect(call(fetchMock)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1');
    expect(call(fetchMock)[1].method).toBe('DELETE');
    expect(call(fetchMock)[1].body).toBeUndefined();
    expect(headers(call(fetchMock)[1]).Prefer).toContain('IdType="ImmutableId"');
  });

  test('deleteMessage: a message already gone is a GraphError with status 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'ErrorItemNotFound' } }, 404)));
    const err = await createGraphClient(env).deleteMessage(await account(), 'id/1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(404);
  });

  test('listAttachments maps id, name, type, size, inline and kind', async () => {
    const fetchMock = vi.fn(async () => json({ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'AAMk=', name: 'RFP.pdf', contentType: 'application/pdf', size: 2400000, isInline: false }] }));
    vi.stubGlobal('fetch', fetchMock);
    const list = await createGraphClient(env).listAttachments(await account(), 'id/1');
    expect(list).toEqual([{ id: 'AAMk=', name: 'RFP.pdf', contentType: 'application/pdf', size: 2400000, isInline: false, kind: 'file' }]);
    expect(call(fetchMock)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1/attachments?$select=id,name,contentType,size,isInline');
    expect(call(fetchMock)[1].method).toBe('GET');
    expect(headers(call(fetchMock)[1]).Prefer).toContain('IdType="ImmutableId"');
  });

  test('listAttachments: item and reference kinds, inline pictures, and defaults for missing fields; entries without an id are left out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      value: [
        { '@odata.type': '#microsoft.graph.itemAttachment', id: 'I1', name: 'Fwd: Meeting', contentType: null, size: 5000, isInline: false },
        { '@odata.type': '#microsoft.graph.referenceAttachment', id: 'R1', name: 'Plan.docx', size: 0 },
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'F1', name: 'logo.png', contentType: 'image/png', size: 1200, isInline: true },
        { id: 'X1' },
        { name: 'no-id.pdf' },
      ],
    })));
    expect(await createGraphClient(env).listAttachments(await account(), 'id/1')).toEqual([
      { id: 'I1', name: 'Fwd: Meeting', contentType: 'application/octet-stream', size: 5000, isInline: false, kind: 'item' },
      { id: 'R1', name: 'Plan.docx', contentType: 'application/octet-stream', size: 0, isInline: false, kind: 'reference' },
      { id: 'F1', name: 'logo.png', contentType: 'image/png', size: 1200, isInline: true, kind: 'file' },
      { id: 'X1', name: '', contentType: 'application/octet-stream', size: 0, isInline: false, kind: 'file' },
    ]);
  });

  test('attachmentContent reads the bytes of one attachment, its base64 id encoded in the path', async () => {
    const bytes = Buffer.from('%PDF-1.4 hello %%EOF');
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200, headers: { 'Content-Length': String(bytes.length) } }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await createGraphClient(env).attachmentContent(await account(), 'id/1', 'AAMk+a/b==', 1000);
    expect(out.equals(bytes)).toBe(true);
    expect(call(fetchMock)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1/attachments/AAMk%2Ba%2Fb%3D%3D/$value');
    expect(call(fetchMock)[1].method).toBe('GET');
    expect(headers(call(fetchMock)[1]).Prefer).toContain('IdType="ImmutableId"');
  });

  test('attachmentContent refuses a file over the cap with 413 before reading it all', async () => {
    // Content-Length over the cap: refused without reading the body.
    let pulled = 0;
    const endless = () => new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(400));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(endless(), { status: 200, headers: { 'Content-Length': '5000' } })));
    const g = createGraphClient(env);
    const acc = await account();
    const err = await g.attachmentContent(acc, 'id/1', 'A1', 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(413);
    expect((err as GraphError).message).toBe('attachment_too_large');
    expect(pulled).toBeLessThanOrEqual(1);

    // No Content-Length: reading stops as soon as the cap is passed.
    pulled = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(endless(), { status: 200 })));
    const err2 = await g.attachmentContent(acc, 'id/1', 'A1', 1000).catch((e: unknown) => e);
    expect((err2 as GraphError).status).toBe(413);
    expect((err2 as GraphError).message).toBe('attachment_too_large');
    expect(pulled).toBeLessThan(6);

    // Exactly the cap is allowed.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(1000), { status: 200 })));
    expect((await g.attachmentContent(acc, 'id/1', 'A1', 1000)).length).toBe(1000);
  });

  test('attachmentContent: a download that stalls past the request timeout is a retryable GraphError 504', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stalled, { status: 200 })));
    const err = await createGraphClient(env).attachmentContent(await account(), 'id/1', 'A1', 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(504);
  });

  test('replyAll and forward post comment and recipients to /replyAll and /forward', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const g = createGraphClient(env);
    const acc = await account();
    await g.replyAll(acc, 'id/1', { to: ['ana@acme.com', 'bo@acme.com'], cc: ['cc@acme.com'], html: '<div>All</div>' });
    await g.forward(acc, 'id/1', { to: ['new@acme.com'], cc: ['cc@acme.com'], html: '<div>FYI</div>' });
    await g.forward(acc, 'id/1', { to: ['new@acme.com'], html: '<div>FYI</div>' });

    expect(call(fetchMock, 0)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1/replyAll');
    expect(sentBody(fetchMock, 0)).toEqual({
      comment: '<div>All</div>',
      message: {
        toRecipients: [{ emailAddress: { address: 'ana@acme.com' } }, { emailAddress: { address: 'bo@acme.com' } }],
        ccRecipients: [{ emailAddress: { address: 'cc@acme.com' } }],
      },
    });
    // Graph's forward takes toRecipients at the top level; Cc goes in message (there is no top-level ccRecipients).
    expect(call(fetchMock, 1)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1/forward');
    expect(sentBody(fetchMock, 1)).toEqual({
      comment: '<div>FYI</div>',
      toRecipients: [{ emailAddress: { address: 'new@acme.com' } }],
      message: { ccRecipients: [{ emailAddress: { address: 'cc@acme.com' } }] },
    });
    expect(sentBody(fetchMock, 2)).toEqual({
      comment: '<div>FYI</div>',
      toRecipients: [{ emailAddress: { address: 'new@acme.com' } }],
      message: { ccRecipients: [] },
    });
    for (let i = 0; i < 3; i++) {
      expect(call(fetchMock, i)[1].method).toBe('POST');
      expect(headers(call(fetchMock, i)[1]).Prefer).toContain('IdType="ImmutableId"');
    }
  });
});

describe('graph client — drafts, draft attachments, sending a draft (web-mail release 3)', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const call = (m: ReturnType<typeof vi.fn>, i = 0) => m.mock.calls[i] as unknown as [string, RequestInit];
  const headers = (init: RequestInit) => init.headers as Record<string, string>;
  const sentBody = (m: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(call(m, i)[1].body as string) as unknown;
  const draftAnswer = (extra: Record<string, unknown> = {}) => ({
    id: 'AAMkD=', conversationId: 'CONV1', subject: 'Proposal', isDraft: true, lastModifiedDateTime: '2026-11-27T10:00:00Z',
    body: { contentType: 'html', content: '<p>Hi</p>' },
    toRecipients: [{ emailAddress: { address: 'Ana@Acme.com', name: 'Ana' } }], ccRecipients: [],
    bccRecipients: [{ emailAddress: { address: 'b@acme.com' } }],
    ...extra,
  });
  const fields = { subject: 'Proposal', html: '<p>Hi</p>', to: ['ana@acme.com'], cc: [], bcc: ['b@acme.com'] };

  test('createDraft posts subject, HTML body and To/Cc/Bcc with immutable ids, and maps the answer', async () => {
    const fetchMock = vi.fn(async () => json(draftAnswer(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const draft = await createGraphClient(env).createDraft(await account(), fields);
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages');
    expect(init.method).toBe('POST');
    expect(headers(init).Prefer).toContain('IdType="ImmutableId"');
    expect(headers(init).Prefer).toContain('outlook.body-content-type="html"');
    expect(msalState.scopes[0]).toEqual(GRAPH_MAIL_SCOPES);
    expect(sentBody(fetchMock)).toEqual({
      subject: 'Proposal', body: { contentType: 'HTML', content: '<p>Hi</p>' },
      toRecipients: [{ emailAddress: { address: 'ana@acme.com' } }], ccRecipients: [], bccRecipients: [{ emailAddress: { address: 'b@acme.com' } }],
    });
    expect(draft).toEqual({
      id: 'AAMkD=', conversationId: 'CONV1', subject: 'Proposal', html: '<p>Hi</p>', to: ['ana@acme.com'], cc: [], bcc: ['b@acme.com'],
      lastModified: '2026-11-27T10:00:00Z', attachments: [],
    });
  });

  test('createDraft sends from only when a send-as address is given', async () => {
    const fetchMock = vi.fn(async () => json(draftAnswer(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const g = createGraphClient(env);
    const acc = await account();
    await g.createDraft(acc, { ...fields, from: 'sales@daitpartners.com' });
    await g.createDraft(acc, { ...fields, from: null });
    expect((sentBody(fetchMock, 0) as Record<string, unknown>).from).toEqual({ emailAddress: { address: 'sales@daitpartners.com' } });
    expect(sentBody(fetchMock, 1)).not.toHaveProperty('from');
  });

  test('createReplyDraft calls createReply / createReplyAll / createForward on the original', async () => {
    const fetchMock = vi.fn(async () => json(draftAnswer({ id: 'R1', subject: 'RE: Proposal', body: { contentType: 'html', content: '<div id="divRplyFwdMsg">quote</div>' } }), 201));
    vi.stubGlobal('fetch', fetchMock);
    const g = createGraphClient(env);
    const acc = await account();
    const reply = await g.createReplyDraft(acc, 'id/1', 'reply');
    await g.createReplyDraft(acc, 'id/1', 'replyAll');
    await g.createReplyDraft(acc, 'id/1', 'forward');
    expect([0, 1, 2].map((i) => call(fetchMock, i)[0])).toEqual([
      'https://graph.microsoft.com/v1.0/me/messages/id%2F1/createReply',
      'https://graph.microsoft.com/v1.0/me/messages/id%2F1/createReplyAll',
      'https://graph.microsoft.com/v1.0/me/messages/id%2F1/createForward',
    ]);
    for (let i = 0; i < 3; i++) {
      expect(call(fetchMock, i)[1].method).toBe('POST');
      expect(sentBody(fetchMock, i)).toEqual({});
      expect(headers(call(fetchMock, i)[1]).Prefer).toContain('IdType="ImmutableId"');
      expect(headers(call(fetchMock, i)[1]).Prefer).toContain('outlook.body-content-type="html"');
    }
    expect(reply).toMatchObject({ id: 'R1', conversationId: 'CONV1', subject: 'RE: Proposal', html: '<div id="divRplyFwdMsg">quote</div>' });
  });

  test('getDraft reads the draft with its attachments and their content-ids', async () => {
    const fetchMock = vi.fn(async () => json(draftAnswer({
      attachments: [
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'A+1=', name: 'logo.png', contentType: 'image/png', size: 1200, isInline: true, contentId: ' image001.png@01DB ' },
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'A+2=', name: 'a.pdf', contentType: 'application/pdf', size: 10, isInline: false, contentId: null },
      ],
    })));
    vi.stubGlobal('fetch', fetchMock);
    const draft = await createGraphClient(env).getDraft(await account(), 'AAMkD=');
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages/AAMkD%3D?$select=subject,body,toRecipients,ccRecipients,bccRecipients,conversationId,lastModifiedDateTime,isDraft&$expand=attachments($select=id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId)');
    expect(init.method).toBe('GET');
    expect(headers(init).Prefer).toContain('IdType="ImmutableId"');
    expect(headers(init).Prefer).toContain('outlook.body-content-type="html"');
    expect(draft.attachments).toEqual([
      { id: 'A+1=', name: 'logo.png', contentType: 'image/png', size: 1200, isInline: true, contentId: 'image001.png@01DB', kind: 'file' },
      { id: 'A+2=', name: 'a.pdf', contentType: 'application/pdf', size: 10, isInline: false, kind: 'file' },
    ]);
    expect(draft.to).toEqual(['ana@acme.com']);
  });

  test('getDraft refuses a message that is no longer a draft with 409 not_a_draft', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(draftAnswer({ isDraft: false }))));
    const err = await createGraphClient(env).getDraft(await account(), 'AAMkD=').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(409);
    expect((err as GraphError).message).toBe('not_a_draft');
  });

  test('getDraft: Graph refusing the contentId type-cast select (400) is read again without it, then never asked again; logged once', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('fileAttachment/contentId')) return json({ error: { code: 'BadRequest', message: 'Could not find a property' } }, 400);
      return json(draftAnswer({ attachments: [{ id: 'A1', name: 'p.png', contentType: 'image/png', size: 5, isInline: true }] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const g = createGraphClient(env);
      const acc = await account();
      const first = await g.getDraft(acc, 'D=');
      await g.getDraft(acc, 'D=');
      expect(first.attachments).toEqual([{ id: 'A1', name: 'p.png', contentType: 'image/png', size: 5, isInline: true, kind: 'file' }]);
      const plain = 'https://graph.microsoft.com/v1.0/me/messages/D%3D?$select=subject,body,toRecipients,ccRecipients,bccRecipients,conversationId,lastModifiedDateTime,isDraft&$expand=attachments($select=id,name,contentType,size,isInline)';
      expect(urls).toEqual([`${plain.slice(0, -1)},microsoft.graph.fileAttachment/contentId)`, plain, plain]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).not.toContain('D=');
    } finally {
      warn.mockRestore();
    }
  });

  test('getDraft: a 400 that the read without the contentId select also gets does not turn the select off', async () => {
    const urls: string[] = [];
    let failPlain = true;
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('fileAttachment/contentId') || failPlain) return json({ error: { code: 'BadRequest', message: 'Bad id' } }, 400);
      return json(draftAnswer());
    });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const g = createGraphClient(env);
      const acc = await account();
      const err = await g.getDraft(acc, 'D=').catch((e: unknown) => e);
      expect((err as GraphError).status).toBe(400);
      expect(warn).not.toHaveBeenCalled();
      // The next read still asks for the content-ids first (nothing was latched off).
      failPlain = false;
      urls.length = 0;
      await g.getDraft(acc, 'D=').catch(() => undefined);
      expect(urls[0]).toContain('fileAttachment/contentId');
    } finally {
      warn.mockRestore();
    }
  });

  test('getDraft: a refusal other than 400 is not read again without the contentId select', async () => {
    const fetchMock = vi.fn(async (_url: string) => json({ error: { code: 'x' } }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const err = await createGraphClient(env).getDraft(await account(), 'D=').catch((e: unknown) => e);
    expect((err as GraphError).status).toBe(503);
    expect(fetchMock.mock.calls.every(([url]) => url.includes('fileAttachment/contentId'))).toBe(true);
  });

  test('getDraft: a draft gone from the mailbox is a GraphError with status 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'ErrorItemNotFound' } }, 404)));
    const err = await createGraphClient(env).getDraft(await account(), 'AAMkD=').catch((e: unknown) => e);
    expect((err as GraphError).status).toBe(404);
  });

  test('updateDraft PATCHes the fields; addAttachment posts a fileAttachment (inline with contentId); removeAttachment DELETEs it', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'PATCH') return json(draftAnswer());
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ id: 'ATT=1' }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    const g = createGraphClient(env);
    const acc = await account();
    await expect(g.updateDraft(acc, 'd/1', { ...fields, cc: ['c@acme.com'], from: 'sales@daitpartners.com' })).resolves.toBeUndefined();
    expect(call(fetchMock, 0)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/d%2F1');
    expect(call(fetchMock, 0)[1].method).toBe('PATCH');
    expect(sentBody(fetchMock, 0)).toEqual({
      subject: 'Proposal', body: { contentType: 'HTML', content: '<p>Hi</p>' },
      toRecipients: [{ emailAddress: { address: 'ana@acme.com' } }], ccRecipients: [{ emailAddress: { address: 'c@acme.com' } }],
      bccRecipients: [{ emailAddress: { address: 'b@acme.com' } }], from: { emailAddress: { address: 'sales@daitpartners.com' } },
    });

    expect(await g.addAttachment(acc, 'd/1', { name: 'RFP.pdf', contentType: 'application/pdf', contentBase64: 'JVBERg==' })).toEqual({ id: 'ATT=1' });
    expect(call(fetchMock, 1)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/d%2F1/attachments');
    expect(call(fetchMock, 1)[1].method).toBe('POST');
    expect(sentBody(fetchMock, 1)).toEqual({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'RFP.pdf', contentType: 'application/pdf', contentBytes: 'JVBERg==' });
    await g.addAttachment(acc, 'd/1', { name: 'logo.png', contentType: 'image/png', contentBase64: 'iVBO', isInline: true, contentId: 'img-1@dait' });
    expect(sentBody(fetchMock, 2)).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment', name: 'logo.png', contentType: 'image/png', contentBytes: 'iVBO', isInline: true, contentId: 'img-1@dait',
    });

    await expect(g.removeAttachment(acc, 'd/1', 'AAMk+a/b==')).resolves.toBeUndefined();
    expect(call(fetchMock, 3)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/d%2F1/attachments/AAMk%2Ba%2Fb%3D%3D');
    expect(call(fetchMock, 3)[1].method).toBe('DELETE');
    for (let i = 0; i < 4; i++) expect(headers(call(fetchMock, i)[1]).Prefer).toContain('IdType="ImmutableId"');
    expect(msalState.scopes.every((s) => s === GRAPH_MAIL_SCOPES)).toBe(true);
  });

  test('addAttachment: an answer without an id is a GraphError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 201)));
    const err = await createGraphClient(env).addAttachment(await account(), 'd/1', { name: 'a.pdf', contentType: 'application/pdf', contentBase64: 'JVBERg==' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
  });

  test('sendDraft posts /send with the send timeout', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await expect(createGraphClient(env).sendDraft(await account(), 'd/1')).resolves.toBeUndefined();
      expect(call(fetchMock)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/d%2F1/send');
      expect(call(fetchMock)[1].method).toBe('POST');
      expect(call(fetchMock)[1].body).toBeUndefined();
      expect(headers(call(fetchMock)[1]).Prefer).toContain('IdType="ImmutableId"');
      expect(timeout).toHaveBeenCalledWith(SEND_TIMEOUT_MS);
      expect(msalState.scopes[0]).toEqual(GRAPH_MAIL_SCOPES);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('graph client — access token reuse (2B-2 review)', () => {
  test('one sign-in per mailbox while the token is valid; a reconnected mailbox signs in again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: [] }), { status: 200 })));
    const g = createGraphClient(env);
    const acc = await account();
    await g.deltaPage(acc, 'https://graph.microsoft.com/v1.0/a');
    await g.deltaPage(acc, 'https://graph.microsoft.com/v1.0/b');
    await g.markRead(acc, 'x', true);
    expect(msalState.refreshTokensSeen).toHaveLength(1);
    await g.deltaPage({ ...acc, refreshTokenEnc: encrypt('reconnected-rt') }, 'https://graph.microsoft.com/v1.0/c');
    expect(msalState.refreshTokensSeen).toEqual(['original-rt', 'reconnected-rt']);
  });
});

describe('graph client — search by address and folder ids (web-mail release 1)', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const call = (m: ReturnType<typeof vi.fn>, i = 0) => m.mock.calls[i] as unknown as [string, RequestInit];
  const headers = (init: RequestInit) => init.headers as Record<string, string>;

  test('searchStartUrl searches the whole mailbox for the address since a date, with the sync fields and parentFolderId', () => {
    const url = searchStartUrl('Ana@acme.com"', new Date('2025-11-26T00:00:00Z'));
    expect(url.startsWith('https://graph.microsoft.com/v1.0/me/messages?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('$search')).toBe('"participants:ana@acme.com AND received>=2025-11-26"');
    expect(q.get('$select')!.split(',')).toEqual(expect.arrayContaining(['bccRecipients', 'parentFolderId', 'body']));
    expect(q.get('$top')).toBe('50');
  });

  test('searchStartUrl removes backslashes from the address too', () => {
    const q = new URL(searchStartUrl('a\\b@acme.com', new Date('2025-11-26T12:00:00Z'))).searchParams;
    expect(q.get('$search')).toBe('"participants:ab@acme.com AND received>=2025-11-26"');
  });

  test('searchPage maps messages with their folder id and the next link, immutable ids and HTML bodies', async () => {
    const fetchMock = vi.fn(async () => json({
      value: [
        {
          id: 'g1', parentFolderId: 'folder-inbox', subject: 'Proposal', from: { emailAddress: { name: 'Ana Ruiz', address: 'Ana@Acme.com' } },
          toRecipients: [{ emailAddress: { address: 'maya@daitpartners.com' } }], bccRecipients: [{ emailAddress: { address: 'Hidden@Acme.com' } }],
          receivedDateTime: '2026-01-20T10:00:00Z', isRead: true, body: { contentType: 'html', content: '<p>Hello</p>' },
        },
        { id: 'g2', parentFolderId: 'folder-sent', body: { contentType: 'text', content: 'Hi' } },
      ],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const page = await createGraphClient(env).searchPage(await account(), 'https://graph.microsoft.com/v1.0/me/messages?x');
    expect(page.nextLink).toBe('https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc');
    expect(page.items.map((i) => i.folderId)).toEqual(['folder-inbox', 'folder-sent']);
    expect(page.items[0]!.message).toMatchObject({
      id: 'g1', subject: 'Proposal', from: { name: 'Ana Ruiz', address: 'ana@acme.com' }, to: ['maya@daitpartners.com'], bcc: ['hidden@acme.com'],
      body: { contentType: 'html', content: '<p>Hello</p>' },
    });
    expect(page.items[1]!.message.body).toEqual({ contentType: 'text', content: 'Hi' });
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages?x');
    expect(init.method).toBe('GET');
    expect(headers(init).Prefer).toContain('IdType="ImmutableId"');
    expect(headers(init).Prefer).toContain('outlook.body-content-type="html"');
    expect(msalState.scopes[0]).toEqual(GRAPH_MAIL_SCOPES);
  });

  test('searchPage: the last page has no next link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ value: [] })));
    expect(await createGraphClient(env).searchPage(await account(), 'https://graph.microsoft.com/v1.0/me/messages?x')).toEqual({ items: [], nextLink: undefined });
  });

  test('searchPage refuses a link that is not Graph', async () => {
    const fetchMock = vi.fn(async () => json({ value: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await createGraphClient(env).searchPage(await account(), 'https://evil.example/me/messages').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('not_a_graph_link');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('folderIds reads the five well-known folders', async () => {
    const fetchMock = vi.fn(async (url: string) => json({ id: `id-${new URL(url).pathname.split('/').pop()}` }));
    vi.stubGlobal('fetch', fetchMock);
    const ids = await createGraphClient(env).folderIds(await account());
    expect(Object.keys(ids).sort()).toEqual(['archive', 'deleteditems', 'drafts', 'inbox', 'sentitems']);
    expect(ids.inbox).toBe('id-inbox');
    expect(ids.deleteditems).toBe('id-deleteditems');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const urls = fetchMock.mock.calls.map((c) => (c as unknown as [string])[0]).sort();
    expect(urls).toContain('https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id');
    for (let i = 0; i < 5; i++) {
      expect(headers(call(fetchMock, i)[1]).Prefer).toContain('IdType="ImmutableId"');
      expect(headers(call(fetchMock, i)[1]).Prefer).toContain('outlook.body-content-type="html"');
    }
    expect(msalState.scopes[0]).toEqual(GRAPH_MAIL_SCOPES);
    expect(msalState.refreshTokensSeen).toHaveLength(1);
  });

  test('folderIds skips a folder the mailbox does not have (Archive 404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const name = new URL(url).pathname.split('/').pop();
      return name === 'archive' ? json({ error: { code: 'ErrorFolderNotFound' } }, 404) : json({ id: `id-${name}` });
    }));
    const ids = await createGraphClient(env).folderIds(await account());
    expect(Object.keys(ids).sort()).toEqual(['deleteditems', 'drafts', 'inbox', 'sentitems']);
    expect(ids.archive).toBeUndefined();
  });

  test('folderIds fails on any other error (throttling is not a missing folder)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'TooManyRequests' } }, 429)));
    const err = await createGraphClient(env).folderIds(await account()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(429);
  });
});
