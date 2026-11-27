import { useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { addDays, formatMoney, localNow, type QuoteCurrency } from '@dait-crm/shared';
import type { LeadPanel as LeadPanelData, MailDetail } from '../../api/mail';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { useFormatDate } from '../../hooks/useFormatDate';
import { initials, leadStatusBadge, leadStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { dayLabel } from './listDates';
import { FollowUpMenu } from './menus';
import type { CommandId, MailTarget, useMailCommands } from './useMailCommands';

type Commands = ReturnType<typeof useMailCommands>;

type Props = {
  /** The reading pane's message (its `leadPanel`, `lead`, `restrictedLead`). */
  m: MailDetail;
  commands: Commands;
  collapsed: boolean;
  onToggle: () => void;
};

/** A linked lead whose panel the answer left out: its rows show "—". */
const EMPTY: LeadPanelData = { company: null, contact: null, owner: null, followUp: null, lastActivity: null, value: null, recent: [], linkReason: null };

/** A recent line's detail: the activity's first line, kept short. */
const firstLine = (body: string | null) => {
  const line = body?.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/** Where a menu opened by a button opens: under it, at its left edge. */
const below = (e: MouseEvent<HTMLButtonElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
};

/**
 * The lead panel beside the reading pane (web-mail release 2, mockup "Lead panel", states 1 and 5). The head: "Lead" and
 * the fold toggle; folded, a rail button `Lead · {number}` opens it again. Open: the company (logo initials, name,
 * `{site} · {place}`), the lead's number and stage, then Contact, Email, Phone, Owner, Next follow-up (red with "· due"
 * when due), Last activity and Value (the live CRM's money format, F35); the actions Open lead, Log as activity, Create
 * task, Set follow-up (the Follow-up menu) and Add contact (release 2B-2's, the company's Contacts tab); the lead's
 * three newest activities and why the message is linked. Another owner's lead: its company and number only, no actions.
 * No lead: "No lead linked" with Link to lead ▾. The HTML frame follows its own body size (MailBody), so folding the
 * panel refits it.
 */
export function LeadPanel({ m, commands, collapsed, onToggle }: Props) {
  const t = useT();
  const me = useCurrentUser();
  const { dateTime, relative } = useFormatDate();
  const [followAt, setFollowAt] = useState<{ x: number; y: number } | null>(null);

  const number = m.lead?.number ?? m.restrictedLead?.number ?? m.leadNumber;
  const toggleName = collapsed ? t('Expand lead panel') : t('Collapse lead panel');
  const target: MailTarget = { ids: [m.id], item: m };

  const action = (cmd: CommandId, icon: ReactNode, text: string, onClick?: (e: MouseEvent<HTMLButtonElement>) => void) => {
    const s = commands.state(cmd, target);
    return (
      <button type="button" className="btn" disabled={!s.enabled} title={s.title} onClick={onClick ?? (() => commands.run(cmd, target))}>
        <span className="ico" aria-hidden="true">{icon}</span>
        {text}
      </button>
    );
  };

  const body = () => {
    if (m.restrictedLead) {
      return (
        <div className="lp-co">
          <span className="logo" aria-hidden="true">{initials(m.restrictedLead.companyName)}</span>
          <div className="lp-co-t">
            <b>{m.restrictedLead.companyName}</b>
            <small>{t("{lead} · another owner's lead", { lead: m.restrictedLead.number })}</small>
          </div>
        </div>
      );
    }
    if (m.leadId === null) {
      return (
        <>
          <div className="lp-link">{t('No lead linked')}</div>
          <div className="lp-acts">
            {action('link', Icons.link, t('Link to lead ▾'), (e) => commands.run('link', target, below(e)))}
          </div>
        </>
      );
    }

    const p = m.leadPanel ?? EMPTY;
    const companyName = p.company?.name ?? m.company?.name ?? '—';
    const companyId = p.company?.id ?? m.lead?.companyId ?? m.company?.id ?? null;
    const status = m.lead?.status ?? m.leadStatus;
    const today = localNow(me.timezone).day;
    const followDay = (day: string) => (day === today ? t('Today') : day === addDays(today, 1) ? t('Tomorrow') : dayLabel(day, me.language));
    const follow = p.followUp
      ? `${followDay(p.followUp.date)}${p.followUp.time ? `, ${p.followUp.time}` : ''}${p.followUp.due ? ` · ${t('due')}` : ''}`
      : '—';
    const reason = p.linkReason
      ? p.linkReason.kind === 'domain'
        ? t('Linked automatically: {value} belongs to this lead.', { value: p.linkReason.value })
        : t('Linked automatically: {value} is on this lead.', { value: p.linkReason.value })
      : null;

    return (
      <>
        <div className="lp-co">
          <span className="logo" aria-hidden="true">{initials(companyName)}</span>
          <div className="lp-co-t">
            <b>{companyName}</b>
            {p.company && (p.company.site || p.company.place) ? <small>{[p.company.site, p.company.place].filter(Boolean).join(' · ')}</small> : null}
          </div>
        </div>
        <div className="lp-badges">
          {number ? <span className="badge b-grey">{number}</span> : null}
          {status ? <span className={leadStatusBadge(status)}>{leadStatusText(t, status)}</span> : null}
        </div>
        <dl className="lp-kv">
          <dt>{t('Contact')}</dt>
          <dd>
            {p.contact ? (
              <>
                {p.contact.name}
                {p.contact.role ? <span className="lp-role">{p.contact.role}</span> : null}
              </>
            ) : '—'}
          </dd>
          {p.contact?.email ? (
            <>
              <dt>{t('Email')}</dt>
              <dd><a href={`mailto:${p.contact.email}`}>{p.contact.email}</a></dd>
            </>
          ) : null}
          {p.contact?.phone ? (
            <>
              <dt>{t('Phone')}</dt>
              <dd>{p.contact.phone}</dd>
            </>
          ) : null}
          <dt>{t('Owner')}</dt>
          <dd>{p.owner ?? '—'}</dd>
          <dt>{t('Next follow-up')}</dt>
          <dd className={p.followUp?.due ? 'due' : undefined}>{follow}</dd>
          <dt>{t('Last activity')}</dt>
          <dd>{p.lastActivity ? `${p.lastActivity.title} · ${dateTime(p.lastActivity.occurredAt)}` : '—'}</dd>
          <dt>{t('Value')}</dt>
          <dd>{p.value ? formatMoney(p.value.amount, p.value.currency as QuoteCurrency) : '—'}</dd>
        </dl>
        <div className="lp-acts">
          <Link className="btn primary" to={`/leads/${m.leadId}`}>
            <span className="ico" aria-hidden="true">{Icons.external}</span>
            {t('Open lead')}
          </Link>
          {action('log', Icons.activity, t('Log as activity'))}
          {action('task', Icons.task, t('Create task'))}
          {action('followUp', Icons.followup, t('Set follow-up'), (e) => setFollowAt(below(e)))}
          {companyId ? (
            <Link className="btn" to={`/companies/${companyId}?tab=contacts`}>
              <span className="ico" aria-hidden="true">{Icons.user}</span>
              {t('Add contact')}
            </Link>
          ) : null}
        </div>
        {p.recent.length ? (
          <>
            <div className="lp-sec" id="lp-recent">{t('Recent on the lead')}</div>
            <ul className="lp-tl" aria-labelledby="lp-recent">
              {p.recent.map((a) => (
                <li key={a.id}>
                  <i aria-hidden="true" />
                  <span>
                    {a.title}
                    <small>{[firstLine(a.body), relative(a.occurredAt)].filter(Boolean).join(' · ')}</small>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {reason ? <div className="lp-link">{reason}</div> : null}
      </>
    );
  };

  return (
    <aside className={collapsed ? 'lpanel collapsed' : 'lpanel'} aria-label={t('Lead')}>
      <div className="lp-head">
        <h3>{t('Lead')}</h3>
        <button type="button" className="icon-btn lp-toggle" aria-label={toggleName} title={toggleName} onClick={onToggle}>
          {Icons.dblr}
        </button>
        {collapsed ? (
          <button type="button" className="lp-rail" onClick={onToggle}>
            {number ? t('Lead · {number}', { number }) : t('Lead')}
          </button>
        ) : null}
      </div>
      {collapsed ? null : <div className="lp-scroll">{body()}</div>}
      {followAt ? <FollowUpMenu at={followAt} target={target} commands={commands} onClose={() => setFollowAt(null)} /> : null}
    </aside>
  );
}
