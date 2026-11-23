import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { COMPANY_SORTS, COMPANY_TABS, CompanyStatus, VERIFICATION_STATUSES, lookupLabel, safeUrl, type CompanyTab } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { useCompanies, type CompanyListQuery, type CompanyListRow, type CompanySort, type VerificationStatus } from '../../api/companies';
import { keys, useLookups, type LookupValue } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Combobox, type ComboOption } from '../../components/Combobox';
import { useConfirm } from '../../components/ConfirmDialog';
import { Icons } from '../../components/Icons';
import { Pager } from '../../components/Pager';
import { SortHeader } from '../../components/SortHeader';
import { Table } from '../../components/Table';
import { Tabs } from '../../components/Tabs';
import { Tile } from '../../components/Tile';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { usePageClamp, useUrlListState } from '../../hooks/useUrlListState';
import { companyStatusBadge, companyStatusText, errorText, initials, verificationBadge, verificationText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { CompanyModal } from './CompanyModal';

/** Rows per page offered by the pager, as on the Leads list (prototype SIZES); 50 by default. */
const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;
/** Combobox value meaning "no filter" (the combobox cannot hold an empty value). */
const ANY = '*';

export function CompaniesList() {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const canManage = me.can('manage_companies');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { params, set: update, reset, search } = useUrlListState({
    sorts: COMPANY_SORTS,
    defaultSort: 'name',
    extra: ['tab', 'status', 'country', 'industry', 'employeeRange', 'verification'],
  });
  const [searchParams] = useSearchParams();
  const sizeParam = Number(searchParams.get('size'));
  const pageSize = (PAGE_SIZES as readonly number[]).includes(sizeParam) ? sizeParam : DEFAULT_PAGE_SIZE;
  const status = CompanyStatus.safeParse(params.status);
  const tab: CompanyTab = (COMPANY_TABS as readonly string[]).includes(params.tab ?? '') ? (params.tab as CompanyTab) : 'all';
  const verification = (VERIFICATION_STATUSES as readonly string[]).includes(params.verification ?? '')
    ? (params.verification as VerificationStatus)
    : undefined;
  const query: CompanyListQuery & Pick<typeof params, 'page' | 'sort' | 'dir'> = {
    page: params.page,
    pageSize,
    sort: params.sort,
    dir: params.dir,
    q: params.q,
    status: status.success ? status.data : undefined,
    country: params.country,
    industry: params.industry,
    employeeRange: params.employeeRange,
    verification,
    tab: tab === 'all' ? undefined : tab,
  };
  const { data, isPending, error } = useCompanies(query);
  const { data: lookups } = useLookups();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  usePageClamp(data, update);

  // Selection only covers rows on screen: clear it when a different set of rows is shown.
  const rows = data?.items;
  const rowIds = rows?.map((r) => r.id).join(',');
  useEffect(() => setSelected(new Set()), [rowIds]);

  const label = (group: 'country' | 'industry' | 'employee_range') => (v: string | null) => {
    if (!v) return null;
    const row = lookups?.[group]?.find((x) => x.value === v);
    return row ? lookupLabel(row, lang) : v;
  };
  const countryName = label('country');
  const industryName = label('industry');
  const sizeName = label('employee_range');
  const sizes = (lookups?.employee_range ?? []).filter((x) => x.isActive || x.value === query.employeeRange);

  const filterOptions = (group: 'country' | 'industry', any: string, current?: string): ComboOption[] => {
    const values: LookupValue[] = (lookups?.[group] ?? []).filter((x) => x.isActive || x.value === current);
    const opts = values.map((x) => ({ value: x.value, label: lookupLabel(x, lang) }));
    if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
    return [{ value: ANY, label: any }, ...opts];
  };
  const countryOptions = useMemo(() => filterOptions('country', t('Country: Any'), query.country), [lookups, lang, query.country, t]);
  const industryOptions = useMemo(() => filterOptions('industry', t('Industry: Any'), query.industry), [lookups, lang, query.industry, t]);

  const bulk = useMutation({
    mutationFn: (v: { ids: number[]; status: CompanyStatus }) => api<{ updated: number }>('/api/companies/bulk-status', { method: 'POST', body: v }),
    onSuccess: async ({ updated }) => {
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: keys.companiesAll });
      toast(t('Companies updated: {n}', { n: updated }));
    },
    onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
  });

  async function setStatus(status: CompanyStatus) {
    const ids = [...selected];
    const ok = await confirm({
      title: t('Change status?'),
      body: t('Change the status of {n} selected companies to {status}?', { n: ids.length, status: companyStatusText(t, status) }),
      confirmLabel: t('Change status'),
      danger: status === 'Closed',
    });
    if (ok) bulk.mutate({ ids, status });
  }

  const onSort = (column: CompanySort) => {
    if (column === query.sort) update({ sort: column, dir: query.dir === 'asc' ? 'desc' : 'asc' });
    // Newest first is the useful default for dates; A–Z for text.
    else update({ sort: column, dir: column === 'updatedAt' ? 'desc' : 'asc' });
  };

  const allOnPage = Boolean(rows?.length) && rows!.every((r) => selected.has(r.id));
  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allOnPage ? new Set() : new Set(rows?.map((r) => r.id)));
  const filtered = Boolean(query.q || query.status || query.country || query.industry || query.employeeRange || query.verification);

  const sortable = (column: CompanySort, text: string) => (
    <SortHeader key={column} label={text} column={column} sort={query.sort} dir={query.dir} onSort={onSort} />
  );
  const plain = (key: string, content: ReactNode) => (
    <th key={key} scope="col">
      {content}
    </th>
  );
  const head = [
    ...(canManage
      ? [
          plain(
            'select',
            <input type="checkbox" checked={allOnPage} onChange={toggleAll} disabled={!rows?.length} aria-label={t('Select all companies on this page')} />,
          ),
        ]
      : []),
    sortable('name', t('Company name')),
    plain('website', t('Website')),
    sortable('industry', t('Industry')),
    sortable('country', t('Country')),
    plain('city', t('City')),
    plain('size', t('Company size')),
    plain('contacts', t('Contacts')),
    plain('leads', t('Leads')),
    plain('verification', t('Verification')),
    sortable('status', t('Status')),
  ];
  const tiles = data?.tiles;
  const counts = data?.counts;
  const tabs = [
    { id: 'all', label: t('All companies'), count: counts?.all },
    { id: 'clients', label: t('Clients'), count: counts?.clients },
    { id: 'open', label: t('With open leads'), count: counts?.open },
    { id: 'verify', label: t('Needs verification'), count: counts?.verify },
    { id: 'dups', label: t('Duplicate review'), count: counts?.dups, countClass: 'bad' },
  ];

  return (
    <>
      <Topbar title={t('Companies')} sub={t('Master database of every organisation. A company is not a lead.')}>
        <label className="search">
          {Icons.search}
          <span className="sr">{t('Search companies')}</span>
          <input type="search" value={search.text} onChange={(e) => search.setText(e.target.value)} placeholder={t('Search name, domain or number…')} />
        </label>
        {canManage ? (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            {Icons.plus}
            {t('New company')}
          </button>
        ) : null}
      </Topbar>
      <div className="page">
        <div className="tiles">
          <Tile
            label={t('Total companies')}
            value={tiles?.total ?? '—'}
            meta={tiles ? t('{active} active · {inactive} inactive · {closed} closed', { active: tiles.active, inactive: tiles.inactive, closed: tiles.closed }) : undefined}
          />
          <Tile
            label={t('Verified profiles')}
            value={tiles?.verified ?? '—'}
            meta={tiles ? t('{partial} partially · {unverified} unverified', { partial: tiles.partiallyVerified, unverified: tiles.unverified }) : undefined}
          />
          {/* Queue = Pending + Processing (design); the meta line splits it and adds Failed, as the prototype. */}
          <Tile
            label={t('AI research queue')}
            value={tiles?.aiQueue ?? '—'}
            meta={tiles ? t('{pending} pending · {processing} processing · {failed} failed', { pending: tiles.aiPending, processing: tiles.aiProcessing, failed: tiles.aiFailed }) : undefined}
            metaClass="warn"
          />
          <Tile
            label={t('Possible duplicates')}
            value={tiles?.possibleDuplicates ?? '—'}
            meta={t('awaiting manual review')}
            metaClass="bad"
            to="/companies?tab=dups"
          />
        </div>
        <section className="card flush" aria-label={t('Companies')}>
          <Tabs tabs={tabs} active={tab} onChange={(id) => update({ tab: id === 'all' ? undefined : id })} label={t('Company lists')}>
            {tab === 'dups' ? (
              <div className="note warn dup-note">
                {t('Companies whose names match once legal suffixes are ignored. They are not merged automatically; an administrator decides.')}
              </div>
            ) : null}
            <div className="filters">
              <div className="filter-combo">
                <Combobox
                  id="flt-industry"
                  label={t('Industry')}
                  hideLabel
                  options={industryOptions}
                  value={query.industry ?? ANY}
                  onChange={(v) => update({ industry: v === ANY ? undefined : v })}
                />
              </div>
              <div className="filter-combo">
                <Combobox
                  id="flt-country"
                  label={t('Country')}
                  hideLabel
                  options={countryOptions}
                  value={query.country ?? ANY}
                  onChange={(v) => update({ country: v === ANY ? undefined : v })}
                />
              </div>
              <label className="sr" htmlFor="flt-size">
                {t('Company size')}
              </label>
              <select id="flt-size" className="chip" value={query.employeeRange ?? ''} onChange={(e) => update({ employeeRange: e.target.value })}>
                <option value="">{t('Company size: Any')}</option>
                {sizes.map((x) => (
                  <option key={x.value} value={x.value}>
                    {lookupLabel(x, lang)}
                  </option>
                ))}
              </select>
              <label className="sr" htmlFor="flt-status">
                {t('Status')}
              </label>
              <select id="flt-status" className="chip" value={query.status ?? ''} onChange={(e) => update({ status: e.target.value })}>
                <option value="">{t('Status: Any')}</option>
                {CompanyStatus.options.map((s) => (
                  <option key={s} value={s}>
                    {companyStatusText(t, s)}
                  </option>
                ))}
              </select>
              <label className="sr" htmlFor="flt-verification">
                {t('Verification')}
              </label>
              <select id="flt-verification" className="chip" value={query.verification ?? ''} onChange={(e) => update({ verification: e.target.value })}>
                <option value="">{t('Verification: Any')}</option>
                {VERIFICATION_STATUSES.map((v) => (
                  <option key={v} value={v}>
                    {verificationText(t, v)}
                  </option>
                ))}
              </select>
              {filtered ? (
                <button type="button" className="btn sm" onClick={reset}>
                  {t('Clear filters')}
                </button>
              ) : null}
              <div className="grow" />
              {data && counts ? <span className="muted filters-count">{t('Showing {n} of {total}', { n: data.total, total: counts.all })}</span> : null}
            </div>
            {canManage && selected.size > 0 ? (
              <div className="bulkbar" role="region" aria-label={t('Bulk actions')}>
                <strong>{t('Selected: {n}', { n: selected.size })}</strong>
                <label className="sr" htmlFor="co-bulk-status">
                  {t('Set status…')}
                </label>
                <select
                  id="co-bulk-status"
                  className="chip"
                  value=""
                  disabled={bulk.isPending}
                  onChange={(e) => {
                    const s = CompanyStatus.safeParse(e.target.value);
                    if (s.success) void setStatus(s.data);
                  }}
                >
                  <option value="">{t('Set status…')}</option>
                  {CompanyStatus.options.map((s) => (
                    <option key={s} value={s}>
                      {companyStatusText(t, s)}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn sm" onClick={() => setSelected(new Set())}>
                  {t('Clear selection')}
                </button>
              </div>
            ) : null}
            {error ? (
              <div className="empty" role="alert">
                {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
              </div>
            ) : (
              <Table
                rawHead
                head={head}
                isEmpty={isPending || !rows?.length}
                empty={isPending ? t('Loading…') : filtered ? t('No companies match these filters') : t('No companies yet')}
              >
                {rows?.map((c) => (
                  <CompanyRow
                    key={c.id}
                    c={c}
                    selectable={canManage}
                    selected={selected.has(c.id)}
                    onToggle={() => toggle(c.id)}
                    onOpen={() => navigate(`/companies/${c.id}`)}
                    industry={industryName(c.industry)}
                    country={countryName(c.country)}
                    size={sizeName(c.employeeRange)}
                  />
                ))}
              </Table>
            )}
            {data && data.total > 0 ? (
              <div className="foot">
                <Pager
                  page={data.page}
                  pageSize={data.pageSize}
                  total={data.total}
                  onPage={(page) => update({ page: page > 1 ? page : undefined })}
                  sizes={PAGE_SIZES}
                  onPageSize={(size) => update({ size: size === DEFAULT_PAGE_SIZE ? undefined : size })}
                />
              </div>
            ) : null}
          </Tabs>
        </section>
      </div>
      {adding ? <CompanyModal onClose={() => setAdding(false)} /> : null}
    </>
  );
}

type RowProps = {
  c: CompanyListRow;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  industry: string | null;
  country: string | null;
  size: string | null;
};

/** A list row in the prototype's columns; the CO- number sits under the name so it stays searchable at a glance. */
function CompanyRow({ c, selectable, selected, onToggle, onOpen, industry, country, size }: RowProps) {
  const t = useT();
  const dim = <span className="dim">—</span>;
  const site = c.domain ? safeUrl(`https://${c.domain}`) : null;
  return (
    <tr className={selected ? 'sel clickable' : 'clickable'} onClick={onOpen}>
      {selectable ? (
        <td onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={t('Select {name}', { name: c.name })} />
        </td>
      ) : null}
      <td>
        <div className="co-cell">
          <span className="logo" aria-hidden="true">
            {initials(c.name)}
          </span>
          <div>
            {/* The link makes the row reachable by keyboard; mouse users can click anywhere on the row. */}
            <Link to={`/companies/${c.id}`} className="row-link" onClick={(e) => e.stopPropagation()}>
              {c.name}
            </Link>
            {c.isClient ? (
              <>
                {' '}
                <span className="badge b-ok">{t('Client')}</span>
              </>
            ) : null}
            <span className="cell-sub">{c.number}</span>
          </div>
        </div>
      </td>
      <td>
        {site ? (
          <a href={site} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            {c.domain}
          </a>
        ) : (
          dim
        )}
      </td>
      <td>{industry ?? <span className="dim">{t('Unknown')}</span>}</td>
      <td>{country ?? dim}</td>
      <td>{c.city ?? dim}</td>
      <td>{size ?? dim}</td>
      <td className="num">{c.contactCount}</td>
      <td className="num">{c.leadCount}</td>
      <td>
        <span className={verificationBadge(c.verificationStatus)}>{verificationText(t, c.verificationStatus)}</span>
      </td>
      <td>
        <span className={companyStatusBadge(c.status)}>{companyStatusText(t, c.status)}</span>
      </td>
    </tr>
  );
}
