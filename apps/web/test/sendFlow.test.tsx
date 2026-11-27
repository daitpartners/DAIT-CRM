import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DraftFields, DraftView, FlushResult, SendResult } from '../src/api/drafts';
import { keys, type Me, type UserSummary } from '../src/api/queries';
import { SendButton } from '../src/components/send/SendButton';
import { UndoSendProvider } from '../src/components/send/UndoSend';
import { useSendFlow } from '../src/components/send/useSendFlow';
import { Wrap, makeClient, rep } from './leadFixture';

const NOW = new Date('2026-11-26T14:30:00.000Z'); // a Thursday
const SUBJECT = 'Proposal: Northwind Health patient portal UX';
const FIELDS: DraftFields = { to: ['james@northwind-health.com'], cc: [], bcc: [], subject: SUBJECT, bodyHtml: '<p>Hi James</p>', leadId: 12 };
const LEAD = { id: 12, number: 'LD-1204', company: 'Northwind Health', status: 'Proposal', open: true };

const admin: Me = {
  id: 1, email: 'deepak@daitpartners.com', name: 'Deepak Singh', role: 'Administrator', language: 'en', timezone: 'UTC',
  dateFormat: 'DD/MM/YYYY', rights: ['manage_leads', 'view_all_leads'],
};
const user = (id: number, name: string, isActive = true): UserSummary => ({
  id, email: `${id}@daitpartners.com`, name, role: 'Sales Representative', language: 'en', timezone: 'UTC', isActive, lastLoginAt: null,
});

const DRAFT = { id: 7, subject: SUBJECT, leadId: 12 } as DraftView;

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

/** The API: send answers a queued send (Undo window for a send now), unsend the draft, or `unsendStatus` (409). */
/**
 * `sendAnswers`: answers for the first sends, in order (`{ status, error }` refuses, a promise holds the answer back);
 * later sends are queued normally.
 */
function stubApi(opts: { unsendStatus?: number; me?: Me; users?: UserSummary[]; sendAnswers?: (({ status: number; error: string }) | Promise<void>)[] } = {}) {
  const answers = [...(opts.sendAnswers ?? [])];
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url === '/api/mail/drafts/7/send') {
      const answer = answers.shift();
      if (answer instanceof Promise) await answer;
      else if (answer) return Response.json({ error: answer.error }, { status: answer.status });
      const fu = body?.followUp as { date: string; time: string } | null;
      const result: SendResult = {
        id: 7,
        sendAt: (body?.at as string | null) ?? new Date(Date.now() + 10_000).toISOString(),
        undoUntil: body?.at ? null : new Date(Date.now() + 10_000).toISOString(),
        followUp: fu ? { date: fu.date, time: fu.time } : null,
      };
      return Response.json(result);
    }
    // A component mounting refetches the signed-in user; answer like the API does.
    if (url === '/api/me') return Response.json(opts.me ?? admin);
    if (url === '/api/users') return Response.json({ items: opts.users ?? USERS });
    if (url === '/api/mail/7/unsend') {
      if (opts.unsendStatus) return Response.json({ error: 'already_sent' }, { status: opts.unsendStatus });
      return Response.json(DRAFT);
    }
    return Response.json({});
  }));
  const sends = () => calls.filter((c) => c.url === '/api/mail/drafts/7/send');
  return { calls, sends, lastSend: () => sends().at(-1)?.body };
}

type HarnessProps = {
  lead?: typeof LEAD | null;
  options?: 'menu' | 'popover';
  recipientZone?: { zone: string; label: string } | null;
  flush?: () => Promise<FlushResult>;
  onSent?: (r: SendResult) => void;
  onUndone?: (d: DraftView) => void;
  /** Leave Send enabled while busy (a screen that does not disable it): the flow itself must still send once. */
  keepEnabled?: boolean;
};

function Harness({ lead = LEAD, options = 'popover', recipientZone = null, flush, onSent = () => {}, onUndone = () => {}, keepEnabled = false }: HarnessProps) {
  const flow = useSendFlow({ draftId: async () => 7, fields: () => FIELDS, flush, lead, who: 'James Whitaker', subject: SUBJECT, onSent, onUndone });
  return (
    <>
      <SendButton onSend={flow.send} onSchedule={flow.schedule} options={options} recipientZone={recipientZone} disabled={keepEnabled ? false : flow.busy} />
      {flow.dialog}
    </>
  );
}

const USERS = [user(1, 'Deepak Singh'), user(3, 'Lakshita Singh'), user(4, 'Old Hand', false)];

function mount(props: HarnessProps = {}, me: Me = admin, users: UserSummary[] = USERS) {
  const qc = makeClient(me);
  qc.setQueryData(keys.users, users);
  return render(
    <Wrap qc={qc}>
      <UndoSendProvider>
        <Harness {...props} />
      </UndoSendProvider>
    </Wrap>,
  );
}

/** The Undo toast (the plain toasts have their own role="status" list). */
const undoToast = () => document.querySelector<HTMLElement>('.utoast');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('send flow (web-mail release 3)', () => {
  it('Send with a lead opens the follow-up box: default In 3 working days Tue 1 Dec 2026, 09:00; title Follow up: <subject>', async () => {
    const u = userEvent.setup();
    stubApi();
    mount();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    expect(within(box).getByText('LD-1204 · Northwind Health')).toBeInTheDocument();
    expect(within(box).getByText('Your email is ready to send. When should you follow up with James Whitaker?')).toBeInTheDocument();
    expect(within(box).getByRole('radio', { name: /In 3 working days/ })).toBeChecked();
    expect(within(box).getByText('Default')).toBeInTheDocument();
    expect(within(box).getByText('Tue 1 Dec 2026, 09:00')).toBeInTheDocument();
    expect(within(box).getByText('Fri 27 Nov 2026, 09:00')).toBeInTheDocument();
    expect(within(box).getByText('Thu 3 Dec 2026, 09:00')).toBeInTheDocument();
    expect(within(box).getByText('Thu 10 Dec 2026, 09:00')).toBeInTheDocument();
    expect(within(box).getByLabelText('Task title')).toHaveValue(`Follow up: ${SUBJECT}`);
    expect(within(box).getByLabelText(/Note/)).toHaveAttribute('placeholder', 'e.g. Ask whether the CTO has reviewed the examples');
    expect(within(box).getByRole('checkbox', { name: "Also update the lead's next follow-up" })).toBeChecked();
    expect(within(box).getByText('Working days skip Saturday and Sunday. Times are 24-hour.')).toBeInTheDocument();
    expect(box.querySelector('.note.ok')).toHaveTextContent('Added to your Tasks · due Tue 1 Dec 2026, 09:00.');
    await u.click(within(box).getByRole('radio', { name: /Tomorrow/ }));
    expect(box.querySelector('.note.ok')).toHaveTextContent('Added to your Tasks · due Fri 27 Nov 2026, 09:00.');
  });

  it('Send and add follow-up posts the follow-up (Call → call, High, note, update lead) and shows the Undo toast', async () => {
    const u = userEvent.setup();
    const api = stubApi();
    const onSent = vi.fn();
    mount({ onSent });
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    await u.selectOptions(within(box).getByLabelText('Type'), 'Call');
    await u.selectOptions(within(box).getByLabelText('Priority'), 'High');
    await u.type(within(box).getByLabelText(/Note/), 'Ask the CTO');
    await u.click(within(box).getByRole('button', { name: 'Send and add follow-up' }));
    await waitFor(() => expect(api.sends()).toHaveLength(1));
    expect(api.lastSend()).toMatchObject({
      ...FIELDS,
      at: null,
      followUp: { date: '2026-12-01', time: '09:00', title: `Follow up: ${SUBJECT}`, assignedToId: 1, kind: 'call', priority: 'high', note: 'Ask the CTO', updateLead: true },
    });
    await waitFor(() => expect(undoToast()).not.toBeNull());
    expect(undoToast()).toHaveAttribute('role', 'status');
    expect(undoToast()).toHaveTextContent('Sent · follow-up added for Tue 1 Dec, 09:00');
    expect(within(undoToast()!).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Set the next follow-up' })).toBeNull();
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
  });

  it('another assignee, the default type, no note and the lead left alone are posted as chosen', async () => {
    const u = userEvent.setup();
    const api = stubApi();
    mount();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    const assignee = within(box).getByLabelText('Assigned to');
    expect([...(assignee as HTMLSelectElement).options].map((o) => o.text)).toEqual(['Me (Deepak Singh)', 'Lakshita Singh']);
    await u.selectOptions(assignee, 'Lakshita Singh');
    expect(box.querySelector('.note.ok')).toHaveTextContent("Added to Lakshita Singh's Tasks · due Tue 1 Dec 2026, 09:00.");
    await u.click(within(box).getByRole('checkbox', { name: "Also update the lead's next follow-up" }));
    await u.click(within(box).getByRole('button', { name: 'Send and add follow-up' }));
    await waitFor(() => expect(api.sends()).toHaveLength(1));
    const fu = api.lastSend()!.followUp as Record<string, unknown>;
    expect(fu).toMatchObject({ assignedToId: 3, kind: 'followup', priority: 'normal', updateLead: false });
    expect(fu.note).toBeUndefined();
  });

  it('Send without follow-up posts followUp null; the toast says Sent', async () => {
    const u = userEvent.setup();
    const api = stubApi();
    mount();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    await u.click(within(box).getByRole('button', { name: 'Send without follow-up' }));
    await waitFor(() => expect(api.sends()).toHaveLength(1));
    expect(api.lastSend()).toMatchObject({ at: null, followUp: null });
    await waitFor(() => expect(undoToast()).not.toBeNull());
    expect(undoToast()!.querySelector('.grow')).toHaveTextContent(/^Sent$/);
  });

  it('Cancel closes the box and sends nothing', async () => {
    const u = userEvent.setup();
    const api = stubApi();
    mount();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    await u.click(within(box).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Set the next follow-up' })).toBeNull();
    expect(api.sends()).toHaveLength(0);
  });

  it('no lead: no box, plain send', async () => {
    const u = userEvent.setup();
    const api = stubApi();
    mount({ lead: null });
    await u.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sends()).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.lastSend()).toMatchObject({ at: null, followUp: null });
  });

  it('a second click before the screen catches up sends nothing more', async () => {
    const api = stubApi();
    mount({ lead: null, keepEnabled: true });
    const send = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(undoToast()).not.toBeNull());
    expect(api.sends()).toHaveLength(1);
  });

  it('a closed lead: no box, plain send (decision 5)', async () => {
    const u = userEvent.setup();
    const api = stubApi();
    mount({ lead: { ...LEAD, open: false } });
    await u.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sends()).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an unsaved draft stops the send and says why', async () => {
    const u = userEvent.setup();
    const api = stubApi();
    mount({ lead: null, flush: async () => ({ ok: false, code: 'draft_gone' }) });
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This draft was removed in Outlook.')).toBeInTheDocument();
    expect(api.sends()).toHaveLength(0);
  });

  it('Undo calls unsend and hands back the draft', async () => {
    const u = userEvent.setup();
    const api = stubApi();
    const onUndone = vi.fn();
    mount({ lead: null, onUndone });
    await u.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(undoToast()).not.toBeNull());
    await u.click(within(undoToast()!).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(onUndone).toHaveBeenCalledWith(expect.objectContaining({ id: 7 })));
    expect(api.calls.some((c) => c.url === '/api/mail/7/unsend' && c.method === 'POST')).toBe(true);
    expect(undoToast()).toBeNull();
  });

  it('Undo too late: 409 already_sent shows Too late', async () => {
    const u = userEvent.setup();
    stubApi({ unsendStatus: 409 });
    const onUndone = vi.fn();
    mount({ lead: null, onUndone });
    await u.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(undoToast()).not.toBeNull());
    await u.click(within(undoToast()!).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Too late: the email was sent.')).toBeInTheDocument();
    expect(onUndone).not.toHaveBeenCalled();
    expect(undoToast()).toBeNull();
  });

  it('Schedule send: presets at 14:30 with Later today, custom time, recipient time line; Schedule posts at; the box counts from the scheduled day', async () => {
    const u = userEvent.setup();
    const api = stubApi();
    mount({ recipientZone: { zone: 'America/Chicago', label: 'Chicago' } });
    await u.click(screen.getByRole('button', { name: 'Send options' }));
    const pop = screen.getByRole('dialog', { name: 'Schedule send' });
    expect(within(pop).getByRole('button', { name: /Later today/ })).toHaveTextContent('Later today Thu 26 Nov 2026, 17:00');
    expect(within(pop).getByRole('button', { name: /Tomorrow morning/ })).toHaveTextContent('Tomorrow morning Fri 27 Nov 2026, 08:00');
    expect(within(pop).getByRole('button', { name: /Monday morning/ })).toHaveTextContent('Monday morning Mon 30 Nov 2026, 08:00');
    // Tomorrow morning is chosen first: 08:00 in London is 02:00 in Chicago.
    expect(within(pop).getByText("Recipient's time: Chicago — sent at their 02:00")).toBeInTheDocument();
    await u.clear(within(pop).getByLabelText('Date'));
    await u.type(within(pop).getByLabelText('Date'), '2026-12-01');
    await u.clear(within(pop).getByLabelText('Time (24-hour)'));
    await u.type(within(pop).getByLabelText('Time (24-hour)'), '09:30');
    expect(within(pop).getByText("Recipient's time: Chicago — sent at their 03:30")).toBeInTheDocument();
    await u.click(within(pop).getByRole('button', { name: 'Schedule' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    // Counted from Tue 1 Dec, the day the mail goes out.
    expect(within(box).getByText('Wed 2 Dec 2026, 09:00')).toBeInTheDocument();
    expect(within(box).getByText('Fri 4 Dec 2026, 09:00')).toBeInTheDocument();
    await u.click(within(box).getByRole('button', { name: 'Send and add follow-up' }));
    await waitFor(() => expect(api.sends()).toHaveLength(1));
    expect(api.lastSend()).toMatchObject({ at: '2026-12-01T09:30:00.000Z', followUp: { date: '2026-12-04', time: '09:00' } });
    expect(await screen.findByText('Scheduled for Tue 1 Dec, 09:30')).toBeInTheDocument();
    expect(undoToast()).toBeNull();
  });

  it('Schedule send: no Later today from 17:00, no recipient line in the same zone, a time in the past refused', async () => {
    vi.setSystemTime(new Date('2026-11-26T17:10:00.000Z'));
    const u = userEvent.setup();
    const api = stubApi();
    mount({ lead: null, recipientZone: null });
    await u.click(screen.getByRole('button', { name: 'Send options' }));
    const pop = screen.getByRole('dialog', { name: 'Schedule send' });
    expect(within(pop).queryByRole('button', { name: /Later today/ })).toBeNull();
    expect(within(pop).queryByText(/Recipient's time/)).toBeNull();
    await u.clear(within(pop).getByLabelText('Time (24-hour)'));
    await u.type(within(pop).getByLabelText('Time (24-hour)'), '08:00');
    await u.clear(within(pop).getByLabelText('Date'));
    await u.type(within(pop).getByLabelText('Date'), '2026-11-26');
    expect(within(pop).getByText('Choose a time at least a minute from now and within a year.')).toBeInTheDocument();
    expect(within(pop).getByRole('button', { name: 'Schedule' })).toBeDisabled();
    await u.click(within(pop).getByRole('button', { name: /Monday morning/ }));
    await u.click(within(pop).getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(api.sends()).toHaveLength(1));
    expect(api.lastSend()).toMatchObject({ at: '2026-11-30T08:00:00.000Z', followUp: null });
  });

  it('menu: ▾ offers Send and Schedule send…, which opens the Schedule send popover', async () => {
    const u = userEvent.setup();
    stubApi();
    mount({ options: 'menu' });
    await u.click(screen.getByRole('button', { name: 'Send options' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Send', 'Schedule send…']);
    await u.click(within(menu).getByRole('menuitem', { name: 'Schedule send…' }));
    expect(screen.getByRole('dialog', { name: 'Schedule send' })).toBeInTheDocument();
  });

  it('Assigned to lists only me without view_all_leads', async () => {
    const u = userEvent.setup();
    const users = [user(2, 'Arjun Mehta'), user(3, 'Lakshita Singh')];
    stubApi({ me: rep, users });
    mount({}, rep, users);
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    const assignee = within(box).getByLabelText('Assigned to') as HTMLSelectElement;
    expect([...assignee.options].map((o) => o.text)).toEqual(['Me (Arjun Mehta)']);
  });

  it('a custom follow-up before the send time disables Send and add follow-up', async () => {
    const u = userEvent.setup();
    stubApi();
    mount();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    await u.click(within(box).getByRole('radio', { name: /Choose date and time/ }));
    await u.clear(within(box).getByLabelText('Date'));
    await u.type(within(box).getByLabelText('Date'), '2026-11-26');
    await u.clear(within(box).getByLabelText('Time (24-hour)'));
    await u.type(within(box).getByLabelText('Time (24-hour)'), '14:00');
    expect(within(box).getByText('Choose a follow-up time after the email is sent.')).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Send and add follow-up' })).toBeDisabled();
    await u.clear(within(box).getByLabelText('Time (24-hour)'));
    await u.type(within(box).getByLabelText('Time (24-hour)'), '16:00');
    expect(within(box).queryByText('Choose a follow-up time after the email is sent.')).toBeNull();
    expect(box.querySelector('.note.ok')).toHaveTextContent('Added to your Tasks · due Thu 26 Nov 2026, 16:00.');
    expect(within(box).getByRole('button', { name: 'Send and add follow-up' })).toBeEnabled();
  });

  it('a refused send keeps the box open with what was entered and the reason; sending again works', async () => {
    const u = userEvent.setup();
    const api = stubApi({ sendAnswers: [{ status: 400, error: 'follow_up_time' }] });
    mount();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    await u.click(within(box).getByRole('radio', { name: /In 1 week/ }));
    await u.selectOptions(within(box).getByLabelText('Assigned to'), 'Lakshita Singh');
    await u.selectOptions(within(box).getByLabelText('Type'), 'Meeting');
    await u.type(within(box).getByLabelText(/Note/), 'Bring the examples');
    await u.click(within(box).getByRole('button', { name: 'Send and add follow-up' }));
    expect(await within(box).findByRole('alert')).toHaveTextContent('Choose a follow-up time after the email is sent.');
    expect(screen.getByRole('dialog', { name: 'Set the next follow-up' })).toBe(box);
    expect(within(box).getByRole('radio', { name: /In 1 week/ })).toBeChecked();
    expect(within(box).getByLabelText('Assigned to')).toHaveValue('3');
    expect(within(box).getByLabelText('Type')).toHaveValue('meeting');
    expect(within(box).getByLabelText(/Note/)).toHaveValue('Bring the examples');
    expect(undoToast()).toBeNull();
    await u.click(within(box).getByRole('button', { name: 'Send and add follow-up' }));
    await waitFor(() => expect(undoToast()).not.toBeNull());
    expect(api.sends()).toHaveLength(2);
    expect(api.lastSend()).toMatchObject({ followUp: { date: '2026-12-03', assignedToId: 3, kind: 'meeting', note: 'Bring the examples' } });
    expect(screen.queryByRole('dialog', { name: 'Set the next follow-up' })).toBeNull();
  });

  it('a passing failure keeps the box too; a draft gone closes it and says so', async () => {
    const u = userEvent.setup();
    stubApi({ sendAnswers: [{ status: 503, error: 'try_again' }, { status: 409, error: 'draft_gone' }] });
    mount();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    await u.click(within(box).getByRole('button', { name: 'Send and add follow-up' }));
    expect(await within(box).findByRole('alert')).toHaveTextContent('The server is busy. Try again in a moment.');
    await u.click(within(box).getByRole('button', { name: 'Send and add follow-up' }));
    expect(await screen.findByText('This draft was removed in Outlook.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Set the next follow-up' })).toBeNull();
  });

  it('a body over the request limit (Fastify 413, no code of ours) says the message is too long; a server error says try again (M3)', async () => {
    const u = userEvent.setup();
    stubApi({ sendAnswers: [{ status: 413, error: 'Payload Too Large' }, { status: 500, error: 'server_error' }] });
    // The lead page: no flush before Send.
    mount({ lead: null });
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This message is too long to send. Shorten it, or remove large pictures or formatting.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('The server is busy. Try again in a moment.')).toBeInTheDocument();
  });

  it('while the send is being made, Cancel, Esc and the backdrop do not close the box', async () => {
    const u = userEvent.setup();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    stubApi({ sendAnswers: [held] });
    mount();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    await u.click(within(box).getByRole('button', { name: 'Send and add follow-up' }));
    await waitFor(() => expect(within(box).getByRole('button', { name: 'Cancel' })).toBeDisabled());
    await u.keyboard('{Escape}');
    fireEvent.mouseDown(box.parentElement!);
    expect(screen.getByRole('dialog', { name: 'Set the next follow-up' })).toBeInTheDocument();
    release();
    await waitFor(() => expect(undoToast()).not.toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Set the next follow-up' })).toBeNull();
  });

  it('an emptied task title says why Send and add follow-up is off', async () => {
    const u = userEvent.setup();
    stubApi();
    mount();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    await u.clear(within(box).getByLabelText('Task title'));
    expect(within(box).getByText('Enter a title')).toBeInTheDocument();
    expect(within(box).getByLabelText('Task title')).toHaveAttribute('aria-invalid', 'true');
    expect(within(box).getByRole('button', { name: 'Send and add follow-up' })).toBeDisabled();
    await u.type(within(box).getByLabelText('Task title'), 'Call back');
    expect(within(box).queryByText('Enter a title')).toBeNull();
    expect(within(box).getByRole('button', { name: 'Send and add follow-up' })).toBeEnabled();
  });
});
