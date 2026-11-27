import { Link } from 'react-router-dom';
import { addDays, formatMoney, localNow, type QuoteCurrency } from '@dait-crm/shared';
import type { LeadFull } from '../../../api/leads';
import type { LeadPanel } from '../../../api/mail';
import { useCurrentUser } from '../../../api/useCurrentUser';
import { Icons } from '../../../components/Icons';
import { useFormatDate } from '../../../hooks/useFormatDate';
import { initials, leadStatusBadge, leadStatusText } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';
import { dayLabel } from '../listDates';

/** How many of the lead's newest activities the summary lists (mockup: two). */
const RECENT = 2;

/** A recent line's detail: the activity's first line, kept short. */
const firstLine = (body: string | null) => {
  const line = body?.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

type Props = {
  /** The chosen lead (null: none). */
  leadId: number | null;
  /** The lead as the lead page reads it (number, stage, company, contact, owner, newest activities). */
  lead: LeadFull | undefined;
  /** The draft's lead panel for this lead (site and place, follow-up time, value); null while not known. */
  panel: LeadPanel | null;
};

/**
 * The right column of the New message page (mockup `.cp-lead`, "Chosen lead"): `Lead for this email`, the company
 * (logo initials, name, `{site} · {place}`), the lead's number and stage, Contact, Owner, Next follow-up, Last activity,
 * Value, `Recent on the lead` (the two newest) and `Open lead`. Without a lead: `No lead chosen` and why to choose one.
 * The panel's figures (follow-up time, value) are the reading pane's; until it is known the lead's own fields stand in.
 */
export function ComposeLeadSummary({ leadId, lead, panel }: Props) {
  const t = useT();
  const me = useCurrentUser();
  const { dateTime, relative } = useFormatDate();

  if (leadId === null) {
    return (
      <aside className="cp-lead" aria-label={t('Chosen lead')}>
        <div className="lp-sec">{t('Lead for this email')}</div>
        <div className="cp-none">
          <b>{t('No lead chosen')}</b>
          <span>{t('Choose a lead to file this email on its timeline.')}</span>
        </div>
      </aside>
    );
  }

  const companyName = panel?.company?.name ?? lead?.companyName ?? '—';
  const site = panel?.company ? panel.company.site : lead?.company?.domain ?? lead?.website ?? null;
  const place = panel?.company ? panel.company.place : [lead?.city, lead?.country].filter(Boolean).join(', ') || null;
  const contact = panel?.contact ?? (lead?.contact ? { name: lead.contact.name, role: lead.contact.designation } : null);
  const owner = panel ? panel.owner : lead?.assignedTo?.name ?? null;
  const today = localNow(me.timezone).day;
  const followDay = (day: string) => (day === today ? t('Today') : day === addDays(today, 1) ? t('Tomorrow') : dayLabel(day, me.language));
  const followUp = panel ? panel.followUp : lead?.nextFollowUp ? { date: lead.nextFollowUp, time: null, due: lead.isOverdue } : null;
  const follow = followUp ? `${followDay(followUp.date)}${followUp.time ? `, ${followUp.time}` : ''}${followUp.due ? ` · ${t('due')}` : ''}` : '—';
  const last = panel ? panel.lastActivity : lead?.activities[0] ? { title: lead.activities[0].title, occurredAt: lead.activities[0].occurredAt } : null;
  const recent = (panel ? panel.recent : lead?.activities ?? []).slice(0, RECENT);

  return (
    <aside className="cp-lead" aria-label={t('Chosen lead')}>
      <div className="lp-sec">{t('Lead for this email')}</div>
      <div className="lp-co">
        <span className="logo" aria-hidden="true">{initials(companyName)}</span>
        <div className="lp-co-t">
          <b>{companyName}</b>
          {site || place ? <small>{[site, place].filter(Boolean).join(' · ')}</small> : null}
        </div>
      </div>
      {lead ? (
        <div className="lp-badges">
          <span className="badge b-grey">{lead.number}</span>
          <span className={leadStatusBadge(lead.status)}>{leadStatusText(t, lead.status)}</span>
        </div>
      ) : null}
      <dl className="lp-kv">
        <dt>{t('Contact')}</dt>
        <dd>
          {contact ? (
            <>
              {contact.name}
              {contact.role ? <span className="lp-role">{contact.role}</span> : null}
            </>
          ) : '—'}
        </dd>
        <dt>{t('Owner')}</dt>
        <dd>{owner ?? '—'}</dd>
        <dt>{t('Next follow-up')}</dt>
        <dd className={followUp?.due ? 'due' : undefined}>{follow}</dd>
        <dt>{t('Last activity')}</dt>
        <dd>{last ? `${last.title} · ${dateTime(last.occurredAt)}` : '—'}</dd>
        <dt>{t('Value')}</dt>
        <dd>{panel?.value ? formatMoney(panel.value.amount, panel.value.currency as QuoteCurrency) : '—'}</dd>
      </dl>
      {recent.length ? (
        <>
          <div className="lp-sec" id="cp-recent">{t('Recent on the lead')}</div>
          <ul className="lp-tl" aria-labelledby="cp-recent">
            {recent.map((a) => (
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
      <Link className="btn sm cp-open" to={`/leads/${leadId}`}>
        <span className="ico" aria-hidden="true">{Icons.external}</span>
        {t('Open lead')}
      </Link>
    </aside>
  );
}
