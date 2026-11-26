import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEAD_TYPES, PRIORITIES, isClosedStatus, type ClosedStatus, type LeadType, type Priority } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useLeadAction, useRefreshWhenOutOfDate, useSaveLead, type LeadFull } from '../../api/leads';
import type { LookupValue } from '../../api/queries';
import { useSaveTask, type TaskRow } from '../../api/tasks';
import { useCurrentUser } from '../../api/useCurrentUser';
import { useLeadEmails, type LeadEmail } from '../../api/leadEmails';
import { Tabs } from '../../components/Tabs';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText, leadStatusText, leadTypeText, priorityText, taskWhenText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';
import { useConfirm } from '../../components/ConfirmDialog';
import { TaskModal } from '../tasks/TaskModal';
import { CloseLeadModal } from './CloseLeadModal';
import { Timeline } from './Timeline';
import { TransferModal, UnassignModal } from './TransferModal';
import { useActionError } from './staleToast';
import { taskTitle } from '../../i18n/systemText';

/** YYYY-MM-DD `days` from today (browser local date, as the date input shows it). */
export function localDayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const SHOWN_TASKS = 2;

type Props = { lead: LeadFull; statuses: LookupValue[]; live: boolean };

/**
 * The prototype's bottom card on the lead page: tabs Follow-up / Emails (release 2) / Calls. Follow-up holds the
 * lead controls: next follow-up (date, badge), priority, type; Owner (transfer / unassign / claim); status; open tasks.
 * Calls shows the lead's activity history (calls, status changes, transfers, notes).
 */
export function FollowUpPanel({ lead, statuses, live }: Props) {
  const t = useT();
  const [tab, setTab] = useState('followup');
  const me = useCurrentUser();
  // Your own emails with this lead; Administrators and Managers also see the team's (web-mail release 1, view only).
  const { data: emails } = useLeadEmails(lead.id, me.can('use_email'));
  return (
    <section className="card flush l2tl" aria-label={t('Follow-up and history')}>
      <Tabs
        label={t('Follow-up, emails and calls')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'followup', label: t('Follow-up'), count: lead.tasks.length },
          { id: 'email', label: t('Emails'), count: emails?.length ?? 0 },
          { id: 'call', label: t('Calls'), count: lead.callCount ?? 0 },
        ]}
        panelClassName="l2tlb"
      >
        {tab === 'followup' ? <FollowUpControls lead={lead} statuses={statuses} live={live} /> : null}
        {tab === 'email' ? <EmailList emails={emails ?? []} /> : null}
        {tab === 'call' ? <Timeline lead={lead} framed={false} /> : null}
      </Tabs>
    </section>
  );
}

function FollowUpControls({ lead, statuses, live }: Props) {
  const t = useT();
  const toast = useToast();
  const onFail = useActionError();
  const save = useSaveLead();
  const action = useLeadAction();
  const saveTask = useSaveTask();
  const refreshIfOutOfDate = useRefreshWhenOutOfDate();
  const confirm = useConfirm();
  const { day } = useFormatDate();
  const [date, setDate] = useState(lead.nextFollowUp ?? '');
  const [addTask, setAddTask] = useState(false);
  const me = useCurrentUser();
  const [closing, setClosing] = useState<ClosedStatus | null>(null);
  const [dialog, setDialog] = useState<'transfer' | 'unassign' | null>(null);
  // The date last sent: a blur right after a quick button must not send it again (with a stale stamp).
  const sent = useRef<string | null>(null);
  useEffect(() => {
    setDate(lead.nextFollowUp ?? '');
    sent.current = null;
  }, [lead.nextFollowUp]);

  const closed = isClosedStatus(lead.status);
  const busy = save.isPending || action.isPending;
  const today = localDayPlus(0);
  const badge = lead.isOverdue
    ? <span className="badge b-bad">{t('Overdue')}</span>
    : lead.nextFollowUp === today
      ? <span className="badge b-purple">{t('Today')}</span>
      : lead.nextFollowUp
        ? <span className="badge b-purple">{t('Scheduled')}</span>
        : null;

  function patch(body: { nextFollowUp?: string | null; priority?: Priority; leadType?: LeadType }, done: string) {
    save.mutate(
      { id: lead.id, body: { ...body, updatedAt: lead.updatedAt } },
      {
        onSuccess: () => toast(done),
        onError: (err) => {
          sent.current = null;
          onFail(err, true);
        },
      },
    );
  }

  /** Saves a typed or picked date. An empty value (a half-edited input) is never sent: Clear is the only way to clear. */
  function commitDate(value: string) {
    if (!value || value === (lead.nextFollowUp ?? '') || value === sent.current) return;
    sent.current = value;
    patch({ nextFollowUp: value }, t('Follow-up set'));
  }

  async function clearDate() {
    const ok = await confirm({
      title: t('Clear follow-up?'),
      body: t('{number} will have no next follow-up date.', { number: lead.number }),
      confirmLabel: t('Clear'),
    });
    if (!ok) {
      setDate(lead.nextFollowUp ?? '');
      return;
    }
    sent.current = '';
    patch({ nextFollowUp: null }, t('Follow-up cleared'));
  }

  function tick(task: TaskRow) {
    saveTask.mutate(
      { id: task.id, body: { isDone: true, updatedAt: task.updatedAt } },
      {
        onSuccess: () => toast(t('Task done')),
        onError: (err) => {
          refreshIfOutOfDate(err);
          toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn');
        },
      },
    );
  }

  const statusOptions = statuses
    .filter((s) => s.isActive || s.value === lead.status)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const dateOff = !live || closed || busy;

  return (
    <div className="ctrl l2fu">
      <div role="group" aria-labelledby="fu-date-l" className="fu-date">
        <label className="l" id="fu-date-l" htmlFor="fu-date">
          {t('Next follow-up')}
        </label>
        <div className="fu-row">
          <input
            id="fu-date"
            type="date"
            className={lead.isOverdue ? 'in err' : 'in'}
            value={date}
            disabled={dateOff}
            title={closed ? t('A closed lead has no follow-up') : undefined}
            onChange={(e) => setDate(e.target.value)}
            onBlur={() => {
              // An emptied date clears the follow-up after a confirm; a half-typed one is never sent.
              if (!date) {
                if (lead.nextFollowUp) void clearDate();
              } else commitDate(date);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDate(date);
            }}
          />
          {badge}
        </div>
      </div>
      <div>
        <label className="l" htmlFor="fu-priority">
          {t('Priority')}
        </label>
        <select
          id="fu-priority"
          className="in"
          value={lead.priority}
          disabled={!live || busy}
          onChange={(e) => patch({ priority: e.target.value as Priority }, t('Priority changed'))}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {priorityText(t, p)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="l" htmlFor="fu-type">
          {t('Type')}
        </label>
        <select
          id="fu-type"
          className="in"
          value={lead.leadType}
          disabled={!live || busy}
          onChange={(e) => patch({ leadType: e.target.value as LeadType }, t('Type changed'))}
        >
          {LEAD_TYPES.map((x) => (
            <option key={x} value={x}>
              {leadTypeText(t, x)}
            </option>
          ))}
        </select>
      </div>
      <div role="group" aria-labelledby="fu-owner-l" className="fu-owner">
        <span className="l" id="fu-owner-l">
          {t('Owner')}
        </span>
        <div className="fu-row">
          <span className="fu-owner-name">{lead.assignedTo?.name ?? t('Unassigned')}</span>
          {live && me.can('transfer_leads') ? (
            <button type="button" className="btn xs" onClick={() => setDialog('transfer')}>
              {t('Transfer')}
            </button>
          ) : null}
          {live && me.can('view_all_leads') && lead.assignedTo ? (
            <button type="button" className="btn xs" onClick={() => setDialog('unassign')}>
              {t('Unassign')}
            </button>
          ) : null}
          {live && me.can('claim_leads') && !lead.assignedTo ? (
            <button
              type="button"
              className="btn xs primary"
              disabled={busy}
              onClick={() =>
                action.mutate(
                  { lead, action: 'claim', body: {} },
                  { onSuccess: () => toast(t('{number} is now yours', { number: lead.number })), onError: (err) => onFail(err, true) },
                )
              }
            >
              {t('Claim')}
            </button>
          ) : null}
        </div>
      </div>
      <div className="fu-status">
        <label className="l" htmlFor="fu-status">
          {t('Status')}
        </label>
        <select
          id="fu-status"
          className="in"
          value={lead.status}
          disabled={!live || busy}
          onChange={(e) => {
            const next = e.target.value;
            // Closing statuses go through Close lead (Won confirms the client flag; Lost / Not Relevant need a reason).
            if (isClosedStatus(next)) {
              setClosing(next as ClosedStatus);
              return;
            }
            action.mutate(
              { lead, action: 'status', body: { status: next } },
              {
                onSuccess: () => toast(t('Status changed to {status}', { status: leadStatusText(t, next) })),
                onError: (err) => onFail(err, true),
              },
            );
          }}
        >
          {statusOptions.map((s) => (
            // On a closed lead the other closed statuses wait until it is reopened (as before the Status row moved here).
            <option key={s.value} value={s.value} disabled={closed && isClosedStatus(s.value) && s.value !== lead.status}>
              {leadStatusText(t, s.value)}
            </option>
          ))}
        </select>
      </div>
      <section className="fu-tasks" aria-labelledby="fu-tasks-l">
        <span className="l" id="fu-tasks-l">
          {t('Open tasks')}
        </span>
        <div className="fu-list">
          {lead.tasks.length === 0 ? <span className="dim">{t('No open tasks')}</span> : null}
          {lead.tasks.slice(0, SHOWN_TASKS).map((task) => {
            const when = taskWhenText(t, task);
            return (
              <label key={task.id} className="fu-task">
                <input type="checkbox" checked={false} disabled={saveTask.isPending} onChange={() => tick(task)} />
                <span className="fu-t">{taskTitle(t, task.title)}</span>
                {when ? <span className="fu-due">{when}</span> : null}
                <span className={task.isOverdue ? 'fu-due overdue' : 'fu-due'}>{day(task.dueDate)}</span>
              </label>
            );
          })}
          {lead.tasks.length > SHOWN_TASKS ? (
            <Link to="/tasks" className="fu-more">
              {t('+{n} more', { n: lead.tasks.length - SHOWN_TASKS })}
            </Link>
          ) : null}
          {live ? (
            <button type="button" className="btn xs" onClick={() => setAddTask(true)}>
              {t('+ Task')}
            </button>
          ) : null}
        </div>
      </section>
      {addTask ? <TaskModal lead={lead} onClose={() => setAddTask(false)} /> : null}
      {closing ? <CloseLeadModal lead={lead} initialStatus={closing} onClose={() => setClosing(null)} /> : null}
      {dialog === 'transfer' ? <TransferModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'unassign' ? <UnassignModal lead={lead} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

/** Your emails with this lead, newest first; open one to read it. */
function EmailList({ emails }: { emails: LeadEmail[] }) {
  const t = useT();
  const { date } = useFormatDate();
  if (emails.length === 0) return <div className="empty">{t('No emails yet')}</div>;
  const status = (m: LeadEmail) =>
    m.status === 'received' ? (
      <span className="badge b-purple">{t('Received')}</span>
    ) : m.status === 'sent' ? (
      <span className="badge b-ok">{t('Sent')}</span>
    ) : m.status === 'failed' ? (
      <span className="badge b-bad" title={m.lastError ?? undefined}>
        {t('Failed')}
      </span>
    ) : (
      <span className="badge b-purple">{t('Sending')}</span>
    );
  return (
    <ul className="mail-list" aria-label={t('Emails')}>
      {emails.map((m) => (
        <li key={m.id} className="mail-item">
          <details>
            <summary>
              <span className="mail-subject">{m.subject}</span>
              {status(m)}
              <span className="mail-meta">
                {m.status === 'received' ? t('From {from}', { from: m.fromAddress }) : t('To {to}', { to: m.toAddresses.join(', ') })}
                {m.ccAddresses.length ? ` · ${t('cc {cc}', { cc: m.ccAddresses.join(', ') })}` : ''} · {date(m.occurredAt)}
                {m.ownerName ? ` · ${t("{name}'s mailbox", { name: m.ownerName })}` : ''}
              </span>
            </summary>
            <pre className="mail-body">{m.bodyText}</pre>
            {m.status === 'failed' && m.lastError ? <div className="note warn">{failureText(t, m.lastError)}</div> : null}
          </details>
        </li>
      ))}
    </ul>
  );
}

function failureText(t: TFn, code: string): string {
  if (code === 'mailbox_needs_reconnect') return t('Your mailbox needs reconnecting in Settings → Email & calendar connections, then send again.');
  if (code === 'mailbox_not_connected') return t('Your mailbox was not connected when this was sent. Connect it in Settings and send again.');
  return t('Microsoft 365 did not accept this email: {reason}', { reason: code });
}
