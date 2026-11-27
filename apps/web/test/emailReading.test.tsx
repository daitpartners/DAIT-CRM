import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EmailPage } from '../src/pages/email/EmailPage';
import type { MailAttachment, MailDetail, MailItem, MailMeta } from '../src/api/mail';
import type { Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { I18nProvider } from '../src/i18n';
import es from '../src/locales/es.json';
import { makeClient, rep } from './leadFixture';

afterEach(() => {
  vi.unstubAllGlobals();
});

const me: Me = { ...rep, timezone: 'Europe/London', dateFormat: 'DD MMM YYYY', rights: [...rep.rights, 'use_email' as const] };
const admin: Me = { ...me, id: 1, name: 'Maya Iyer', role: 'Administrator', rights: [...me.rights, 'view_team_mail' as const] };
const carlos = { id: 9, name: 'Carlos Torres' };

const item = (over: Partial<MailItem> = {}): MailItem => ({
  id: 1, owner: { id: 2, name: 'Arjun Mehta' }, viewOnly: false, leadRestricted: false, folder: 'inbox', status: 'received', fromAddress: 'ana@acme.com',
  fromName: 'Ana Ruiz', toAddresses: ['arjun@daitpartners.com'], subject: 'Proposal', preview: 'Looks good', occurredAt: '2026-11-22T09:05:00.000Z',
  isRead: true, leadId: null, leadNumber: null, companyId: null, hasAttachments: false, projectId: null, projectNumber: null,
  flagStatus: 'notFlagged', flagDue: null, replied: false, conversationCount: 1, leadStatus: null, ...over,
});
type ThreadEntry = MailDetail['thread'][number];
const entry = (m: MailItem, over: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id: m.id, occurredAt: m.occurredAt, direction: m.status === 'received' ? 'in' : 'out', who: '', subject: m.subject, kind: 'received', by: null,
  unmatched: false, fromName: m.fromName, fromAddress: m.fromAddress, toAddresses: m.toAddresses, ccAddresses: [], preview: m.preview,
  hasAttachments: m.hasAttachments, folder: m.folder, isRead: m.isRead, ...over,
});
const detail = (m: MailItem, over: Partial<MailDetail> = {}): MailDetail => ({
  ...m, ccAddresses: [], bodyText: m.preview, bodyHtml: null, attachmentNames: [], loggedAt: null, lead: null, contact: null, company: null,
  restrictedLead: null, leadPanel: null, thread: [], ...over,
});
const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-22T09:00:00.000Z' },
  unread: 0, counts: { inbox: 0, drafts: 0, scheduled: 0, flagged: 0, awaiting: 0, due: 0, leads: 1 },
  companies: [], leads: [], projects: [], mailUsers: [carlos], leadOwners: [],
};

/** A three-message conversation: Ana's newest (opened), Maria's, then Deepak's own first message. */
const newest = item({ id: 1, conversationCount: 3, leadId: 5, leadNumber: 'LD-1178', companyId: 4, leadStatus: 'Proposal', hasAttachments: true });
const maria = item({ id: 2, fromName: 'Maria Gómez', fromAddress: 'maria@acme.com', occurredAt: '2026-11-21T16:40:00.000Z', preview: 'Can we move it?' });
const deepak = item({
  id: 3, status: 'sent', folder: 'sent', fromName: 'Deepak Singh', fromAddress: 'deepak@daitpartners.com', toAddresses: ['maria@acme.com'],
  occurredAt: '2026-11-19T10:12:00.000Z', preview: 'Our proposal is attached',
});
const thread = [entry(newest), entry(maria), entry(deepak, { kind: 'sent' })];
const ATTACHMENTS: MailAttachment[] = [
  { id: 'AAMk+a/b==', name: 'DAIT_Proposal_v2.pdf', contentType: 'application/pdf', size: 1_887_437, preview: true, kind: 'file' },
  { id: 'A2', name: 'Budget.xlsx', contentType: 'application/vnd.ms-excel', size: 65_536, preview: false, kind: 'file' },
  { id: 'A3', name: 'Shared folder', contentType: '', size: 0, preview: false, kind: 'reference' },
  { id: 'A4', name: 'Earlier note.eml', contentType: 'message/rfc822', size: 4096, preview: false, kind: 'item' },
];
const DETAILS: Record<number, MailDetail> = {
  1: detail(newest, {
    ccAddresses: ['li@acme.com'], bodyHtml: '<p>See <a href="https://acme.com/plan">the plan</a></p>',
    attachmentNames: ['DAIT_Proposal_v2.pdf', 'Budget.xlsx', 'Shared folder', 'Earlier note.eml'],
    lead: { id: 5, number: 'LD-1178', status: 'Proposal', priority: 'High', nextFollowUp: null, companyId: 4 }, company: { id: 4, name: 'Acme Logistics' },
    thread,
  }),
  2: detail(maria, { thread, bodyText: 'Can we move it to Thursday?' }),
  3: detail(deepak, { thread, ccAddresses: ['li@acme.com'], bodyText: 'Our proposal is attached.' }),
};

function stub(items: MailItem[], details: Record<number, MailDetail>, opts: { user?: Me; meta?: MailMeta; attachments?: { available: boolean; items: MailAttachment[] } } = {}) {
  const posts: { url: string; body: unknown }[] = [];
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ id: 99, leadId: 5 }, { status: 201 });
    }
    asked.push(url);
    if (url === '/api/me') return Response.json(opts.user ?? me);
    if (url.startsWith('/api/mail?')) return Response.json({ items, total: items.length, page: 1, pageSize: 50 });
    if (url.startsWith('/api/mail/meta')) return Response.json(opts.meta ?? META);
    if (url === '/api/lookups') return Response.json({ groups: {} });
    if (/^\/api\/mail\/\d+\/attachments$/.test(url)) return Response.json(opts.attachments ?? { available: true, items: ATTACHMENTS });
    const m = /^\/api\/mail\/(\d+)(\?peek=1)?$/.exec(url);
    if (m) return Response.json(details[Number(m[1])]);
    return Response.json({ items: [], total: 0, page: 1, pageSize: 25 });
  }));
  return { posts, asked };
}

function show(path = '/email/1', user: Me = me) {
  return render(
    <QueryClientProvider client={makeClient(user)}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/email" element={<EmailPage />} />
                <Route path="/email/:id" element={<EmailPage />} />
                <Route path="*" element={null} />
              </Routes>
            </MemoryRouter>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const pane = () => screen.findByRole('region', { name: 'Reading pane' });

describe('Reading pane (web-mail release 2, mockup states 1 and 5)', () => {
  it('head: subject, lead chip with its stage, company and the message count', async () => {
    stub([newest], DETAILS);
    show();
    const p = await pane();
    expect(await within(p).findByRole('heading', { level: 2, name: 'Proposal' })).toBeInTheDocument();
    const meta = p.querySelector('.rp-meta')!;
    expect(meta).toHaveTextContent('LD-1178 · Proposal');
    expect(meta).toHaveTextContent('Acme Logistics');
    expect(meta).toHaveTextContent('3 messages');
    expect(meta).not.toHaveTextContent('Your mailbox');
  });

  it('conversation newest on top: the opened message expanded, older ones collapsed and expandable', async () => {
    const user = userEvent.setup();
    const { asked } = stub([newest], DETAILS);
    show();
    const p = await pane();
    await within(p).findByRole('article');
    expect(within(p).getAllByRole('article')).toHaveLength(1);
    expect(within(p).getByRole('article')).toHaveTextContent('Ana Ruiz <ana@acme.com>');
    expect(within(p).getByRole('article')).toHaveTextContent('To: arjun@daitpartners.com · Cc: li@acme.com');
    expect(within(p).getByRole('article')).toHaveTextContent('22 Nov 2026, 09:05');
    const rows = within(p).getAllByRole('button', { name: /Maria Gómez|Deepak Singh/ });
    expect(rows.map((b) => b.textContent)).toEqual([expect.stringContaining('21 Nov 2026, 16:40'), expect.stringContaining('19 Nov 2026, 10:12')]);
    expect(rows[0]).toHaveTextContent('Can we move it?');
    expect(asked).not.toContain('/api/mail/3');
    await user.click(within(p).getAllByRole('button', { name: /Deepak Singh/ })[0]!);
    expect(await within(p).findAllByRole('article')).toHaveLength(2);
    expect(asked).toContain('/api/mail/3');
    const older = within(p).getAllByRole('article')[1]!;
    expect(older).toHaveTextContent('Our proposal is attached.');
    expect(older).toHaveTextContent('To: maria@acme.com · Cc: li@acme.com');
    // A click on its sender folds it back to its row.
    await user.click(within(older).getByRole('button', { name: /Deepak Singh/ }));
    await waitFor(() => expect(within(p).getAllByRole('article')).toHaveLength(1));
    expect(within(p).getByRole('button', { name: /Deepak Singh/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('attachment cards above the body with Preview (PDF only) and Download links through the API; cloud links have neither', async () => {
    stub([newest], DETAILS);
    show();
    const p = await pane();
    const list = await within(p).findByRole('list', { name: 'Attachments' });
    await waitFor(() => expect(within(list).getAllByRole('link', { name: 'Download' })).toHaveLength(3));
    const cards = within(list).getAllByRole('listitem');
    expect(cards.map((c) => c.querySelector('.fi')!.textContent)).toEqual(['PDF', 'XLSX', 'FILE', 'EML']);
    expect(cards[0]).toHaveTextContent('1.8 MB');
    // Graph's base64 id is encoded (F13).
    expect(within(cards[0]!).getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/mail/1/attachment?att=AAMk%2Ba%2Fb%3D%3D');
    expect(within(cards[0]!).getByRole('link', { name: 'Download' })).toHaveAttribute('download');
    const preview = within(list).getAllByRole('link', { name: 'Preview' });
    expect(preview).toHaveLength(1);
    expect(preview[0]).toHaveAttribute('href', '/api/mail/1/attachment?att=AAMk%2Ba%2Fb%3D%3D&inline=1');
    expect(preview[0]).toHaveAttribute('target', '_blank');
    expect(preview[0]).toHaveAttribute('rel', 'noopener');
    expect(within(cards[1]!).getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/mail/1/attachment?att=A2');
    expect(within(cards[2]!).queryByRole('link')).toBeNull();
    expect(within(cards[3]!).getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/mail/1/attachment?att=A4');
    // Above the body.
    const article = within(p).getByRole('article');
    expect(list.compareDocumentPosition(within(article).getByTitle('Message body')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('attachments of a collapsed message are not asked for until it is expanded; a disconnected mailbox lists the names without links', async () => {
    const user = userEvent.setup();
    const withFiles = { ...DETAILS, 3: { ...DETAILS[3]!, attachmentNames: ['Proposal.pdf'] } };
    const { asked } = stub([newest], withFiles, { attachments: { available: false, items: [] } });
    show();
    const p = await pane();
    await within(p).findByRole('article');
    await waitFor(() => expect(asked).toContain('/api/mail/1/attachments'));
    expect(asked).not.toContain('/api/mail/3/attachments');
    expect(await within(p).findByText('Not in Outlook yet')).toBeInTheDocument();
    expect(within(p).queryByRole('link', { name: 'Download' })).toBeNull();
    expect(within(within(p).getByRole('list', { name: 'Attachments' })).getAllByRole('listitem')).toHaveLength(4);
    await user.click(within(p).getByRole('button', { name: /Deepak Singh/ }));
    await waitFor(() => expect(asked).toContain('/api/mail/3/attachments'));
  });

  it('the Email screen frame is same-origin (no scripts) and takes its content height; links open outward; CSP refuses scripts', async () => {
    stub([newest], DETAILS);
    show();
    const p = await pane();
    const frame = (await within(p).findByTitle('Message body')) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    expect(frame.getAttribute('sandbox')).not.toMatch(/allow-scripts|allow-forms|allow-top-navigation/);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    const doc = frame.getAttribute('srcdoc')!;
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'">`);
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
    expect(doc).toContain('<a href="https://acme.com/plan" target="_blank" rel="noopener noreferrer">the plan</a>');
    expect(doc).toContain('html{overflow:hidden}');
  });

  it("the email's own <style> blocks stay in the frame (Outlook / Word formatting), with its links still opening outward", async () => {
    const outlook = '<style>p.MsoNormal{margin:0;font-family:Calibri}.x_sig{color:#1f497d}</style><p class="MsoNormal">Hi <a href="https://acme.com">Acme</a></p><p class="x_sig">Ana</p>';
    stub([newest], { ...DETAILS, 1: { ...DETAILS[1]!, bodyHtml: outlook } });
    show();
    const p = await pane();
    const doc = ((await within(p).findByTitle('Message body')) as HTMLIFrameElement).getAttribute('srcdoc')!;
    expect(doc).toContain('<body><style>p.MsoNormal{margin:0;font-family:Calibri}.x_sig{color:#1f497d}</style><p class="MsoNormal">Hi <a href="https://acme.com" target="_blank" rel="noopener noreferrer">Acme</a></p><p class="x_sig">Ana</p></body>');
    // Style blocks are allowed by the policy; scripts are not.
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("style-src 'unsafe-inline'");
  });

  it('the frame height follows the content on load and when the body resizes', async () => {
    // Other parts of the screen watch their own sizes too: keep the callback of whoever observes the frame's body.
    const watchers = new Map<Element, () => void>();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: () => void) {}
      observe(el: Element) { watchers.set(el, this.cb); }
      unobserve() {}
      disconnect() {}
    });
    stub([newest], DETAILS);
    show();
    const p = await pane();
    const frame = (await within(p).findByTitle('Message body')) as HTMLIFrameElement;
    const body = document.createElement('body');
    let height = 480;
    Object.defineProperty(body, 'scrollHeight', { get: () => height });
    Object.defineProperty(frame, 'contentDocument', { value: { body, documentElement: document.createElement('html') } });
    frame.dispatchEvent(new Event('load'));
    expect(frame.style.height).toBe('480px');
    expect(watchers.has(body)).toBe(true);
    height = 912;
    watchers.get(body)!();
    expect(frame.style.height).toBe('912px');
  });

  it('a plain-text body shows as text (no frame)', async () => {
    stub([newest], { ...DETAILS, 1: { ...DETAILS[1]!, bodyHtml: null, bodyText: 'Hi Arjun,\n\n<b>not markup</b>' } });
    show();
    const p = await pane();
    await waitFor(() => expect(p.querySelector('.plain')).not.toBeNull());
    expect(p.querySelector('.plain')!.textContent).toBe('Hi Arjun,\n\n<b>not markup</b>');
    expect(within(p).queryByTitle('Message body')).toBeNull();
  });

  it('per-message Reply all opens Compose for that message', async () => {
    const user = userEvent.setup();
    stub([newest], DETAILS);
    show();
    const p = await pane();
    await user.click(await within(p).findByRole('button', { name: /Deepak Singh/ }));
    const older = (await within(p).findAllByRole('article'))[1]!;
    await user.click(within(older).getByRole('button', { name: 'Reply all' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reply all' });
    // Your own message: Reply all goes to its recipients; Cc keeps the original Cc.
    expect(within(dialog).getByLabelText('To')).toHaveValue('maria@acme.com');
    expect(within(dialog).getByLabelText(/^Cc/)).toHaveValue('li@acme.com');
    expect(within(dialog).getByLabelText('Subject')).toHaveValue('Re: Proposal');
  });

  it('footer under the newest message: Reply, Reply all, Forward; Forward opens Compose with an empty To', async () => {
    const user = userEvent.setup();
    stub([newest], DETAILS);
    show();
    const p = await pane();
    const article = await within(p).findByRole('article');
    const foot = article.querySelector('.msg-foot') as HTMLElement;
    await waitFor(() => expect(within(foot).getAllByRole('button').map((b) => b.textContent)).toEqual(['Reply', 'Reply all', 'Forward']));
    await user.click(within(foot).getByRole('button', { name: 'Forward' }));
    const dialog = await screen.findByRole('dialog', { name: 'Forward' });
    expect(within(dialog).getByLabelText('To')).toHaveValue('');
    expect(within(dialog).getByLabelText('Subject')).toHaveValue('Fw: Proposal');
  });

  it('More actions opens the message menu for that message', async () => {
    const user = userEvent.setup();
    const { posts } = stub([newest], DETAILS);
    show();
    const p = await pane();
    await user.click(await within(p).findByRole('button', { name: /Maria Gómez/ }));
    const older = (await within(p).findAllByRole('article'))[1]!;
    await user.click(within(older).getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    await user.click(within(menu).getByRole('menuitem', { name: /^Archive/ }));
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/2/change', body: { type: 'move', folder: 'archive' } }));
  });

  it('a draft: no reply footer, "Drafts are edited in Outlook."', async () => {
    const draft = item({ folder: 'drafts', status: 'draft' });
    stub([draft], { 1: detail(draft) });
    show('/email/1?folder=drafts');
    const p = await pane();
    const article = await within(p).findByRole('article');
    expect(await within(article).findByText('Drafts are edited in Outlook.')).toBeInTheDocument();
    expect(article.querySelector('.msg-foot button')).toBeNull();
    expect(within(article).getByRole('button', { name: 'Reply' })).toBeDisabled();
  });

  it('view only: banner, footer pill, Log as activity and Create task; no Reply buttons', async () => {
    const user = userEvent.setup();
    const theirs = item({ id: 2, owner: carlos, viewOnly: true, leadId: 5, leadNumber: 'LD-1005', leadStatus: 'Proposal' });
    const { posts } = stub([theirs], {
      2: detail(theirs, { lead: { id: 5, number: 'LD-1005', status: 'Proposal', priority: 'High', nextFollowUp: null, companyId: 4 }, company: { id: 4, name: 'Acme' } }),
    }, { user: admin });
    show('/email/2?mailof=all', admin);
    const p = await pane();
    expect(await within(p).findByText("View only — Carlos's mailbox.", { selector: '.viewonly strong' })).toBeInTheDocument();
    expect(within(p).getByText(/You can read, log and create tasks; only Carlos can reply from this mailbox\./)).toBeInTheDocument();
    expect(p.querySelector('.rp-meta')).toHaveTextContent("Carlos's mailbox");
    const article = within(p).getByRole('article');
    expect(within(article).getByText("View only — Carlos's mailbox", { selector: '.vo-pill' })).toBeInTheDocument();
    for (const name of ['Reply', 'Reply all', 'Forward']) expect(within(p).queryByRole('button', { name })).toBeNull();
    const foot = article.querySelector('.msg-foot') as HTMLElement;
    await waitFor(() => expect(within(foot).getByRole('button', { name: 'Log as activity' })).toBeEnabled());
    // The header's own Log as activity and More actions.
    expect(within(article.querySelector('.mh') as HTMLElement).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Log as activity', 'More actions']);
    await user.click(within(foot).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/2/task', body: undefined }));
  });

  it('your own message in team view: "Your mailbox" in the head, no banner, Reply enabled', async () => {
    stub([newest], DETAILS, { user: admin });
    show('/email/1?mailof=all', admin);
    const p = await pane();
    const article = await within(p).findByRole('article');
    await waitFor(() => expect(within(article.querySelector('.msg-foot') as HTMLElement).getByRole('button', { name: 'Reply' })).toBeEnabled());
    expect(p.querySelector('.rp-meta')).toHaveTextContent('Your mailbox');
    expect(p.querySelector('.viewonly')).toBeNull();
    expect(p.querySelector('.vo-pill')).toBeNull();
  });

  it("a message on another owner's lead: the head chip names it, with the company name", async () => {
    const a = item({ leadRestricted: true, leadNumber: 'LD-1005' });
    stub([a], { 1: detail(a, { restrictedLead: { number: 'LD-1005', companyName: 'Acme' } }) });
    show();
    const p = await pane();
    await within(p).findByRole('article');
    expect(p.querySelector('.rp-meta')).toHaveTextContent("LD-1005 · another owner's lead");
    expect(p.querySelector('.rp-meta')).toHaveTextContent('Acme');
  });

  it('Spanish: footer, count and attachment links translated', async () => {
    const spanish: Me = { ...me, language: 'es' };
    stub([newest], DETAILS, { user: spanish });
    show('/email/1', spanish);
    const p = await screen.findByRole('region', { name: es['Reading pane'] });
    expect(await within(p).findByText(es['{n} messages'].replace('{n}', '3'))).toBeInTheDocument();
    expect(await within(p).findAllByRole('link', { name: es.Download })).toHaveLength(3);
    expect(within(p).getAllByRole('button', { name: es['Reply all'] })).toHaveLength(2);
  });
});
