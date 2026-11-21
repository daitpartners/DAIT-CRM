import { Link } from 'react-router-dom';
import { isClosedStatus, safeUrl } from '@dait-crm/shared';
import type { LeadFull } from '../../api/leads';
import { useLookupText } from '../../api/queries';
import { PlaceholderCard } from '../../components/PlaceholderCard';
import { useFormatDate } from '../../hooks/useFormatDate';
import { verificationBadge, verificationText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';


/**
 * Right column of the lead page (prototype order): company card, Skills & languages, Projects (release 3),
 * Coming up (next follow-up and open tasks) and Original enquiry (release 1D).
 */
export function SideColumn({ lead, onEditSkills }: { lead: LeadFull; onEditSkills?: () => void }) {
  const t = useT();
  const p = lead.contact;
  return (
    <aside className="col-side" aria-label={t('Company and contact')}>
      {lead.company ? <CompanyCard lead={lead} /> : null}
      {p ? (
        <section className="card side-card" aria-labelledby="lead-sk-title">
          <div className="card-head">
            <h2 id="lead-sk-title">{t('Skills & languages')}</h2>
            {onEditSkills ? (
              <button type="button" className="btn xs" onClick={onEditSkills} aria-label={t('Edit skills & languages')}>
                {t('Edit')}
              </button>
            ) : null}
          </div>
          <div className="sks" aria-label={t('Skills')}>
            {(p.skills ?? []).length ? (p.skills ?? []).map((s) => <span key={s} className="sk">{s}</span>) : <span className="dim">{t('No skills yet')}</span>}
          </div>
          <div className="sks" aria-label={t('Languages')}>
            {(p.languages ?? []).length ? (
              (p.languages ?? []).map((s) => <span key={s} className="sk lang">{s}</span>)
            ) : (
              <span className="dim">{t('No languages yet')}</span>
            )}
          </div>
        </section>
      ) : null}
      <PlaceholderCard title={t('Projects')} release="3" hint={t('Projects unlock when a lead at this company is won or a quotation is accepted.')} />
      <ComingUp lead={lead} />
      <PlaceholderCard title={t('Original enquiry')} release="1D" hint={t('The website enquiry this lead came from appears here.')} />
    </aside>
  );
}

function CompanyCard({ lead }: { lead: LeadFull }) {
  const t = useT();
  const lookup = useLookupText(useLang());
  const c = lead.company!;
  const website = safeUrl(c.website);
  const place = [c.city, lookup('country', c.country)].filter(Boolean).join(', ');
  const line = [
    lookup('industry', c.industry) ?? t('Industry unknown'),
    place,
    c.employeeRange ? t('{range} staff', { range: lookup('employee_range', c.employeeRange) ?? c.employeeRange }) : '',
  ].filter(Boolean).join(' · ');
  // openLeadCount counts this lead too while it is open.
  const others = Math.max(0, c.openLeadCount - (lead.archivedAt === null && !isClosedStatus(lead.status) ? 1 : 0));
  return (
    <section className="card side-card" aria-labelledby="lead-co-title">
      <div>
        <h2 id="lead-co-title" className="co-name">
          <Link to={`/companies/${c.id}`}>{c.legalName || c.name}</Link>
        </h2>
        <div className="co-line">{line}</div>
      </div>
      <div className="note ai ph-inline" aria-disabled="true">
        <strong>{t('AI summary')}</strong> <span className="ph-note">{t('Available in release 4')}</span>
      </div>
      <div className="co-links">
        {c.verificationStatus ? <span className={verificationBadge(c.verificationStatus)}>{verificationText(t, c.verificationStatus)}</span> : null}
        {website ? (
          <a href={website} target="_blank" rel="noopener noreferrer">
            {c.domain ?? website.replace(/^https?:\/\//, '')} ↗
          </a>
        ) : null}
        <span>{others === 1 ? t('1 other open lead') : t('{n} other open leads', { n: others })}</span>
        <Link to={`/companies/${c.id}`}>{t('Full profile →')}</Link>
      </div>
    </section>
  );
}

/** Next follow-up and the open tasks, soonest first. */
function ComingUp({ lead }: { lead: LeadFull }) {
  const t = useT();
  const { day } = useFormatDate();
  const items = [
    ...(lead.nextFollowUp ? [{ key: 'fu', title: t('Follow-up · {number}', { number: lead.number }), due: lead.nextFollowUp, over: lead.isOverdue }] : []),
    ...lead.tasks
      .filter((task) => task.origin !== 'follow_up' || task.dueDate !== lead.nextFollowUp)
      .map((task) => ({ key: `t${task.id}`, title: task.title, due: task.dueDate, over: task.isOverdue })),
  ].sort((a, b) => a.due.localeCompare(b.due));
  return (
    <section className="card side-card" aria-labelledby="lead-up-title">
      <h2 id="lead-up-title">{t('Coming up')}</h2>
      {items.length === 0 ? (
        <span className="dim">{t('Nothing scheduled')}</span>
      ) : (
        <ul className="up-list">
          {items.map((i) => (
            <li key={i.key} className="link">
              <span>{i.title}</span>
              <span className={i.over ? 'overdue' : 'dim'}>{day(i.due)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
