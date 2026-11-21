import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { COMPANY_SORTS, CompanyStatus, formatDate, lookupLabel } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { useCompanies, type CompanyListQuery, type CompanySort, type CompanySummary, type SortDir } from '../../api/companies';
import { keys, useLookups, type LookupValue } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Combobox, type ComboOption } from '../../components/Combobox';
import { useConfirm } from '../../components/ConfirmDialog';
import { Icons } from '../../components/Icons';
import { Pager } from '../../components/Pager';
import { SortHeader } from '../../components/SortHeader';
import { Table } from '../../components/Table';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useDebounce } from '../../hooks/useDebounce';
import { companyStatusBadge, companyStatusText, errorText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { CompanyModal } from './CompanyModal';

const PAGE_SIZE = 25;
/** Combobox value meaning "no filter" (the combobox cannot hold an empty value). */
const ANY = '*';

const isSort = (v: string | null): v is CompanySort => (COMPANY_SORTS as readonly string[]).includes(v ?? '');

/** List state lives in the address bar so Back, refresh and shared links keep the filters. */
function useListParams() {
  const [params, setParams] = useSearchParams();
  const status = CompanyStatus.safeParse(params.get('status'));
  const page = Number(params.get('page'));
  const sortParam = params.get('sort');
  const query: CompanyListQuery & { page: number; sort: CompanySort; dir: SortDir } = {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZE,
    sort: isSort(sortParam) ? sortParam : 'name',
    dir: params.get('dir') === 'desc' ? 'desc' : 'asc',
    q: params.get('q') || undefined,
    status: status.success ? status.data : undefined,
    country: params.get('country') || undefined,
    industry: params.get('industry') || undefined,
  };
  /** Sets (or with '' / undefined removes) params; any change other than the page goes back to page 1. */
  const update = (patch: Record<string, string | number | undefined>, replace = false) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === '') next.delete(k);
          else next.set(k, String(v));
        }
        if (!('page' in patch)) next.delete('page');
        return next;
      },
      { replace },
    );
  };
  return { query, update };
}

export function CompaniesList() {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const canManage = me.can('manage_companies');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { query, update } = useListParams();
  const { data, isPending, error } = useCompanies(query);
  const { data: lookups } = useLookups();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Search box: typed text goes to the URL 300 ms after the last keystroke.
  const [text, setText] = useState(query.q ?? '');
  const debouncedText = useDebounce(text, 300);
  const pushed = useRef(query.q ?? '');
  useEffect(() => {
    const q = debouncedText.trim();
    if (q === (query.q ?? '')) return;
    pushed.current = q;
    update({ q }, true);
    // Only a settled keystroke writes the URL, so `query.q` is deliberately not a dependency.
  }, [debouncedText]);
  useEffect(() => {
    // Back/forward changed q: show it, unless it is the value this box just wrote.
    if ((query.q ?? '') !== pushed.current) {
      pushed.current = query.q ?? '';
      setText(query.q ?? '');
    }
  }, [query.q]);

  // A page past the end (old link, or rows removed since): go to the last page that has rows.
  useEffect(() => {
    if (!data || data.items.length > 0 || data.total === 0) return;
    const last = Math.ceil(data.total / data.pageSize);
    if (data.page > last) update({ page: last > 1 ? last : undefined }, true);
    // `update` is recreated every render; only new data should trigger this.
  }, [data]);

  // Selection only covers rows on screen: clear it when a different set of rows is shown.
  const rows = data?.items;
  const rowIds = rows?.map((r) => r.id).join(',');
  useEffect(() => setSelected(new Set()), [rowIds]);

  const label = (group: 'country' | 'industry') => (v: string | null) => {
    if (!v) return null;
    const row = lookups?.[group]?.find((x) => x.value === v);
    return row ? lookupLabel(row, lang) : v;
  };
  const countryName = label('country');
  const industryName = label('industry');

  const filterOptions = (group: 'country' | 'industry', any: string, current?: string): ComboOption[] => {
    const values: LookupValue[] = (lookups?.[group] ?? []).filter((x) => x.isActive || x.value === current);
    const opts = values.map((x) => ({ value: x.value, label: lookupLabel(x, lang) }));
    if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
    return [{ value: ANY, label: any }, ...opts];
  };
  const countryOptions = useMemo(() => filterOptions('country', t('Any country'), query.country), [lookups, lang, query.country, t]);
  const industryOptions = useMemo(() => filterOptions('industry', t('Any industry'), query.industry), [lookups, lang, query.industry, t]);

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

  const fmt = (d: string) => formatDate(d, { locale: me.language, timezone: me.timezone, dateFormat: me.dateFormat });
  const allOnPage = Boolean(rows?.length) && rows!.every((r) => selected.has(r.id));
  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allOnPage ? new Set() : new Set(rows?.map((r) => r.id)));
  const filtered = Boolean(query.q || query.status || query.country || query.industry);

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
    plain('number', t('Number')),
    sortable('name', t('Name')),
    sortable('industry', t('Industry')),
    sortable('country', t('Country')),
    plain('contact', t('Primary contact')),
    sortable('status', t('Status')),
    sortable('updatedAt', t('Last updated')),
  ];

  return (
    <>
      <Topbar title={t('Companies')} sub={t('Master database of every organisation. A company is not a lead.')}>
        <label className="search">
          <span className="sr">{t('Search companies')}</span>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Search name, domain or number…')} />
        </label>
        {canManage ? (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            {Icons.plus}
            {t('Add company')}
          </button>
        ) : null}
      </Topbar>
      <div className="page">
        <section className="card flush" aria-label={t('Companies')}>
          <div className="filters">
            <label className="sr" htmlFor="flt-status">
              {t('Status')}
            </label>
            <select id="flt-status" className="chip" value={query.status ?? ''} onChange={(e) => update({ status: e.target.value })}>
              <option value="">{t('Any status')}</option>
              {CompanyStatus.options.map((s) => (
                <option key={s} value={s}>
                  {companyStatusText(t, s)}
                </option>
              ))}
            </select>
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
            {filtered ? (
              <button type="button" className="btn sm" onClick={() => { setText(''); pushed.current = ''; update({ q: undefined, status: undefined, country: undefined, industry: undefined }); }}>
                {t('Clear filters')}
              </button>
            ) : null}
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
                  updated={fmt(c.updatedAt)}
                />
              ))}
            </Table>
          )}
          {data && data.total > 0 ? (
            <div className="foot">
              <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => update({ page: page > 1 ? page : undefined })} />
            </div>
          ) : null}
        </section>
      </div>
      {adding ? <CompanyModal onClose={() => setAdding(false)} /> : null}
    </>
  );
}

type RowProps = {
  c: CompanySummary;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  industry: string | null;
  country: string | null;
  updated: string;
};

function CompanyRow({ c, selectable, selected, onToggle, onOpen, industry, country, updated }: RowProps) {
  const t = useT();
  const dim = <span className="dim">—</span>;
  return (
    <tr className={selected ? 'sel clickable' : 'clickable'} onClick={onOpen}>
      {selectable ? (
        <td onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={t('Select {name}', { name: c.name })} />
        </td>
      ) : null}
      <td>{c.number}</td>
      <td>
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
      </td>
      <td>{industry ?? dim}</td>
      <td>{country ?? dim}</td>
      <td>{c.primaryContact ? c.primaryContact.name : dim}</td>
      <td>
        <span className={companyStatusBadge(c.status)}>{companyStatusText(t, c.status)}</span>
      </td>
      <td>{updated}</td>
    </tr>
  );
}
