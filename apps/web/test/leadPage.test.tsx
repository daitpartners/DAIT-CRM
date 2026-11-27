import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { LeadFull } from '../src/api/leads';
import { keys, type LookupValue, type Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { LeadModal } from '../src/pages/leads/LeadModal';
import { LeadPage } from '../src/pages/leads/LeadPage';
import { EmailForm } from '../src/pages/leads/EmailForm';
import { UndoSendProvider } from '../src/components/send/UndoSend';
import { draftView } from './draftFixture';
import { Wrap, makeLead } from './leadFixture';

const rep: Me = {
  id: 2, email: 'arjun@daitpartners.com', name: 'Arjun Mehta', role: 'Sales Representative', language: 'en',
  timezone: 'UTC', dateFormat: 'DD/MM/YYYY', rights: ['manage_leads', 'claim_leads', 'manage_companies'],
};

const lookup = (group: LookupValue['group'], value: string, id: number): LookupValue => ({
  id, group, value, label: value, labelEs: null, labelFr: null, sortOrder: id, isActive: true,
});

const baseLead: LeadFull = {
  id: 5, number: 'LD-1005', leadType: 'Lead', companyName: 'Meridian Textiles', companyId: 4, country: 'India', outreachLanguage: 'en' as const, city: null,
  leadSource: 'Referral', status: 'New', priority: 'Medium', assignedTo: null, assignedToId: null, nextFollowUp: null,
  isOverdue: false, archivedAt: null, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z',
  website: null, businessEmail: null, phone: null, sourceUrl: null, importBatch: null, notes: 'Mine', contactId: null,
  company: {
    id: 4, number: 'CO-0245', name: 'Meridian Textiles', industry: null, city: null, country: 'India', employeeRange: null,
    isClient: false, verificationStatus: null, contactCount: 0, openLeadCount: 1, legalName: null, website: null, domain: null,
    businessCategory: null, timezone: null,
  },
  contact: null, createdBy: null, activities: [], activityTotal: 0, callCount: 0, lastContact: null, assignments: [], tasks: [],
};

function setup(me: Me = rep) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.me, me);
  qc.setQueryData(keys.users, []);
  qc.setQueryData(keys.lookups, {
    country: [lookup('country', 'India', 1)],
    lead_source: [lookup('lead_source', 'Referral', 2)],
    lead_status: [lookup('lead_status', 'New', 3), lookup('lead_status', 'Contacted', 4)],
  });
  return qc;
}

afterEach(() => vi.unstubAllGlobals());

describe('lead page conflicts', () => {
  it('edit: a stale save reloads the form with the latest values and keeps the stamp it loaded', async () => {
    const u = userEvent.setup();
    const theirs = { ...baseLead, notes: 'Their change', updatedAt: '2026-11-21T09:00:00.000Z' };
    const patches: { notes?: string; updatedAt?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/leads/5' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        return body.updatedAt === theirs.updatedAt
          ? Response.json({ ...theirs, notes: body.notes })
          : Response.json({ error: 'stale' }, { status: 409 });
      }
      if (url === '/api/leads/5') return Response.json(theirs);
      throw new Error(`unexpected fetch ${url}`);
    }));
    const qc = setup();
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter>
            <LeadModal lead={baseLead} onClose={onClose} />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    const notes = screen.getByLabelText('Notes');
    await u.clear(notes);
    await u.type(notes, 'My change');
    await u.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('This lead was changed by someone else. The form now shows the latest values; check them and save again.'),
    ).toBeInTheDocument();
    // The form shows the refetched lead, not the user's stale snapshot.
    await waitFor(() => expect(screen.getByLabelText('Notes')).toHaveValue('Their change'));
    expect(patches[0]).toMatchObject({ notes: 'My change', updatedAt: baseLead.updatedAt });
    expect(onClose).not.toHaveBeenCalled();

    // Saving again now carries the refreshed stamp.
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(patches[1]).toMatchObject({ notes: 'Their change', updatedAt: theirs.updatedAt });
  });

  it('claim: already_assigned refetches the lead and the Claim button goes away', async () => {
    const u = userEvent.setup();
    let claimed = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/leads/5/claim') {
        claimed = true;
        return Response.json({ error: 'already_assigned' }, { status: 409 });
      }
      if (url === '/api/leads/5') {
        return Response.json(
          claimed ? { ...baseLead, assignedTo: { id: 2, name: 'Arjun Mehta' }, assignedToId: 2, updatedAt: '2026-11-21T09:00:00.000Z' } : baseLead,
        );
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
    }));
    const qc = setup();
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/leads/5']}>
            <Routes>
              <Route path="/leads/:id" element={<LeadPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await u.click(within(await screen.findByRole('group', { name: 'Owner' })).getByRole('button', { name: 'Claim' }));
    expect(await screen.findByText('Someone has already taken this lead')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Owner' })).queryByRole('button', { name: 'Claim' })).not.toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'Owner' })).toHaveTextContent('Arjun Mehta');
  });

  it('composer: a draft survives switching tabs and folding the box', async () => {
    const u = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/leads/5') return Response.json(baseLead);
      throw new Error(`unexpected fetch ${url}`);
    }));
    const qc = setup();
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/leads/5']}>
            <Routes>
              <Route path="/leads/:id" element={<LeadPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await u.click(await screen.findByRole('tab', { name: 'Meeting' }));
    await u.clear(screen.getByRole('textbox', { name: /Title/ }));
    await u.type(screen.getByRole('textbox', { name: /Title/ }), 'Kick-off with ops');
    await u.click(screen.getByRole('tab', { name: 'Call note' }));
    expect(screen.queryByRole('textbox', { name: /Title/ })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Hide' }));
    await u.click(screen.getByRole('tab', { name: 'Meeting' }));
    expect(screen.getByRole('textbox', { name: /Title/ })).toHaveValue('Kick-off with ops');
  });
});

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

/**
 * The lead email form's server: the mailbox (connected unless `noMailbox`), templates, the company's projects, and the
 * drafts path — a new draft is 9 (then 10…), a template's files copied onto it, Send answers the Undo window (or the
 * scheduled time), Undo gives the draft back as it was sent. `sendError`: the first sends' refusal codes.
 */
function mailStub(opts: { templates?: unknown[]; projects?: { items: unknown[]; isClient: boolean }; noMailbox?: boolean; sendError?: string[] } = {}) {
  const calls: Call[] = [];
  const sent: Record<number, Record<string, unknown>> = {};
  const sendErrors = [...(opts.sendError ?? [])];
  let next = 9;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (method !== 'GET') calls.push({ url, method, body });
    if (url === '/api/mail/drafts' && method === 'POST') {
      return Response.json(draftView({ id: next++, replyToId: null, to: [], subject: '', bodyHtml: '', quotedHtml: null, leadId: 5, projectId: (body?.projectId as number | undefined) ?? null }), { status: 201 });
    }
    const tpl = /^\/api\/mail\/drafts\/(\d+)\/template$/.exec(url);
    if (tpl) return Response.json({ files: [{ id: 'att-pdf', name: 'Brochure.pdf', contentType: 'application/pdf', size: 997_316, inline: false, contentId: null, dataUrl: null }] });
    const send = /^\/api\/mail\/drafts\/(\d+)\/send$/.exec(url);
    if (send) {
      if (sendErrors.length) return Response.json({ error: sendErrors.shift() }, { status: 400 });
      sent[Number(send[1])] = body!;
      const at = body!.at as string | null;
      const fu = body!.followUp as { date: string; time: string } | null;
      return Response.json({
        id: Number(send[1]), sendAt: at ?? new Date(Date.now() + 10_000).toISOString(), undoUntil: at ? null : new Date(Date.now() + 10_000).toISOString(),
        followUp: fu ? { date: fu.date, time: fu.time } : null,
      }, { status: 202 });
    }
    const unsend = /^\/api\/mail\/(\d+)\/unsend$/.exec(url);
    if (unsend) {
      const b = sent[Number(unsend[1])]!;
      const r = (a: string) => ({ address: a, name: null, leadNumber: null });
      return Response.json(draftView({
        id: Number(unsend[1]), replyToId: null, to: (b.to as string[]).map(r), cc: (b.cc as string[]).map(r), subject: b.subject as string,
        bodyHtml: b.bodyHtml as string, quotedHtml: null, leadId: 5, projectId: (b.projectId as number | null) ?? null,
        files: [{ id: 'att-pdf', name: 'Brochure.pdf', contentType: 'application/pdf', size: 997_316, inline: false, contentId: null, dataUrl: null }],
      }));
    }
    if (/^\/api\/mail\/drafts\/\d+\/files\//.test(url)) return new Response(null, { status: 204 });
    if (url === '/api/me') return Response.json(rep);
    if (url.startsWith('/api/email-templates/10/attachments/')) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/png' } });
    if (url.startsWith('/api/email-templates')) return Response.json({ items: opts.templates ?? [] });
    if (url === '/api/companies/4/projects') return Response.json(opts.projects ?? { items: [], isClient: false });
    if (url === '/api/mailboxes') return Response.json({ mine: opts.noMailbox ? null : { id: 7, address: 'arjun@daitpartners.com', status: 'connected' } });
    return Response.json({ items: [], total: 0, page: 1, pageSize: 100, isClient: false });
  }));
  return {
    calls,
    postPaths: () => calls.filter((c) => c.method === 'POST').map((c) => c.url),
    of: (url: string) => calls.filter((c) => c.url === url).map((c) => c.body),
  };
}

function renderEmailForm(lead: LeadFull) {
  render(
    <Wrap qc={setup()}>
      <UndoSendProvider>
        <EmailForm lead={lead} />
      </UndoSendProvider>
    </Wrap>,
  );
}

/** Send, then the follow-up box's `choice` (an open lead). */
async function sendWith(u: ReturnType<typeof userEvent.setup>, choice: 'Send and add follow-up' | 'Send without follow-up' = 'Send without follow-up') {
  await u.click(screen.getByRole('button', { name: 'Send' }));
  await u.click(within(await screen.findByRole('dialog', { name: 'Set the next follow-up' })).getByRole('button', { name: choice }));
}

describe('lead email form: Project picker (release 3B)', () => {
  const stakeholder = (id: number, name: string, email: string | null) => ({ id, name, email });
  const prj = (id: number, name: string, leadId: number | null, stakeholders: { id: number; name: string; email: string | null }[]) => ({
    id, number: `PRJ-${id}`, name, status: 'Active', startDate: '2026-11-01', value: null, currency: 'USD', company: { id: 4, name: 'Meridian Textiles' },
    lead: leadId ? { id: leadId, number: `LD-${1000 + leadId}`, visible: true } : null, quotation: null, manager: { id: 2, name: 'Arjun Mehta' },
    stakeholders, description: null, completedAt: null, createdAt: '', updatedAt: '', canEdit: true,
  });
  const client = { ...baseLead, contact: { ...makeLead().contact!, email: 'tom@meridian.in' }, company: { ...baseLead.company!, isClient: true } };

  function renderForm(lead: LeadFull, projects: { items: unknown[]; isClient: boolean }) {
    const api = mailStub({ projects });
    renderEmailForm(lead);
    return api;
  }
  const chips = () => [...document.querySelectorAll('.cchip')].map((x) => x.getAttribute('title'));

  it('not a client: disabled, "available once the lead is Won"', async () => {
    renderForm(baseLead, { items: [], isClient: false });
    const pick = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    expect(pick.disabled).toBe(true);
    expect(pick.selectedOptions[0]!.textContent).toBe('available once the lead is Won');
  });

  it('a client with no projects: "no projects yet"', async () => {
    renderForm(client, { items: [], isClient: true });
    const pick = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    await waitFor(() => expect(pick.selectedOptions[0]!.textContent).toBe('no projects yet'));
  });

  it("defaults to this lead's project with its stakeholders ticked; switching swaps them and keeps hand-added Cc; sends projectId", async () => {
    const u = userEvent.setup();
    const api = renderForm(client, {
      isClient: true,
      items: [
        prj(9, 'Other site', null, [stakeholder(31, 'Cleo', 'cleo@meridian.in'), stakeholder(32, 'Tom Hale', 'TOM@meridian.in')]),
        prj(3, 'Website', 5, [stakeholder(21, 'Ava', 'ava@meridian.in'), stakeholder(22, 'No Mail', null), stakeholder(23, 'Bo', 'bo@meridian.in')]),
      ],
    });
    const pick = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    await waitFor(() => expect(pick).toHaveValue('3'));
    expect(pick.disabled).toBe(false);
    expect(within(pick).getByRole('option', { name: '— no project —' })).toBeTruthy();
    expect(within(pick).getByRole('option', { name: 'PRJ-9 · Other site' })).toBeTruthy();
    expect(chips()).toEqual(['ava@meridian.in', 'bo@meridian.in']);
    const cc = screen.getByRole('combobox', { name: 'Cc stakeholders' });
    await u.type(cc, 'hand@meridian.in{Enter}');
    expect(chips()).toEqual(['ava@meridian.in', 'bo@meridian.in', 'hand@meridian.in']);
    // Tom is the To address: not copied.
    await u.selectOptions(pick, '9');
    expect(chips()).toEqual(['hand@meridian.in', 'cleo@meridian.in']);
    await u.selectOptions(pick, '');
    expect(chips()).toEqual(['hand@meridian.in']);
    await u.selectOptions(pick, '9');
    await sendWith(u);
    await waitFor(() => expect(api.of('/api/mail/drafts/9/send')).toHaveLength(1));
    expect(api.of('/api/mail/drafts')).toEqual([{ kind: 'new', leadId: 5, projectId: 9 }]);
    expect(api.of('/api/mail/drafts/9/send')[0]).toMatchObject({ projectId: 9, leadId: 5, to: ['tom@meridian.in'], cc: ['hand@meridian.in', 'cleo@meridian.in'], bcc: [] });
  });

  it('an empty Subject is marked and focused instead of sending (review #12); a server refusal is said in the follow-up box', async () => {
    const u = userEvent.setup();
    const api = mailStub({ projects: { items: [], isClient: true }, sendError: ['validation'] });
    renderEmailForm(client);
    const subject = screen.getByRole('textbox', { name: 'Subject' });
    await u.clear(subject);
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(subject).toHaveAttribute('aria-invalid', 'true');
    expect(subject).toHaveClass('err');
    expect(subject).toHaveFocus();
    expect(screen.getByText('Enter a subject')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.calls).toEqual([]);
    await u.type(subject, 'Hello');
    expect(subject).not.toHaveAttribute('aria-invalid', 'true');

    // The server refuses the send: the box stays open with the reason, and the form keeps what was written.
    await sendWith(u);
    const box = screen.getByRole('dialog', { name: 'Set the next follow-up' });
    expect(await within(box).findByText('This email could not be saved. Check that every recipient is a valid email address.')).toBeInTheDocument();
    expect(subject).toHaveValue('Hello');
  });
});

describe('lead email form: formatted templates (24 Nov 2026)', () => {
  const FORMATTED = {
    id: 8, name: 'Proposal', language: 'en', subject: 'Proposal for {company}', body: 'Hi {first_name},\nThe proposal.',
    bodyHtml: '<p>Hi <b>{first_name}</b>,</p><ul><li>For {company}</li></ul>', sourceType: 'oft', fileName: 'Proposal.oft', fileSize: 9000, attachments: [],
    createdBy: null, createdAt: '', updatedAt: '',
  };
  const PLAIN = { ...FORMATTED, id: 9, name: 'Plain', bodyHtml: null, sourceType: 'manual', body: 'Hi {first_name}, plain.' };
  const WITH_FILES = {
    ...FORMATTED, id: 10, name: 'Holiday', updatedAt: '2026-11-24T10:00:00.000Z',
    bodyHtml: '<p>Hi {first_name}</p><img src="cid:logo.png" alt="Logo"><p>Bye</p>',
    attachments: [
      { id: 31, name: 'logo.png', contentType: 'image/png', size: 4, contentId: 'logo.png', inline: true },
      { id: 32, name: 'Brochure.pdf', contentType: 'application/pdf', size: 997_316, contentId: null, inline: false },
    ],
  };

  it('picking a formatted template fills the editor formatted (values escaped) and sends its HTML; a plain one is sent as simple HTML', async () => {
    const u = userEvent.setup();
    const api = mailStub({ templates: [FORMATTED, PLAIN] });
    const lead = { ...baseLead, companyName: 'Meridian <Textiles> & Co', company: { ...baseLead.company!, name: 'Meridian <Textiles> & Co' }, contact: { ...makeLead().contact!, firstName: 'Tom', email: 'tom@meridian.in' } };
    renderEmailForm(lead);
    const pick = screen.getByRole('combobox', { name: 'Template' });
    await waitFor(() => expect(within(pick).getByRole('option', { name: 'Proposal · .oft' })).toBeTruthy());
    await u.selectOptions(pick, '8');
    expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Proposal for Meridian <Textiles> & Co');
    const frame = await waitFor(() => {
      const f = document.querySelector('iframe#em-body') as HTMLIFrameElement;
      expect(f.contentDocument!.body.innerHTML).toBe('<p>Hi <b>Tom</b>,</p><ul><li>For Meridian &lt;Textiles&gt; &amp; Co</li></ul>');
      return f;
    });
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    await sendWith(u);
    await waitFor(() => expect(api.of('/api/mail/drafts/9/send')[0]).toMatchObject({
      bodyHtml: '<p>Hi <b>Tom</b>,</p><ul><li>For Meridian &lt;Textiles&gt; &amp; Co</li></ul>', subject: 'Proposal for Meridian <Textiles> & Co',
    }));
    // A template without files: nothing to copy onto the draft.
    expect(api.postPaths()).toEqual(['/api/mail/drafts', '/api/mail/drafts/9/send']);

    // A plain template: the plain textarea, sent as simple HTML.
    await u.selectOptions(pick, '9');
    expect(document.querySelector('iframe#em-body')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Hi Tom, plain.');
    await u.type(screen.getByRole('textbox', { name: 'To' }), 'tom@meridian.in');
    await sendWith(u);
    await waitFor(() => expect(api.of('/api/mail/drafts/10/send')[0]).toMatchObject({ bodyHtml: '<p>Hi Tom, plain.</p>' }));
  });

  it('a template with pictures and a PDF: pictures shown in the editor (data:), sent as cid:; the files are copied to the draft before sending; the PDF removable', async () => {
    const u = userEvent.setup();
    const api = mailStub({ templates: [WITH_FILES] });
    const lead = { ...baseLead, contact: { ...makeLead().contact!, firstName: 'Tom', email: 'tom@meridian.in' } };
    renderEmailForm(lead);
    const pick = screen.getByRole('combobox', { name: 'Template' });
    await waitFor(() => expect(within(pick).getByRole('option', { name: 'Holiday · .oft' })).toBeTruthy());
    await u.selectOptions(pick, '10');
    // Only the inline picture is fetched (the PDF is never downloaded to compose).
    await waitFor(() => {
      const f = document.querySelector('iframe#em-body') as HTMLIFrameElement;
      expect(f.contentDocument!.body.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,iVBORw==');
    });
    const files = screen.getByRole('list', { name: 'Attachments' });
    expect(within(files).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Brochure.pdf · 974 KB×']);
    await sendWith(u);
    await waitFor(() => expect(api.postPaths()).toEqual(['/api/mail/drafts', '/api/mail/drafts/9/template', '/api/mail/drafts/9/send']));
    expect(api.of('/api/mail/drafts/9/template')).toEqual([{ templateId: 10, attachmentIds: [32] }]);
    expect(api.of('/api/mail/drafts/9/send')[0]!.bodyHtml).toBe('<p>Hi Tom</p><img src="cid:logo.png" alt="Logo"><p>Bye</p>');

    // After sending the form is blank again; picked again, the PDF can be removed before sending.
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull());
    await u.selectOptions(pick, '10');
    await u.click(await screen.findByRole('button', { name: 'Remove Brochure.pdf' }));
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull();
    await u.type(screen.getByRole('textbox', { name: 'To' }), 'tom@meridian.in');
    await sendWith(u);
    await waitFor(() => expect(api.of('/api/mail/drafts/10/template')).toEqual([{ templateId: 10, attachmentIds: [] }]));
    await waitFor(() => expect(api.of('/api/mail/drafts/10/send')).toHaveLength(1));
  });
});

describe('lead email form: the one send path (web-mail release 3)', () => {
  const lead = { ...baseLead, contact: { ...makeLead().contact!, firstName: 'Tom', email: 'tom@meridian.in' } };

  it('lead page: Send opens the follow-up box (no follow-up-days control), then the Undo toast; the request goes through /api/mail/drafts', async () => {
    const user = userEvent.setup();
    const api = mailStub();
    renderEmailForm(lead);
    expect(screen.queryByLabelText(/Set follow-up in/)).toBeNull();
    expect(screen.queryByLabelText('Follow-up in')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Set the next follow-up' })).getByRole('button', { name: 'Send and add follow-up' }));
    await waitFor(() => expect(api.postPaths()).toEqual(['/api/mail/drafts', '/api/mail/drafts/9/send']));
    expect(api.of('/api/mail/drafts')).toEqual([{ kind: 'new', leadId: 5 }]);
    expect(api.of('/api/mail/drafts/9/send')[0]).toMatchObject({
      to: ['tom@meridian.in'], cc: [], bcc: [], subject: 'Intro call this week?', leadId: 5, projectId: null, at: null,
      followUp: { title: 'Follow up: Intro call this week?', assignedToId: 2, time: '09:00' },
    });
    expect(api.of('/api/mail/drafts/9/send')[0]!.bodyHtml).toMatch(/^<p>Hi Tom,<\/p><p>Thanks for getting in touch/);
    expect(await screen.findByText(/^Sent · follow-up added for/)).toBeInTheDocument();
    // The form starts again.
    expect(screen.getByRole('textbox', { name: 'To' })).toHaveValue('');
  });

  it('lead page: a closed lead sends without the follow-up box', async () => {
    const user = userEvent.setup();
    const api = mailStub();
    renderEmailForm({ ...lead, status: 'Lost' });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.postPaths()).toEqual(['/api/mail/drafts', '/api/mail/drafts/9/send']));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.of('/api/mail/drafts/9/send')[0]).toMatchObject({ followUp: null });
    expect(await screen.findByText(/^Sent$/)).toBeInTheDocument();
  });

  it('lead page: Undo refills the form and the next Send reuses the draft', async () => {
    const user = userEvent.setup();
    const api = mailStub();
    renderEmailForm(lead);
    await user.clear(screen.getByRole('textbox', { name: 'Subject' }));
    await user.type(screen.getByRole('textbox', { name: 'Subject' }), 'Pricing');
    await sendWith(user);
    const toast = (await screen.findByText(/^Sent$/)).closest('.utoast') as HTMLElement;
    expect(screen.getByRole('textbox', { name: 'To' })).toHaveValue('');
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'To' })).toHaveValue('tom@meridian.in'));
    expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Pricing');
    await waitFor(() => {
      const f = document.querySelector('iframe#em-body') as HTMLIFrameElement;
      expect(f.contentDocument!.body.innerHTML).toMatch(/^<p>Hi Tom,<\/p>/);
    });
    // The draft's files come back listed (and removable on the draft itself).
    expect(within(screen.getByRole('list', { name: 'Attachments' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Brochure.pdf · 974 KB×']);
    await user.click(screen.getByRole('button', { name: 'Remove Brochure.pdf' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull());
    await sendWith(user);
    await waitFor(() => expect(api.postPaths()).toEqual(['/api/mail/drafts', '/api/mail/drafts/9/send', '/api/mail/9/unsend', '/api/mail/drafts/9/send']));
    expect(api.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/mail/drafts/9/files/att-pdf']);
    expect(api.of('/api/mail/drafts/9/send')[1]).toMatchObject({ to: ['tom@meridian.in'], subject: 'Pricing', leadId: 5 });
  });

  it('lead page: Schedule send from Send ▾', async () => {
    const user = userEvent.setup();
    const api = mailStub();
    renderEmailForm(lead);
    await user.click(screen.getByRole('button', { name: 'Send options' }));
    await user.click(within(screen.getByRole('menu', { name: 'Send options' })).getByRole('menuitem', { name: 'Schedule send…' }));
    const pop = await screen.findByRole('dialog', { name: 'Schedule send' });
    await user.click(within(pop).getByRole('button', { name: /Tomorrow morning/ }));
    await user.click(within(pop).getByRole('button', { name: 'Schedule' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Set the next follow-up' })).getByRole('button', { name: 'Send without follow-up' }));
    await waitFor(() => expect(api.postPaths()).toEqual(['/api/mail/drafts', '/api/mail/drafts/9/send']));
    const body = api.of('/api/mail/drafts/9/send')[0]!;
    expect(typeof body.at).toBe('string');
    expect(new Date(body.at as string).getUTCHours()).toBe(8);
    expect(await screen.findByText(/^Scheduled for /)).toBeInTheDocument();
  });

  it('without a connected mailbox: the same guidance, and Send is off', async () => {
    mailStub({ noMailbox: true });
    renderEmailForm(lead);
    expect(await screen.findByText(/Connect your Microsoft 365 mailbox in Settings/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings/connections');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send options' })).toBeDisabled();
  });
});
