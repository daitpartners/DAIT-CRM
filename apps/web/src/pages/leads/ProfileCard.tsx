import { useContext, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { safeUrl } from '@dait-crm/shared';
import type { LeadFull } from '../../api/leads';
import { useLookupText } from '../../api/queries';
import { Icons } from '../../components/Icons';
import { PriorityLabel, StatusBadge } from '../../components/StatusBadge';
import { leadTypeText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { OUTREACH_LABEL } from '../../lib/outreach';
import { ComposeContext } from './ComposePanel';
import { ExperienceColumn } from './ExperienceColumn';

const FOLD_KEY = 'dait-lead-profile-closed';

function readFold(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
}

function saveFold(closed: boolean) {
  try {
    localStorage.setItem(FOLD_KEY, closed ? '1' : '0');
  } catch {
    /* storage blocked: the state lasts for this visit only */
  }
}

/** One cell of the facts grid; an empty value shows a dash. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <div>
      <dt>{label}</dt>
      <dd className={empty ? 'dim' : undefined}>{empty ? '—' : children}</dd>
    </div>
  );
}

type Contact = NonNullable<LeadFull['contact']>;

/** Share of the profile filled in (prototype `completeness`): LinkedIn, headline, location, about, experience, … */
export function completeness(p: Contact): number {
  const checks = [
    p.linkedinUrl, p.headline, p.location, p.about, p.experience?.length, p.education?.length, p.skills?.length,
    p.businessEmail, p.mobile || p.phone,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

/**
 * The PROFILE card (prototype `views-leads2.js` l2sec): a collapsible box with the contact person on the left
 * (name and badges, headline, company line, LinkedIn / phones / email, the lead's facts grid, the closed-lead
 * banner passed in as `children`, about) and their experience on the right. Without a contact: the company name, a
 * note and the facts grid. "Focus on email" folds the profile and opens the composer on the Email tab.
 */
export function ProfileCard({ lead, children }: { lead: LeadFull; children?: ReactNode }) {
  const t = useT();
  const lookup = useLookupText(useLang());
  const [closed, setClosed] = useState(readFold);
  const compose = useContext(ComposeContext);
  const foldId = useId();
  const c = lead.company;
  const p = lead.contact;
  const phone = p?.mobile || p?.phone || null;

  function toggle() {
    setClosed(!closed);
    saveFold(!closed);
  }

  const facts = (
    <dl className="l2facts">
      <Fact label={t('Lead source')}>{lookup('lead_source', lead.leadSource)}</Fact>
      <Fact label={t('Lead status')}>
        <StatusBadge status={lead.status} />
      </Fact>
      <Fact label={t('Lead type')}>
        <span className={lead.leadType === 'Lead' ? 'badge b-purple' : 'badge b-grey'}>{leadTypeText(t, lead.leadType)}</span>
      </Fact>
      <Fact label={t('Priority')}>
        <PriorityLabel priority={lead.priority} />
      </Fact>
      <Fact label={t('Industry')}>{lookup('industry', c?.industry)}</Fact>
      <Fact label={t('Segment')}>{c?.businessCategory ?? null}</Fact>
      <Fact label={t('Company size')}>
        {c?.employeeRange ? t('{range} employees', { range: lookup('employee_range', c.employeeRange) ?? c.employeeRange }) : null}
      </Fact>
      <Fact label={t('Time zone')}>{c?.timezone ?? null}</Fact>
      <Fact label={t('Outreach language')}>{OUTREACH_LABEL[lead.outreachLanguage] ?? lead.outreachLanguage}</Fact>
    </dl>
  );

  return (
    <section className={closed ? 'card flush l2sec is-closed' : 'card flush l2sec'} aria-label={t('Profile')}>
      <div className="l2tb">
        <button type="button" className="l2tog" aria-expanded={!closed} aria-controls={foldId} onClick={toggle} title={t('Show or hide the profile')}>
          {Icons.chev}
          <span className="l2tt">{t('Profile')}</span>
          <span className="l2sum" aria-hidden={!closed}>
            <b>{p ? p.name : lead.companyName}</b>
            {p?.designation ? <span>{p.designation}</span> : null}
            {p ? <span>{lead.companyName}</span> : null}
            <StatusBadge status={lead.status} />
            <PriorityLabel priority={lead.priority} />
            {phone ? <span>{phone}</span> : null}
          </span>
        </button>
        <button
          type="button"
          className="btn xs l2focus"
          title={t('Hide the profile and jump to the email box')}
          onClick={() => {
            setClosed(true);
            saveFold(true);
            compose?.openEmail();
          }}
        >
          {Icons.mail}
          {t('Focus on email')}
        </button>
      </div>
      <div className="l2fold" id={foldId}>
        <div className="l2foldin">
          <div className="l2box">
            <div className="l2col">
              {/* As in the prototype, the facts grid, the closed banner and About sit inside the person block. */}
              {p ? (
                <Person lead={lead} p={p}>
                  {facts}
                  {children}
                  {p.about ? <p className="pabout">{p.about}</p> : null}
                </Person>
              ) : (
                <NoContact name={lead.companyName}>
                  {facts}
                  {children}
                </NoContact>
              )}
            </div>
            <ExperienceColumn experience={p?.experience ?? []} companyName={c?.name ?? lead.companyName} />
          </div>
        </div>
      </div>
    </section>
  );
}

function NoContact({ name, children }: { name: string; children?: ReactNode }) {
  const t = useT();
  return (
    <div className="pinfo">
      <h2 className="pname">{name}</h2>
      <div className="note info">{t('No contact person on this lead yet. Add one from the Contact card on the right and the profile will appear here.')}</div>
      {children}
    </div>
  );
}

/** Name, badges, headline, company line, completeness ring and the contact line (LinkedIn, phones, email). */
function Person({ lead, p, children }: { lead: LeadFull; p: Contact; children?: ReactNode }) {
  const t = useT();
  const lookup = useLookupText(useLang());
  const pct = completeness(p);
  const linkedin = safeUrl(p.linkedinUrl);
  const meta = [p.department, p.location].filter(Boolean).join(' · ');
  const tel = (n: string, kind: string) => (
    <a href={`tel:${n.replace(/\s+/g, '')}`}>
      {Icons.phone}
      {n} <small>{kind}</small>
    </a>
  );
  const headline = p.headline || p.designation;
  return (
    <div className="pinfo">
      <div className="prow">
        <div className="ptop">
          <div className="pnm">
            <h2 className="pname">{p.name}</h2>
            {p.contactType ? <span className="badge b-purple">{lookup('contact_type', p.contactType)}</span> : null}
            {p.isPrimary ? <span className="badge b-purple2">{t('Primary contact')}</span> : null}
            {p.isActive ? null : <span className="badge b-grey">{t('Inactive|contact')}</span>}
            {lead.doNotEmail || lead.contactUnsubscribed ? <span className="badge b-bad">{t('Do not email')}</span> : null}
          </div>
          {headline ? <div className="phead">{headline}</div> : null}
          <div className="pmeta">
            {lead.company ? <Link to={`/companies/${lead.company.id}`}>{lead.company.name}</Link> : lead.companyName}
            {meta ? ` · ${meta}` : null}
          </div>
        </div>
        <span
          className="l2pie"
          role="img"
          aria-label={t('Profile {pct}% complete', { pct })}
          title={t('Profile {pct}% complete', { pct })}
          style={{ ['--p' as string]: pct }}
        >
          <b>{pct}%</b>
        </span>
      </div>
      <div className="pcontacts">
        {linkedin ? (
          <a className="li-btn lg" href={linkedin} target="_blank" rel="noopener noreferrer">
            {Icons.linkedin}
            {t('LinkedIn profile')}
          </a>
        ) : (
          <span className="li-btn lg off">
            {Icons.linkedin}
            {t('No LinkedIn yet')}
          </span>
        )}
        {p.mobile ? tel(p.mobile, t('mobile')) : null}
        {p.businessEmail ? (
          <a href={`mailto:${p.businessEmail}`}>
            {Icons.mail}
            {p.businessEmail}
          </a>
        ) : null}
        {p.phone ? tel(p.phone, t('office')) : null}
      </div>
      {children}
    </div>
  );
}
