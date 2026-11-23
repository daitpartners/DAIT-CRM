import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { safeUrl } from '@dait-crm/shared';
import type { CompanyDetail } from '../../../api/companies';
import { contactName, useContacts } from '../../../api/contacts';
import { useLeads } from '../../../api/leads';
import { useLookupText } from '../../../api/queries';
import { StatusBadge } from '../../../components/StatusBadge';
import { useFormatDate } from '../../../hooks/useFormatDate';
import { companyStatusText, researchStatusBadge, researchStatusText } from '../../../i18n/labels';
import { useLang, useT } from '../../../i18n/useT';
import { AiCard, type ResearchRunner } from '../AiCard';
import { ProjectsCard } from '../../projects/ProjectsCard';

type Props = {
  company: CompanyDetail;
  /** Section B's "N locations" link to the Locations tab (prototype). */
  locationCount?: number;
  research: ResearchRunner;
};

/** A label, its value and the company field it shows (for the VERIFIED / AI tags). */
type Row = [label: string, value: ReactNode, field?: string];

/** The tag after a value (prototype v()): VERIFIED for a user-confirmed field, else AI · n% for an accepted suggestion. */
type Tags = { verified: Record<string, boolean>; ai: Record<string, { confidence?: number }> };

/** Leads in the Overview side card. */
const OVERVIEW_LEADS = 4;

const isEmpty = (v: ReactNode) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * A URL's text with line-break chances after its separators (/ . - ? & = _), so a long link in a narrow column wraps at
 * "linkedin.com/ company/" rather than mid-word (review #31).
 */
export function breakableUrl(text: string): ReactNode[] {
  return text.split(/(?<=[/.\-?&=_])(?=.)/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));
}

/** An outbound link when the value is a safe URL; otherwise the stored text (never an unsafe href). */
export function LinkOut({ url }: { url: string | null | undefined }) {
  if (!url) return null;
  const href = safeUrl(url);
  if (!href) return <>{url}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {breakableUrl(url.replace(/^https?:\/\//i, ''))}
    </a>
  );
}

const pills = (items: string[]) => (items.length ? items.map((x) => <span key={x} className="pill">{x}</span>) : null);

/**
 * Overview in the prototype's layout: the legend bar, sections A–E (definition lists; the header's Edit profile edits
 * them, as the prototype has no per-section Edit) in a two-column grid, and the side column: AI business intelligence, Projects,
 * Leads & prospects and Contacts.
 */
export function OverviewTab({ company: c, locationCount, research }: Props) {
  const t = useT();
  const lang = useLang();
  const lookup = useLookupText(lang);
  const money = (n: number | null) =>
    n === null ? null : `${c.revenueCurrency ? `${c.revenueCurrency} ` : ''}${new Intl.NumberFormat(lang).format(n)}`;
  const number = (n: number | null) => (n === null ? null : new Intl.NumberFormat(lang).format(n));
  const email = c.businessEmail ? safeUrl(`mailto:${c.businessEmail}`) : null;

  const { dateTime } = useFormatDate();
  const tags: Tags = { verified: c.verifiedFields ?? {}, ai: c.aiFields ?? {} };

  return (
    <>
      <div className="legend">
        <strong>{t('Legend')}</strong>
        <span>
          <span className="tag-ok flat">{t('VERIFIED')}</span> {t('entered or confirmed by a user')}
        </span>
        <span>
          <span className="tag-ai">{t('AI · {n}%', { n: 82 })}</span> {t('AI-suggested. Never overwrites verified values.')}
        </span>
        <span className="dim">{t('Empty fields stay NULL. Nothing is invented.')}</span>
        <div className="grow" />
        <span>
          {t('Last research: {when}', { when: c.aiLastResearchAt ? dateTime(c.aiLastResearchAt) : t('never') })}
          {' · '}
          <span className={researchStatusBadge(c.aiResearchStatus)}>{researchStatusText(t, c.aiResearchStatus)}</span>
        </span>
      </div>
      <div className="cols">
        <div className="col-main">
          <div className="profile-grid">
            <Section letter="A" title={t('Company overview')} tags={tags} rows={[
              [t('Company name'), c.name, 'name'],
              [t('Legal name'), c.legalName, 'legalName'],
              [t('Website'), <LinkOut url={c.website} />, 'website'],
              [t('Business email'), c.businessEmail ? (email ? <a href={email}>{c.businessEmail}</a> : c.businessEmail) : null, 'businessEmail'],
              [t('Industry'), lookup('industry', c.industry), 'industry'],
              [t('Business category'), lookup('business_category', c.businessCategory), 'businessCategory'],
              [t('Business type'), lookup('business_type', c.businessType), 'businessType'],
              [t('Year established'), c.yearEstablished, 'yearEstablished'],
              [t('LinkedIn company'), <LinkOut url={c.linkedinUrl} />, 'linkedinUrl'],
              [t('Status'), companyStatusText(t, c.status)],
              [t('Description'), c.description, 'description'],
            ]} />
            <Section
              letter="B"
              title={t('Company address')}
              link={locationCount ? <Link className="sec-link" to="#locations">{t('{n} locations', { n: locationCount })}</Link> : undefined}
              tags={tags} rows={[
              [t('Country'), lookup('country', c.country), 'country'],
              [t('State / Province'), c.state, 'state'],
              [t('City'), c.city, 'city'],
              [t('Street address'), c.street, 'street'],
              [t('ZIP / Postal code'), c.zip, 'zip'],
              [t('Time zone'), c.timezone, 'timezone'],
              [t('Latitude, longitude'), c.lat !== null && c.lng !== null ? `${c.lat}, ${c.lng}` : null, 'lat'],
              [t('Google Maps / Places'), <LinkOut url={c.mapsUrl} />, 'mapsUrl'],
            ]} />
            <Section letter="C" title={t('Size & financial')} note={t('all optional')} tags={tags} rows={[
              [t('Employee count'), number(c.employeeCount), 'employeeCount'],
              [t('Employee range'), lookup('employee_range', c.employeeRange), 'employeeRange'],
              [t('Annual revenue'), money(c.annualRevenue), 'annualRevenue'],
              [t('Revenue range'), lookup('revenue_range', c.revenueRange), 'revenueRange'],
              [t('Ownership type'), lookup('ownership_type', c.ownershipType), 'ownershipType'],
              [t('Registration number'), c.registrationNumber, 'registrationNumber'],
              [t('Stock exchange'), c.stockExchange, 'stockExchange'],
              [t('Stock symbol'), c.stockSymbol, 'stockSymbol'],
            ]} />
            <Section letter="D" title={t('Products & services')} tags={tags} rows={[
              [t('Main services'), c.mainServices, 'mainServices'],
              [t('Main products'), c.mainProducts, 'mainProducts'],
              [t('Business verticals'), pills(c.businessVerticals), 'businessVerticals'],
              [t('Target markets'), pills(c.targetMarkets), 'targetMarkets'],
              [t('Geographic markets'), pills(c.geographicMarkets), 'geographicMarkets'],
              [t('Key brands'), c.keyBrands, 'keyBrands'],
              [t('Specialisation'), c.specialisation, 'specialisation'],
            ]} />
            <Section letter="E" title={t('Digital presence')} wide tags={tags} rows={[
              [t('LinkedIn'), <LinkOut url={c.linkedinUrl} />, 'linkedinUrl'],
              [t('Facebook'), <LinkOut url={c.socialFacebook} />, 'socialFacebook'],
              [t('Instagram'), <LinkOut url={c.socialInstagram} />, 'socialInstagram'],
              [t('X / Twitter'), <LinkOut url={c.socialX} />, 'socialX'],
              [t('YouTube'), <LinkOut url={c.socialYoutube} />, 'socialYoutube'],
              [t('Other social profile'), <LinkOut url={c.socialOther} />, 'socialOther'],
              [t('Website technology'), c.websiteTechnology, 'websiteTechnology'],
            ]}>
              <div className="digital-notes">
                <AiNote label={t('Website assessment')} text={c.websiteAssessment} empty={t('Website assessment: not yet generated.')} />
                <AiNote label={t('Digital presence summary')} text={c.digitalSummary} empty={t('Digital presence summary: not yet generated.')} />
              </div>
            </Section>
          </div>
        </div>
        <aside className="col-side" aria-label={t('Company summary')}>
          <AiCard companyId={c.id} research={research} />
          <ProjectsCard companyId={c.id} />
          <LeadsCard companyId={c.id} />
          <ContactsCard companyId={c.id} />
        </aside>
      </div>
    </>
  );
}

/** A generated text (release 4) or the prototype's "not yet generated" note. */
function AiNote({ label, text, empty }: { label: string; text: string | null; empty: string }) {
  if (!text) return <div className="note info">{empty}</div>;
  return (
    <div className="note ai">
      <strong>{label}</strong>
      <div>{text}</div>
    </div>
  );
}

/** Side card: the first leads of the company the user may see, each with its status. */
function LeadsCard({ companyId }: { companyId: number }) {
  const t = useT();
  const lang = useLang();
  const lookup = useLookupText(lang);
  const { data } = useLeads({ companyId, page: 1, pageSize: OVERVIEW_LEADS });
  const rows = data?.items ?? [];
  return (
    <section className="card side-card" aria-labelledby="co-side-leads">
      <h2 id="co-side-leads">{t('Leads & prospects')}</h2>
      {rows.length === 0 ? (
        <div className="muted small">{data ? t('None yet.') : t('Loading…')}</div>
      ) : (
        rows.map((l) => (
          <Link key={l.id} className="link" to={`/leads/${l.id}`}>
            <span>
              <strong>{l.number}</strong>{' '}
              <span className="muted">
                · {l.contact ? l.contact.name : t('no contact')} · {lookup('lead_source', l.leadSource)}
              </span>
            </span>
            <StatusBadge status={l.status} />
          </Link>
        ))
      )}
    </section>
  );
}

/** Side card: the company's active contacts, name and designation. */
function ContactsCard({ companyId }: { companyId: number }) {
  const t = useT();
  const { data } = useContacts({ companyId, page: 1, pageSize: 25, sort: 'lastName', dir: 'asc' });
  const rows = data?.items ?? [];
  return (
    <section className="card side-card" aria-labelledby="co-side-contacts">
      <h2 id="co-side-contacts">
        {t('Contacts')} {data ? <span className="n muted">{data.total}</span> : null}
      </h2>
      {rows.length === 0 ? (
        <div className="muted small">{data ? t('No contacts yet.') : t('Loading…')}</div>
      ) : (
        rows.map((x) => (
          <div key={x.id} className="small">
            <strong>{contactName(x)}</strong>
            {x.designation ? <span className="muted"> · {x.designation}</span> : null}
          </div>
        ))
      )}
    </section>
  );
}

type SectionProps = {
  letter: string;
  title: string;
  /** Muted text after the title (prototype "all optional"). */
  note?: string;
  /** Extra content under the list (section E's generated notes). */
  children?: ReactNode;
  /** A link after the title (prototype section B "2 locations"). */
  link?: ReactNode;
  rows: Row[];
  tags: Tags;
  wide?: boolean;
};

function Section({ letter, title, note, link, rows, tags, wide, children }: SectionProps) {
  const headingId = useId();
  return (
    <section className={wide ? 'card wide' : 'card'} aria-labelledby={headingId}>
      <h2 className="sec-head">
        <span className="pill" aria-hidden="true">{letter}</span>
        <span id={headingId}>{title}</span>
        {note ? <span className="sec-note">{note}</span> : null}
        {link}
      </h2>
      {children ? (
        <div className="grid2 sec-split">
          <List rows={rows} tags={tags} />
          {children}
        </div>
      ) : (
        <List rows={rows} tags={tags} />
      )}
    </section>
  );
}

function List({ rows, tags }: { rows: Row[]; tags: Tags }) {
  return (
    <dl className="kv">
      {rows.map(([label, value, field]) => {
        const blank = isEmpty(value) || isEmptyLink(value);
        return (
          <Pair key={label} label={label} blank={blank}>
            {value}
            {field ? <FieldTag field={field} tags={tags} /> : null}
          </Pair>
        );
      })}
    </dl>
  );
}

function FieldTag({ field, tags }: { field: string; tags: Tags }) {
  const t = useT();
  if (tags.verified[field] === true) return <span className="tag-ok">{t('VERIFIED')}</span>;
  const ai = tags.ai[field];
  if (!ai) return null;
  return <span className="tag-ai">{typeof ai.confidence === 'number' ? t('AI · {n}%', { n: ai.confidence }) : t('AI')}</span>;
}

/** A <LinkOut> element with no url renders nothing; treat it as blank. */
function isEmptyLink(v: ReactNode): boolean {
  return typeof v === 'object' && v !== null && 'type' in v && v.type === LinkOut && !(v.props as { url?: string | null }).url;
}

function Pair({ label, blank, children }: { label: string; blank: boolean; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      {blank ? <dd className="null">—</dd> : <dd>{children}</dd>}
    </>
  );
}
