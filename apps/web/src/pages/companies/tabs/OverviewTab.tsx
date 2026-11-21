import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { safeUrl } from '@dait-crm/shared';
import type { CompanyDetail } from '../../../api/companies';
import { contactName, useContacts } from '../../../api/contacts';
import { useLeads } from '../../../api/leads';
import { useLookupText } from '../../../api/queries';
import { PlaceholderCard } from '../../../components/PlaceholderCard';
import { StatusBadge } from '../../../components/StatusBadge';
import { useFormatDate } from '../../../hooks/useFormatDate';
import { companyStatusText, researchStatusText } from '../../../i18n/labels';
import { useLang, useT } from '../../../i18n/useT';
import type { CompanySection } from '../CompanyModal';

type Props = { company: CompanyDetail; canManage: boolean; onEdit: (section: CompanySection) => void };

type Row = [label: string, value: ReactNode];

/** Leads in the Overview side card; the profile header asks for the same page, so its lead count shares the request. */
export const OVERVIEW_LEADS = 4;

const isEmpty = (v: ReactNode) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** An outbound link when the value is a safe URL; otherwise the stored text (never an unsafe href). */
export function LinkOut({ url }: { url: string | null | undefined }) {
  if (!url) return null;
  const href = safeUrl(url);
  if (!href) return <>{url}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {url.replace(/^https?:\/\//i, '')}
    </a>
  );
}

const pills = (items: string[]) => (items.length ? items.map((x) => <span key={x} className="pill">{x}</span>) : null);

/**
 * Overview in the prototype's layout: the legend bar, sections A–E (definition lists, each with its own Edit
 * button) in a two-column grid, and the side column: AI business intelligence and Projects (later releases),
 * Leads & prospects and Contacts.
 */
export function OverviewTab({ company: c, canManage, onEdit }: Props) {
  const t = useT();
  const lang = useLang();
  const lookup = useLookupText(lang);
  const money = (n: number | null) =>
    n === null ? null : `${c.revenueCurrency ? `${c.revenueCurrency} ` : ''}${new Intl.NumberFormat(lang).format(n)}`;
  const number = (n: number | null) => (n === null ? null : new Intl.NumberFormat(lang).format(n));
  const email = c.businessEmail ? safeUrl(`mailto:${c.businessEmail}`) : null;

  const { date } = useFormatDate();

  return (
    <>
      <div className="legend">
        <strong>{t('Legend')}</strong>
        <span className="dim">{t('Empty fields stay empty. Nothing is invented.')}</span>
        <div className="grow" />
        <span>
          {t('Last research: {when}', { when: c.aiLastResearchAt ? date(c.aiLastResearchAt) : t('never') })}
          {' · '}
          <span className="badge b-grey">{researchStatusText(t, c.aiResearchStatus)}</span>
        </span>
      </div>
      <div className="cols">
        <div className="col-main">
          <div className="profile-grid">
            <Section letter="A" title={t('Company overview')} section="overview" canManage={canManage} onEdit={onEdit} rows={[
              [t('Company name'), c.name],
              [t('Legal name'), c.legalName],
              [t('Website'), <LinkOut url={c.website} />],
              [t('Business email'), c.businessEmail ? (email ? <a href={email}>{c.businessEmail}</a> : c.businessEmail) : null],
              [t('Industry'), lookup('industry', c.industry)],
              [t('Business category'), lookup('business_category', c.businessCategory)],
              [t('Business type'), lookup('business_type', c.businessType)],
              [t('Year established'), c.yearEstablished],
              [t('LinkedIn company'), <LinkOut url={c.linkedinUrl} />],
              [t('Status'), companyStatusText(t, c.status)],
              [t('Description'), c.description],
            ]} />
            <Section letter="B" title={t('Company address')} section="address" canManage={canManage} onEdit={onEdit} rows={[
              [t('Country'), lookup('country', c.country)],
              [t('State / Province'), c.state],
              [t('City'), c.city],
              [t('Street address'), c.street],
              [t('ZIP / Postal code'), c.zip],
              [t('Time zone'), c.timezone],
              [t('Latitude, longitude'), c.lat !== null && c.lng !== null ? `${c.lat}, ${c.lng}` : null],
              [t('Google Maps / Places'), <LinkOut url={c.mapsUrl} />],
            ]} />
            <Section letter="C" title={t('Size & financial')} note={t('all optional')} section="size" canManage={canManage} onEdit={onEdit} rows={[
              [t('Employee count'), number(c.employeeCount)],
              [t('Employee range'), lookup('employee_range', c.employeeRange)],
              [t('Annual revenue'), money(c.annualRevenue)],
              [t('Revenue range'), lookup('revenue_range', c.revenueRange)],
              [t('Ownership type'), lookup('ownership_type', c.ownershipType)],
              [t('Registration number'), c.registrationNumber],
              [t('Stock exchange'), c.stockExchange],
              [t('Stock symbol'), c.stockSymbol],
            ]} />
            <Section letter="D" title={t('Products & services')} section="products" canManage={canManage} onEdit={onEdit} rows={[
              [t('Main services'), c.mainServices],
              [t('Main products'), c.mainProducts],
              [t('Business verticals'), pills(c.businessVerticals)],
              [t('Target markets'), pills(c.targetMarkets)],
              [t('Geographic markets'), pills(c.geographicMarkets)],
              [t('Key brands'), c.keyBrands],
              [t('Specialisation'), c.specialisation],
            ]} />
            <Section letter="E" title={t('Digital presence')} section="digital" wide canManage={canManage} onEdit={onEdit} rows={[
              [t('LinkedIn'), <LinkOut url={c.linkedinUrl} />],
              [t('Facebook'), <LinkOut url={c.socialFacebook} />],
              [t('Instagram'), <LinkOut url={c.socialInstagram} />],
              [t('X / Twitter'), <LinkOut url={c.socialX} />],
              [t('YouTube'), <LinkOut url={c.socialYoutube} />],
              [t('Other social profile'), <LinkOut url={c.socialOther} />],
              [t('Website technology'), c.websiteTechnology],
            ]}>
              <div className="digital-notes">
                <AiNote label={t('Website assessment')} text={c.websiteAssessment} empty={t('Website assessment: not yet generated.')} />
                <AiNote label={t('Digital presence summary')} text={c.digitalSummary} empty={t('Digital presence summary: not yet generated.')} />
              </div>
            </Section>
          </div>
        </div>
        <aside className="col-side" aria-label={t('Company summary')}>
          <PlaceholderCard
            title={t('AI business intelligence')}
            release="4"
            hint={t('Opportunity score, confidence and an AI company summary built from approved sources.')}
          />
          <PlaceholderCard title={t('Projects')} release="3" hint={t('Projects unlock when a lead at this company is won or a quotation is accepted.')} />
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
  section: CompanySection;
  rows: Row[];
  canManage: boolean;
  onEdit: (section: CompanySection) => void;
  wide?: boolean;
};

function Section({ letter, title, note, section, rows, canManage, onEdit, wide, children }: SectionProps) {
  const t = useT();
  const headingId = useId();
  return (
    <section className={wide ? 'card wide' : 'card'} aria-labelledby={headingId}>
      <h2 className="sec-head">
        <span className="pill" aria-hidden="true">{letter}</span>
        <span id={headingId}>{title}</span>
        {note ? <span className="sec-note">{note}</span> : null}
        {canManage ? (
          <button type="button" className="btn xs" onClick={() => onEdit(section)} aria-label={t('Edit {name}', { name: title })}>
            {t('Edit')}
          </button>
        ) : null}
      </h2>
      {children ? (
        <div className="grid2 sec-split">
          <List rows={rows} />
          {children}
        </div>
      ) : (
        <List rows={rows} />
      )}
    </section>
  );
}

function List({ rows }: { rows: Row[] }) {
  return (
    <dl className="kv">
      {rows.map(([label, value]) => {
        const blank = isEmpty(value) || isEmptyLink(value);
        return (
          <Pair key={label} label={label} blank={blank}>
            {value}
          </Pair>
        );
      })}
    </dl>
  );
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
