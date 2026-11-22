import { useState } from 'react';
import { Link } from 'react-router-dom';
import { QUOTE_TABS, formatMoney, type QuoteTab } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useQuotations, type CurrencySum, type QuotationListItem } from '../../api/quotations';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Table } from '../../components/Table';
import { Tabs } from '../../components/Tabs';
import { Tile } from '../../components/Tile';
import { Topbar } from '../../components/Topbar';
import { useFormatDate } from '../../hooks/useFormatDate';
import { useUrlListState } from '../../hooks/useUrlListState';
import { errorText, quoteStatusBadge, quoteStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { NewQuotationModal } from './NewQuotationModal';

/** The list has one fixed order (newest date first); useUrlListState wants a sort list. */
const SORTS = ['date'] as const;

/** Tile sums as the prototype's sum(): one figure per currency, joined " · ", a whole amount without ".00". */
const sums = (list: CurrencySum[]) => list.map((x) => formatMoney(x.amount, x.currency).replace(/\.00$/, '')).join(' · ') || '—';

/**
 * Quotations (prototype V.quotes): tiles (open value, accepted, expiring within 7 days, win rate) over every
 * quotation the user can see, then tabs by status with counts, a search over number, company, lead and subject,
 * and the table in the prototype's columns. "New quotation" (manage_quotes) opens a dialog to choose the company.
 */
export function QuotationsPage() {
  const t = useT();
  const me = useCurrentUser();
  const { day } = useFormatDate();
  const { params, set, search } = useUrlListState({ sorts: SORTS, defaultSort: 'date', extra: ['tab'] });
  const tab: QuoteTab = (QUOTE_TABS as readonly string[]).includes(params.tab ?? '') ? (params.tab as QuoteTab) : 'all';
  const { data, isPending, error } = useQuotations({ tab: tab === 'all' ? undefined : tab, s: params.q });
  const [adding, setAdding] = useState(false);

  const tiles = data?.tiles;
  const counts = data?.counts;
  const tabs = [
    { id: 'all', label: t('All|quotes'), count: counts?.all },
    { id: 'draft', label: t('Draft|quotes'), count: counts?.draft },
    { id: 'sent', label: t('Sent / Negotiating'), count: counts?.sent },
    { id: 'accepted', label: t('Accepted|quotes'), count: counts?.accepted },
    { id: 'closed', label: t('Rejected / Expired'), count: counts?.closed },
  ];
  const head = [t('Quotation no.'), t('Company'), t('Contact'), t('Lead'), t('Date'), t('Valid until'), t('Total'), t('Rev.'), t('Status'), t('Owner'), ''];
  const rows = data?.items;

  return (
    <>
      <Topbar title={t('Quotations')} sub={t('Every quotation links to a lead, company and contact. Revisions keep previous versions.')}>
        <label className="search">
          {Icons.search}
          <span className="sr">{t('Search quotations')}</span>
          <input type="search" value={search.text} onChange={(e) => search.setText(e.target.value)} placeholder={t('Search number, company, lead…')} />
        </label>
        {me.can('manage_quotes') ? (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            {Icons.plus}
            {t('New quotation')}
          </button>
        ) : null}
      </Topbar>
      <div className="page">
        <div className="tiles">
          <Tile label={t('Open value (sent + negotiating)')} value={tiles?.openCount ?? '—'} meta={tiles ? sums(tiles.openSums) : undefined} />
          <Tile label={t('Accepted|quotes')} value={tiles?.acceptedCount ?? '—'} meta={tiles ? sums(tiles.acceptedSums) : undefined} metaClass="ok" />
          <Tile
            label={t('Expiring within 7 days')}
            value={tiles?.expiringSoon.length ?? '—'}
            meta={tiles ? tiles.expiringSoon.map((x) => `${x.number} · ${x.validUntil ? day(x.validUntil) : '—'}`).join(', ') || '—' : undefined}
            metaClass="bad"
          />
          <Tile
            label={t('Win rate')}
            value={tiles ? `${tiles.winRate}%` : '—'}
            meta={tiles ? t('{n} of {total} sent', { n: tiles.acceptedCount, total: tiles.sentCount }) : undefined}
          />
        </div>
        <section className="card flush" aria-label={t('Quotations')}>
          <Tabs tabs={tabs} active={tab} onChange={(id) => set({ tab: id === 'all' ? undefined : id })} label={t('Quotation lists')}>
            {error ? (
              <div className="empty" role="alert">
                {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
              </div>
            ) : (
              <Table head={head} isEmpty={isPending || !rows?.length} empty={isPending ? t('Loading…') : t('No quotations.')}>
                {rows?.map((q) => <QuotationRow key={q.id} q={q} />)}
              </Table>
            )}
          </Tabs>
        </section>
      </div>
      {adding ? <NewQuotationModal onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/** A row in the prototype's columns; an expiring valid-until date is red; Accepted without a project offers Convert. */
function QuotationRow({ q }: { q: QuotationListItem }) {
  const t = useT();
  const { day } = useFormatDate();
  const dim = <span className="dim">—</span>;
  const href = `/quotations/${q.id}`;
  return (
    <tr>
      <td>
        <Link to={href} className="q-num">
          {q.number}
        </Link>
      </td>
      <td>
        <Link to={`/companies/${q.company.id}`} className="row-link">
          {q.company.legalName || q.company.name}
        </Link>
      </td>
      <td>{q.contact ? q.contact.name : '—'}</td>
      <td>{q.lead ? <Link to={`/leads/${q.lead.id}`}>{q.lead.number}</Link> : '—'}</td>
      <td>{day(q.quotationDate)}</td>
      <td>{q.validUntil ? q.expiringSoon ? <span className="q-exp">{day(q.validUntil)}</span> : day(q.validUntil) : dim}</td>
      <td className="strong">{formatMoney(q.total, q.currency)}</td>
      <td>{t('rev {n}', { n: q.revision })}</td>
      <td>
        <span className={quoteStatusBadge(q.status)}>{quoteStatusText(t, q.status)}</span>
      </td>
      <td>{q.owner.name}</td>
      <td>
        {q.status === 'Accepted' && !q.projectId ? (
          <Link to={href} className="q-act q-convert">
            {t('Convert to project')}
          </Link>
        ) : (
          <Link to={href} className="q-act">
            {t('Open')}
          </Link>
        )}
      </td>
    </tr>
  );
}
