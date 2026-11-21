import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LEAD_SORTS, LEAD_TABS, LEAD_TYPES, PRIORITIES, lookupLabel, type LeadType, type Priority } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import {
  useBulkLeads, useClaimLead, useLeads, type LeadListQuery, type LeadSort, type LeadSummary, type LeadTab,
} from '../../api/leads';
import { useLookups, useUsers, type LookupValue } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Combobox, type ComboOption } from '../../components/Combobox';
import { useConfirm } from '../../components/ConfirmDialog';
import { FormField } from '../../components/FormField';
import { Icons } from '../../components/Icons';
import { Modal } from '../../components/Modal';
import { Pager } from '../../components/Pager';
import { SortHeader } from '../../components/SortHeader';
import { PriorityLabel, StatusBadge } from '../../components/StatusBadge';
import { Table } from '../../components/Table';
import { Tabs } from '../../components/Tabs';
import { Tile } from '../../components/Tile';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { usePageClamp, useUrlListState } from '../../hooks/useUrlListState';
import { errorText, leadStatusText, leadTypeText, priorityText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { CsvImportModal } from './CsvImportModal';
import { LeadModal } from './LeadModal';

const PAGE_SIZE = 25;
/** Combobox value meaning "no filter" (the combobox cannot hold an empty value). */
const ANY = '*';
/** Filters kept in the URL and cleared by "Clear filters"; the tab (also in the URL) is not one. */
const FILTERS = ['status', 'source', 'country', 'assignedTo', 'priority', 'leadType', 'from', 'to'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const oneOf = <T extends string>(list: readonly T[], v: string | undefined): T | undefined =>
  v !== undefined && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/** A bulk assignment waiting for confirmation (and a note when leads change hands). */
type PendingAssign = { ids: number[]; toUserId: number | null; toName: string; needsNote: boolean };

/** Leads module list (prototype V.leads2List): tiles, tab bar, filters, a paged table and bulk actions. */
export function LeadsList() {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const canManage = me.can('manage_leads');
  const seesAll = me.can('view_all_leads');
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { day, date } = useFormatDate();
  const [searchParams] = useSearchParams();
  const { params, set: update, reset, search } = useUrlListState({ sorts: LEAD_SORTS, defaultSort: 'createdAt', extra: FILTERS });
  // Without an explicit sort the API lists newest first.
  const explicitSort = searchParams.has('sort');
  const sort: LeadSort = params.sort;
  const dir = explicitSort ? params.dir : 'desc';
  const tab: LeadTab = oneOf(LEAD_TABS, searchParams.get('tab') ?? undefined) ?? 'all';
  const assignedNum = Number(params.assignedTo);
  const query: LeadListQuery = {
    page: params.page,
    pageSize: PAGE_SIZE,
    ...(explicitSort ? { sort, dir } : {}),
    q: params.q,
    tab: tab === 'all' ? undefined : tab,
    status: params.status,
    source: params.source,
    country: params.country,
    assignedTo: params.assignedTo === 'none' ? 'none' : Number.isInteger(assignedNum) && assignedNum > 0 ? assignedNum : undefined,
    priority: oneOf<Priority>(PRIORITIES, params.priority),
    leadType: oneOf<LeadType>(LEAD_TYPES, params.leadType),
    from: params.from && DAY.test(params.from) ? params.from : undefined,
    to: params.to && DAY.test(params.to) ? params.to : undefined,
  };
  const { data, isPending, error } = useLeads(query);
  const { data: lookups } = useLookups();
  const { data: users } = useUsers();
  const bulk = useBulkLeads();
  const claim = useClaimLead();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [assigning, setAssigning] = useState<PendingAssign | null>(null);

  usePageClamp(data, update);

  // Selection only covers rows on screen: clear it when a different set of rows is shown.
  const rows = data?.items;
  const rowIds = rows?.map((r) => r.id).join(',');
  useEffect(() => setSelected(new Set()), [rowIds]);

  const lookupText = (group: 'country' | 'lead_source', v: string) => {
    const row = lookups?.[group]?.find((x) => x.value === v);
    return row ? lookupLabel(row, lang) : v;
  };
  const lookupOptions = (group: 'country' | 'lead_source' | 'lead_status', current?: string): LookupValue[] =>
    (lookups?.[group] ?? []).filter((x) => x.isActive || x.value === current);
  const countryOptions = useMemo<ComboOption[]>(() => {
    const opts = lookupOptions('country', query.country).map((x) => ({ value: x.value, label: lookupLabel(x, lang) }));
    if (query.country && !opts.some((o) => o.value === query.country)) opts.push({ value: query.country, label: query.country });
    return [{ value: ANY, label: t('Any country') }, ...opts];
  }, [lookups, lang, query.country, t]);

  // Who leads can be assigned to, as the API allows: Administrator / Manager anyone active, others themselves.
  const others = seesAll ? (users ?? []).filter((u) => u.isActive && u.id !== me.id).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const canUnassign = seesAll || me.role === 'Sales Representative';

  function startAssign(value: string) {
    if (!value || !rows) return;
    const toUserId = value === 'none' ? null : Number(value);
    const toName = toUserId === null ? t('Unassigned') : toUserId === me.id ? t('Me') : (others.find((u) => u.id === toUserId)?.name ?? '');
    const ids = [...selected];
    const needsNote = rows.some((r) => selected.has(r.id) && r.assignedTo !== null && r.assignedTo.id !== toUserId);
    setAssigning({ ids, toUserId, toName, needsNote });
  }

  async function archive() {
    const ids = [...selected];
    const ok = await confirm({
      title: t('Archive leads?'),
      body: t('Archive {n} selected leads? Archived leads no longer appear in lists, tasks or counts.', { n: ids.length }),
      confirmLabel: t('Archive'),
      danger: true,
    });
    if (!ok) return;
    bulk.mutate(
      { ids, action: 'archive' },
      {
        onSuccess: ({ updated }) => {
          setSelected(new Set());
          toast(t('Leads archived: {n}', { n: updated }));
        },
        onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
      },
    );
  }

  function claimLead(lead: LeadSummary) {
    claim.mutate(lead, {
      onSuccess: (saved) => toast(t('{number} is now yours', { number: saved.number })),
      onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
    });
  }

  const onSort = (column: LeadSort) => {
    if (column === sort) update({ sort: column, dir: dir === 'asc' ? 'desc' : 'asc' });
    // Newest first is the useful default for dates; A–Z for text.
    else update({ sort: column, dir: column === 'createdAt' || column === 'nextFollowUp' ? 'desc' : 'asc' });
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
  const filtered = Boolean(
    query.q || query.status || query.source || query.country || query.assignedTo || query.priority || query.leadType || query.from || query.to,
  );

  const sortable = (column: LeadSort, label: string) => (
    <SortHeader key={column} label={label} column={column} sort={sort} dir={dir} onSort={onSort} />
  );
  const plain = (key: string, content: ReactNode) => (
    <th key={key} scope="col">
      {content}
    </th>
  );
  const head = [
    ...(canManage
      ? [plain('select', <input type="checkbox" checked={allOnPage} onChange={toggleAll} disabled={!rows?.length} aria-label={t('Select all leads on this page')} />)]
      : []),
    sortable('number', t('Lead ID')),
    sortable('companyName', t('Company name')),
    sortable('contact', t('Contact person')),
    sortable('country', t('Country')),
    sortable('leadType', t('Type')),
    sortable('leadSource', t('Source')),
    sortable('status', t('Status')),
    sortable('priority', t('Priority')),
    sortable('assignedTo', t('Assigned to')),
    sortable('nextFollowUp', t('Next follow-up')),
    sortable('createdAt', t('Created')),
  ];

  const counts = data?.counts;
  const tabs = [
    { id: 'all', label: t('All leads'), count: counts?.all },
    { id: 'leads', label: t('Leads'), count: counts?.leads },
    { id: 'prospects', label: t('Prospects'), count: counts?.prospects },
    { id: 'mine', label: t('My leads'), count: counts?.mine },
    { id: 'overdue', label: t('Overdue follow-ups'), count: counts?.overdue },
    { id: 'unassigned', label: t('Unassigned'), count: counts?.unassigned },
  ];
  const tiles = data?.tiles;

  return (
    <>
      <Topbar title={t('Leads')} sub={t('Inbound leads and researched prospects, one module')}>
        <label className="search">
          <span className="sr">{t('Search leads')}</span>
          <input type="search" value={search.text} onChange={(e) => search.setText(e.target.value)} placeholder={t('Search company, contact, email…')} />
        </label>
        {canManage ? (
          <>
            <button type="button" className="btn" onClick={() => setImporting(true)}>
              {t('Import CSV')}
            </button>
            <button type="button" className="btn primary" onClick={() => setAdding(true)}>
              {Icons.plus}
              {t('New lead')}
            </button>
          </>
        ) : null}
      </Topbar>
      <div className="page">
        <div className="tiles t3">
          <Tile
            label={t('New this week')}
            value={tiles?.newThisWeek ?? '—'}
            meta={tiles ? t('{n} from website form', { n: tiles.newThisWeekFromWebsite }) : undefined}
            metaClass="ok"
          />
          <Tile
            label={t('Follow-ups due today')}
            value={tiles?.followUpsDueToday ?? '—'}
            meta={tiles ? t('{n} overdue|task', { n: tiles.overdue }) : undefined}
            metaClass="bad"
            to="/tasks"
          />
          <Tile
            label={t('Unassigned')}
            value={tiles?.unassigned ?? '—'}
            meta={t('Waiting to be claimed')}
            to="/leads?tab=unassigned"
          />
        </div>
        <section className="card flush" aria-label={t('Leads')}>
          <Tabs tabs={tabs} active={tab} onChange={(id) => update({ tab: id === 'all' ? undefined : id })} label={t('Lead views')}>
            <div className="filters">
              <label className="sr" htmlFor="flt-status">
                {t('Status')}
              </label>
              <select id="flt-status" className="chip" value={query.status ?? ''} onChange={(e) => update({ status: e.target.value })}>
                <option value="">{t('Any status')}</option>
                {lookupOptions('lead_status', query.status).map((x) => (
                  <option key={x.value} value={x.value}>
                    {leadStatusText(t, x.value)}
                  </option>
                ))}
              </select>
              <label className="sr" htmlFor="flt-source">
                {t('Source')}
              </label>
              <select id="flt-source" className="chip" value={query.source ?? ''} onChange={(e) => update({ source: e.target.value })}>
                <option value="">{t('Any source')}</option>
                {lookupOptions('lead_source', query.source).map((x) => (
                  <option key={x.value} value={x.value}>
                    {lookupLabel(x, lang)}
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
              <label className="sr" htmlFor="flt-assigned">
                {t('Assigned to')}
              </label>
              <select id="flt-assigned" className="chip" value={params.assignedTo ?? ''} onChange={(e) => update({ assignedTo: e.target.value })}>
                <option value="">{t('Anyone')}</option>
                <option value="none">{t('Unassigned')}</option>
                <option value={String(me.id)}>{t('Me')}</option>
                {others.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.name}
                  </option>
                ))}
              </select>
              <label className="sr" htmlFor="flt-priority">
                {t('Priority')}
              </label>
              <select id="flt-priority" className="chip" value={query.priority ?? ''} onChange={(e) => update({ priority: e.target.value })}>
                <option value="">{t('Any priority')}</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {priorityText(t, p)}
                  </option>
                ))}
              </select>
              <span className="date-range">
                <label className="date-chip">
                  <span>{t('Created from')}</span>
                  <input type="date" className="chip" value={query.from ?? ''} max={query.to} onChange={(e) => update({ from: e.target.value })} />
                </label>
                <label className="date-chip">
                  <span>{t('to|date')}</span>
                  <input type="date" className="chip" value={query.to ?? ''} min={query.from} onChange={(e) => update({ to: e.target.value })} />
                </label>
              </span>
              {filtered ? (
                <button type="button" className="btn sm" onClick={() => reset()}>
                  {t('Clear filters')}
                </button>
              ) : null}
            </div>
            {canManage && selected.size > 0 ? (
              <div className="bulkbar" role="region" aria-label={t('Bulk actions')}>
                <strong>{t('Selected: {n}', { n: selected.size })}</strong>
                <label className="sr" htmlFor="ld-bulk-assign">
                  {t('Assign to…')}
                </label>
                <select id="ld-bulk-assign" className="chip" value="" disabled={bulk.isPending} onChange={(e) => startAssign(e.target.value)}>
                  <option value="">{t('Assign to…')}</option>
                  <option value={String(me.id)}>{t('Me')}</option>
                  {others.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.name}
                    </option>
                  ))}
                  {canUnassign ? <option value="none">{t('Unassigned')}</option> : null}
                </select>
                <button type="button" className="btn sm" disabled={bulk.isPending} onClick={() => void archive()}>
                  {t('Archive')}
                </button>
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
                empty={isPending ? t('Loading…') : filtered ? t('No leads match these filters') : t('No leads here yet')}
              >
                {rows?.map((l) => {
                  const dim = <span className="dim">—</span>;
                  return (
                    <tr key={l.id} className={selected.has(l.id) ? 'sel clickable' : 'clickable'} onClick={() => navigate(`/leads/${l.id}`)}>
                      {canManage ? (
                        <td onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={t('Select {name}', { name: `${l.number} ${l.companyName}` })} />
                        </td>
                      ) : null}
                      <td>
                        {/* The link makes the row reachable by keyboard; mouse users can click anywhere on the row. */}
                        <Link to={`/leads/${l.id}`} className="row-link" onClick={(e) => e.stopPropagation()}>
                          {l.number}
                        </Link>
                      </td>
                      <td className="strong">{l.companyName}</td>
                      <td>{l.contact ? l.contact.name : <span className="dim">{t('No contact yet')}</span>}</td>
                      <td>{lookupText('country', l.country)}</td>
                      <td>
                        <span className={l.leadType === 'Lead' ? 'badge b-purple' : 'badge b-grey'}>{leadTypeText(t, l.leadType)}</span>
                      </td>
                      <td>{lookupText('lead_source', l.leadSource)}</td>
                      <td>
                        <StatusBadge status={l.status} />
                      </td>
                      <td>
                        <PriorityLabel priority={l.priority} />
                      </td>
                      <td>
                        {l.assignedTo ? (
                          l.assignedTo.name
                        ) : (
                          <>
                            <span className="dim">{t('Unassigned')}</span>
                            {me.can('claim_leads') ? (
                              <>
                                {' '}
                                <button
                                  type="button"
                                  className="btn xs"
                                  disabled={claim.isPending}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    claimLead(l);
                                  }}
                                >
                                  {t('Claim')}
                                </button>
                              </>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td>
                        {l.nextFollowUp ? (
                          l.isOverdue ? (
                            <span className="overdue">{t('{date} · overdue', { date: day(l.nextFollowUp) })}</span>
                          ) : (
                            day(l.nextFollowUp)
                          )
                        ) : (
                          dim
                        )}
                      </td>
                      <td className="muted">{date(l.createdAt)}</td>
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
          </Tabs>
        </section>
      </div>
      {adding ? <LeadModal onClose={() => setAdding(false)} /> : null}
      {importing ? <CsvImportModal onClose={() => setImporting(false)} /> : null}
      {assigning ? (
        <BulkAssignModal
          pending={assigning}
          busy={bulk.isPending}
          onClose={() => setAssigning(null)}
          onConfirm={(note, onFail) =>
            bulk.mutate(
              { ids: assigning.ids, action: 'assign', toUserId: assigning.toUserId, note: note || undefined },
              {
                onSuccess: ({ updated }) => {
                  setAssigning(null);
                  setSelected(new Set());
                  toast(t('Leads assigned: {n}', { n: updated }));
                },
                onError: (err) => onFail(errorText(t, err instanceof ApiError ? err.code : 'unknown')),
              },
            )
          }
        />
      ) : null}
    </>
  );
}

type BulkAssignProps = {
  pending: PendingAssign;
  busy: boolean;
  onClose: () => void;
  onConfirm: (note: string, onFail: (message: string) => void) => void;
};

/** Confirms a bulk assignment; a note is required when any of the leads is with someone else. */
function BulkAssignModal({ pending, busy, onClose, onConfirm }: BulkAssignProps) {
  const t = useT();
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [noteError, setNoteError] = useState(false);

  function submit() {
    setProblem(null);
    if (pending.needsNote && !note.trim()) {
      setNoteError(true);
      return;
    }
    onConfirm(note.trim(), setProblem);
  }

  return (
    <Modal
      title={t('Assign leads')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={submit}>
            {t('Assign')}
          </button>
        </>
      }
    >
      <p>{t('Assign {n} selected leads to {name}?', { n: pending.ids.length, name: pending.toName })}</p>
      <FormField
        id="ld-assign-note"
        label={t('Note')}
        required={pending.needsNote}
        error={noteError ? t('Add a note for the person receiving the lead') : undefined}
      >
        <textarea
          id="ld-assign-note"
          className={noteError ? 'in err' : 'in'}
          rows={3}
          value={note}
          aria-invalid={noteError}
          aria-describedby={noteError ? 'ld-assign-note-err' : 'ld-assign-note-hint'}
          onChange={(e) => {
            setNote(e.target.value);
            setNoteError(false);
          }}
        />
        {!noteError ? (
          <div id="ld-assign-note-hint" className="hint-text">
            {pending.needsNote ? t('Some of these leads are with someone else: say why they are moving.') : t('Optional.')}
          </div>
        ) : null}
      </FormField>
      {problem ? (
        <div className="note warn" role="alert">
          {problem}
        </div>
      ) : null}
    </Modal>
  );
}
