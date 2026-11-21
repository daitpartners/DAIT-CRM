import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { safeUrl } from '@dait-crm/shared';
import type { LeadFull } from '../../api/leads';
import { useLookupText } from '../../api/queries';
import { PriorityLabel } from '../../components/StatusBadge';
import { useFormatDate } from '../../hooks/useFormatDate';
import { leadTypeText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';

/** `<dt>` / `<dd>` pair; an empty value shows a dash. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <>
      <dt>{label}</dt>
      <dd className={empty ? 'null' : undefined}>{empty ? '—' : children}</dd>
    </>
  );
}

/** A link only when the value makes a safe URL; otherwise the plain text. */
function SafeLink({ href, text, external }: { href: string | null; text: string; external?: boolean }) {
  const url = safeUrl(href);
  if (!url) return <>{text}</>;
  return external ? (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  ) : (
    <a href={url}>{text}</a>
  );
}

/** Left column of the lead page: company card, contact card, lead facts and open tasks. */
export function ProfileBox({ lead }: { lead: LeadFull }) {
  const t = useT();
  const lang = useLang();
  const lookup = useLookupText(lang);
  const { date, day } = useFormatDate();
  const c = lead.company;
  const p = lead.contact;

  return (
    <>
      {c ? (
        <section className="card" aria-labelledby="lead-co-title">
          <h2 id="lead-co-title" className="card-title">
            {t('Company')}
          </h2>
          <div>
            <Link to={`/companies/${c.id}`}>
              <strong>{c.name}</strong>
            </Link>
            <span className="cell-sub">
              {c.number}
              {c.isClient ? (
                <>
                  {' · '}
                  <span className="badge b-ok">{t('Client')}</span>
                </>
              ) : null}
            </span>
          </div>
          <dl className="kv">
            <Fact label={t('Industry')}>{lookup('industry', c.industry)}</Fact>
            <Fact label={t('Location')}>{[c.city, lookup('country', c.country)].filter(Boolean).join(', ')}</Fact>
            <Fact label={t('Employees')}>{lookup('employee_range', c.employeeRange)}</Fact>
            <Fact label={t('Contacts')}>{c.contactCount}</Fact>
            <Fact label={t('Open leads')}>{c.openLeadCount}</Fact>
          </dl>
        </section>
      ) : null}

      <section className="card" aria-labelledby="lead-ct-title">
        <h2 id="lead-ct-title" className="card-title">
          {t('Contact person')}
        </h2>
        {p ? (
          <>
            <div>
              <strong>{p.name}</strong>
              {p.designation ? <span className="cell-sub">{p.designation}</span> : null}
              {!p.isActive ? (
                <span className="cell-sub">
                  <span className="badge b-grey">{t('Inactive|contact')}</span>
                </span>
              ) : null}
            </div>
            <dl className="kv">
              <Fact label={t('Email')}>{p.email ? <SafeLink href={`mailto:${p.email}`} text={p.email} /> : null}</Fact>
              <Fact label={t('Phone')}>{p.phone ? <SafeLink href={`tel:${p.phone}`} text={p.phone} /> : null}</Fact>
              <Fact label={t('Mobile')}>{p.mobile ? <SafeLink href={`tel:${p.mobile}`} text={p.mobile} /> : null}</Fact>
              <Fact label={t('LinkedIn')}>{p.linkedinUrl ? <SafeLink href={p.linkedinUrl} text={t('Profile')} external /> : null}</Fact>
            </dl>
          </>
        ) : (
          <div className="dim">{t('No contact yet')}</div>
        )}
      </section>

      <section className="card" aria-labelledby="lead-facts-title">
        <h2 id="lead-facts-title" className="card-title">
          {t('Lead details')}
        </h2>
        <dl className="kv">
          <Fact label={t('Lead ID')}>{lead.number}</Fact>
          <Fact label={t('Lead type')}>{leadTypeText(t, lead.leadType)}</Fact>
          <Fact label={t('Priority')}>
            <PriorityLabel priority={lead.priority} />
          </Fact>
          <Fact label={t('Next follow-up')}>
            {lead.nextFollowUp ? (
              <span className={lead.isOverdue ? 'overdue' : undefined}>
                {lead.isOverdue ? t('{date} · overdue', { date: day(lead.nextFollowUp) }) : day(lead.nextFollowUp)}
              </span>
            ) : null}
          </Fact>
          <Fact label={t('Lead source')}>{lookup('lead_source', lead.leadSource)}</Fact>
          <Fact label={t('Source URL')}>{lead.sourceUrl ? <SafeLink href={lead.sourceUrl} text={lead.sourceUrl} external /> : null}</Fact>
          <Fact label={t('Website')}>{lead.website ? <SafeLink href={lead.website} text={lead.website} external /> : null}</Fact>
          <Fact label={t('Business email')}>
            {lead.businessEmail ? <SafeLink href={`mailto:${lead.businessEmail}`} text={lead.businessEmail} /> : null}
          </Fact>
          <Fact label={t('Phone number')}>{lead.phone ? <SafeLink href={`tel:${lead.phone}`} text={lead.phone} /> : null}</Fact>
          <Fact label={t('Country')}>{[lead.city, lookup('country', lead.country)].filter(Boolean).join(', ')}</Fact>
          <Fact label={t('Created')}>
            {lead.createdBy ? t('{date} by {name}', { date: date(lead.createdAt), name: lead.createdBy.name }) : date(lead.createdAt)}
          </Fact>
          {lead.importBatch ? <Fact label={t('Import batch')}>{lead.importBatch}</Fact> : null}
        </dl>
        {lead.notes ? <div className="pre note info">{lead.notes}</div> : null}
      </section>

      <section className="card" aria-labelledby="lead-tasks-title">
        <h2 id="lead-tasks-title" className="card-title">
          {t('Open tasks')}
        </h2>
        {lead.tasks.length === 0 ? (
          <div className="dim">{t('No open tasks')}</div>
        ) : (
          <ul className="task-list flat">
            {lead.tasks.map((task) => (
              <li key={task.id} className={task.isOverdue ? 'task over' : 'task'}>
                <div>
                  <strong>{task.title}</strong>
                  <div className="m">
                    {t('Due {date}', { date: day(task.dueDate) })} · {task.assignedTo.name}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
