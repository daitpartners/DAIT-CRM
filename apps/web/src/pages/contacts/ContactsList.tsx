import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CONTACT_SORTS, lookupLabel, safeUrl } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import type { SortDir } from '../../api/companies';
import { useContacts, type ContactListQuery, type ContactSort } from '../../api/contacts';
import { useLookups } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Pager } from '../../components/Pager';
import { SortHeader } from '../../components/SortHeader';
import { Table } from '../../components/Table';
import { Topbar } from '../../components/Topbar';
import { useDebounce } from '../../hooks/useDebounce';
import { errorText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { ContactModal } from '../companies/ContactModal';
import { contactName } from '../companies/tabs/ContactsTab';

const PAGE_SIZE = 25;

const isSort = (v: string | null): v is ContactSort => (CONTACT_SORTS as readonly string[]).includes(v ?? '');

/** List state lives in the address bar so Back, refresh and shared links keep the filters. */
function useListParams() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page'));
  const sortParam = params.get('sort');
  const query: ContactListQuery & { page: number; sort: ContactSort; dir: SortDir } = {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZE,
    sort: isSort(sortParam) ? sortParam : 'lastName',
    dir: params.get('dir') === 'desc' ? 'desc' : 'asc',
    q: params.get('q') || undefined,
    contactType: params.get('contactType') || undefined,
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

/** Every contact the user can see, across companies (section F, contacts page). */
export function ContactsList() {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const canManage = me.can('manage_companies');
  const { query, update } = useListParams();
  const { data, isPending, error } = useContacts(query);
  const { data: lookups } = useLookups();
  const [adding, setAdding] = useState(false);

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

  const types = lookups?.contact_type ?? [];
  const typeText = (v: string) => {
    const row = types.find((x) => x.value === v);
    return row ? lookupLabel(row, lang) : v;
  };
  const typeOptions = types.filter((x) => x.isActive || x.value === query.contactType).map((x) => ({ value: x.value, label: lookupLabel(x, lang) }));
  if (query.contactType && !typeOptions.some((o) => o.value === query.contactType)) {
    typeOptions.push({ value: query.contactType, label: query.contactType });
  }

  const onSort = (column: ContactSort) => {
    if (column === query.sort) update({ sort: column, dir: query.dir === 'asc' ? 'desc' : 'asc' });
    else update({ sort: column, dir: column === 'updatedAt' ? 'desc' : 'asc' });
  };

  const rows = data?.items;
  const filtered = Boolean(query.q || query.contactType);
  const sortable = (column: ContactSort, label: string) => (
    <SortHeader key={column} label={label} column={column} sort={query.sort} dir={query.dir} onSort={onSort} />
  );
  const plain = (key: string, content: ReactNode) => (
    <th key={key} scope="col">
      {content}
    </th>
  );
  const head = [
    sortable('lastName', t('Name')),
    sortable('company', t('Company')),
    plain('designation', t('Designation')),
    sortable('businessEmail', t('Email')),
    plain('phone', t('Phone')),
    plain('type', t('Type')),
    plain('primary', t('Primary')),
  ];
  const dim = <span className="dim">—</span>;

  return (
    <>
      <Topbar title={t('Contacts')} sub={t('People at every company you can see.')}>
        <label className="search">
          <span className="sr">{t('Search contacts')}</span>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Search name, email or company…')} />
        </label>
        {canManage ? (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            {Icons.plus}
            {t('Add contact')}
          </button>
        ) : null}
      </Topbar>
      <div className="page">
        <section className="card flush" aria-label={t('Contacts')}>
          <div className="filters">
            <label className="sr" htmlFor="flt-contact-type">
              {t('Contact type')}
            </label>
            <select id="flt-contact-type" className="chip" value={query.contactType ?? ''} onChange={(e) => update({ contactType: e.target.value })}>
              <option value="">{t('Any contact type')}</option>
              {typeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {filtered ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setText('');
                  pushed.current = '';
                  update({ q: undefined, contactType: undefined });
                }}
              >
                {t('Clear filters')}
              </button>
            ) : null}
          </div>
          {error ? (
            <div className="empty" role="alert">
              {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
            </div>
          ) : (
            <Table
              rawHead
              head={head}
              isEmpty={isPending || !rows?.length}
              empty={isPending ? t('Loading…') : filtered ? t('No contacts match these filters') : t('No contacts yet')}
            >
              {rows?.map((c) => {
                const mail = c.businessEmail ? safeUrl(`mailto:${c.businessEmail}`) : null;
                return (
                  <tr key={c.id}>
                    <td>
                      <strong>{contactName(c)}</strong>
                      {c.department ? <span className="cell-sub">{c.department}</span> : null}
                    </td>
                    <td>
                      <Link to={`/companies/${c.company.id}`} className="row-link">
                        {c.company.name}
                      </Link>
                    </td>
                    <td>{c.designation ?? dim}</td>
                    <td>{c.businessEmail ? mail ? <a href={mail}>{c.businessEmail}</a> : c.businessEmail : dim}</td>
                    <td>{c.phone ?? c.mobile ?? dim}</td>
                    <td>{typeText(c.contactType)}</td>
                    <td>{c.isPrimary ? <span className="badge b-ok">{t('Primary')}</span> : dim}</td>
                  </tr>
                );
              })}
            </Table>
          )}
          {data && data.total > 0 ? (
            <div className="foot">
              <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => update({ page: page > 1 ? page : undefined })} />
            </div>
          ) : null}
        </section>
      </div>
      {adding ? <ContactModal onClose={() => setAdding(false)} /> : null}
    </>
  );
}
