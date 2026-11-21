import { useId, type ReactNode } from 'react';
import { safeUrl } from '@dait-crm/shared';
import type { CompanyDetail } from '../../../api/companies';
import { useLookupText } from '../../../api/queries';
import { companyStatusText } from '../../../i18n/labels';
import { useLang, useT } from '../../../i18n/useT';
import type { CompanySection } from '../CompanyModal';

type Props = { company: CompanyDetail; canManage: boolean; onEdit: (section: CompanySection) => void };

type Row = [label: string, value: ReactNode];

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

/** Read-only sections A–E in the prototype's definition-list layout, each with its own Edit button. */
export function OverviewTab({ company: c, canManage, onEdit }: Props) {
  const t = useT();
  const lang = useLang();
  const lookup = useLookupText(lang);
  const money = (n: number | null) =>
    n === null ? null : `${c.revenueCurrency ? `${c.revenueCurrency} ` : ''}${new Intl.NumberFormat(lang).format(n)}`;
  const number = (n: number | null) => (n === null ? null : new Intl.NumberFormat(lang).format(n));
  const email = c.businessEmail ? safeUrl(`mailto:${c.businessEmail}`) : null;

  return (
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
        [t('LinkedIn'), <LinkOut url={c.linkedinUrl} />],
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
      ]} />
      <Section letter="C" title={t('Size & financial')} section="size" canManage={canManage} onEdit={onEdit} rows={[
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
        [t('Main products'), c.mainProducts],
        [t('Main services'), c.mainServices],
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
      ]} />
    </div>
  );
}

type SectionProps = {
  letter: string;
  title: string;
  section: CompanySection;
  rows: Row[];
  canManage: boolean;
  onEdit: (section: CompanySection) => void;
  wide?: boolean;
};

function Section({ letter, title, section, rows, canManage, onEdit, wide }: SectionProps) {
  const t = useT();
  const headingId = useId();
  return (
    <section className={wide ? 'card wide' : 'card'} aria-labelledby={headingId}>
      <h2 className="sec-head">
        <span className="pill" aria-hidden="true">{letter}</span>
        <span id={headingId}>{title}</span>
        {canManage ? (
          <button type="button" className="btn xs" onClick={() => onEdit(section)} aria-label={t('Edit {name}', { name: title })}>
            {t('Edit')}
          </button>
        ) : null}
      </h2>
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
    </section>
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
