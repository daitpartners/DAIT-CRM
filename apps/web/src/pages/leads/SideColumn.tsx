import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { isClosedStatus, safeUrl } from '@dait-crm/shared';
import { useLeadAction, useRefreshWhenOutOfDate, type LeadFull } from '../../api/leads';
import { keys, useLookupText } from '../../api/queries';
import { isResearchQueued } from '../../api/research';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { researchStatusBadge, researchStatusText, verificationBadge, verificationText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { useResearchRunner } from '../companies/AiCard';
import { ContactModal } from '../companies/ContactModal';
import { ProjectsCard } from '../projects/ProjectsCard';


/**
 * Right column of the lead page, in the prototype's order (views-leads2.js): without a contact the "No contact yet"
 * card, then the company card; with a contact, Skills & languages; Projects; Coming up (only when something is
 * scheduled). Original enquiry appears once leads come from enquiries (1D).
 */
export function SideColumn({ lead, live, onEditSkills }: { lead: LeadFull; live: boolean; onEditSkills?: () => void }) {
  const t = useT();
  const p = lead.contact;
  return (
    <aside className="col-side" aria-label={t('Company and contact')}>
      {!p ? <NoContactCard lead={lead} live={live} /> : null}
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
      {lead.companyId !== null ? <ProjectsCard companyId={lead.companyId} leadId={lead.id} /> : null}
      <ComingUp lead={lead} />
    </aside>
  );
}

/** Prototype contact card without a contact: "No contact yet" + Add contact (adds one to the company and links it). */
function NoContactCard({ lead, live }: { lead: LeadFull; live: boolean }) {
  const t = useT();
  const toast = useToast();
  const refreshIfOutOfDate = useRefreshWhenOutOfDate();
  const action = useLeadAction();
  const [adding, setAdding] = useState(false);
  return (
    <section className="card side-card" aria-labelledby="lead-nc-title">
      <div className="card-head">
        <h2 id="lead-nc-title" className="side-title">
          {t('No contact yet')}
        </h2>
        {live ? (
          <button
            type="button"
            className="btn sm primary"
            onClick={() => {
              if (lead.companyId === null) {
                toast(t('Choose the company for this lead first, above.'), 'warn');
                document.getElementById('lead-resolve-company')?.focus();
              } else setAdding(true);
            }}
          >
            {t('Add contact')}
          </button>
        ) : null}
      </div>
      {adding && lead.companyId !== null ? (
        <ContactModal
          companyId={lead.companyId}
          onClose={() => setAdding(false)}
          onSaved={(c) =>
            action.mutate(
              { lead, action: 'contact', body: { contactId: c.id } },
              {
                onSuccess: () => toast(t('Contact linked to {number}', { number: lead.number })),
                // The contact exists on the company now: say so, so nobody adds the same person twice.
                onError: (err) => {
                  refreshIfOutOfDate(err);
                  toast(
                    t('{name} was added to the company but not linked to this lead. Use Switch contact in Edit profile.', {
                      name: `${c.firstName} ${c.lastName}`.trim(),
                    }),
                    'warn',
                  );
                },
              },
            )
          }
        />
      ) : null}
    </section>
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
      <AiLine lead={lead} />
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

/**
 * The company card's AI line (prototype views-lead-detail.js): the AI summary with its confidence once research has
 * produced one; otherwise the research status ("No AI research yet." before the first run) and "Run research" for
 * users who may edit companies and can see the company. While a run is queued the research view polls; when it finishes the lead refreshes.
 */
function AiLine({ lead }: { lead: LeadFull }) {
  const t = useT();
  const me = useCurrentUser();
  const qc = useQueryClient();
  const c = lead.company!;
  const [watching, setWatching] = useState(false);
  const { query, run, busy } = useResearchRunner(c.id, {
    enabled: watching || isResearchQueued(c.aiResearchStatus),
    onFinished: () => {
      setWatching(false);
      void qc.invalidateQueries({ queryKey: keys.lead(lead.id) });
    },
  });
  const status = query.data?.company?.aiResearchStatus ?? c.aiResearchStatus ?? 'Not started';
  const summary = query.data?.company?.aiSummary ?? c.aiSummary;
  const confidence = query.data?.company?.aiConfidence ?? c.aiConfidence;
  if (summary) {
    return (
      <div className="note ai lead-ai">
        <strong>{t('AI summary')}</strong> {confidence ? <span className="tag-ai">{confidence}</span> : null}
        <div>{summary}</div>
      </div>
    );
  }
  return (
    <div className="note ai-empty">
      {status === 'Not started' ? (
        t('No AI research yet.')
      ) : (
        <>
          {t('AI research')} <span className={researchStatusBadge(status)}>{researchStatusText(t, status)}</span>
        </>
      )}{' '}
      {me.can('manage_companies') && lead.companyVisible !== false ? (
        <button
          type="button"
          className="linkish"
          disabled={busy || isResearchQueued(status)}
          onClick={() => {
            setWatching(true);
            run();
          }}
        >
          {t('Run research')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Next follow-up and the open tasks, soonest first. A call or meeting shows as the prototype's calendar events: the
 * calendar icon, date and start time, linking to that week of the Calendar; a timed follow-up shows its time.
 */
function ComingUp({ lead }: { lead: LeadFull }) {
  const t = useT();
  const { day } = useFormatDate();
  const items = [
    ...(lead.nextFollowUp ? [{ key: 'fu', title: t('Follow-up · {number}', { number: lead.number }), due: lead.nextFollowUp, time: null, event: false, over: lead.isOverdue }] : []),
    ...lead.tasks
      .filter((task) => task.origin !== 'follow_up' || task.dueDate !== lead.nextFollowUp)
      .map((task) => ({ key: `t${task.id}`, title: task.title, due: task.dueDate, time: task.dueTime, event: task.kind !== 'followup', over: task.isOverdue })),
  ].sort((a, b) => a.due.localeCompare(b.due) || (a.time ?? '99').localeCompare(b.time ?? '99'));
  if (items.length === 0) return null;
  return (
    <section className="card side-card" aria-labelledby="lead-up-title">
      <h2 id="lead-up-title">{t('Coming up')}</h2>
      <ul className="up-list">
        {items.map((i) => {
          const when = <span className={i.over ? 'overdue' : 'dim'}>{day(i.due) + (i.time ? ` ${i.time}` : '')}</span>;
          return (
            <li key={i.key}>
              {i.event ? (
                <Link className="link" to={`/calendar?view=week&d=${i.due}`}>
                  <span>
                    <span className="up-ic">{Icons.calendar}</span>
                    {i.title}
                  </span>
                  {when}
                </Link>
              ) : (
                <div className="link">
                  <span>{i.title}</span>
                  {when}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
