import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MAIL_PAGE_SIZE, MAIL_PAGE_SIZES, MAIL_VIEWS, useMailList, useMailMeta, useSyncNow, type MailFilter, type MailItem, type MailView } from '../../api/mail';
import { useTemplates } from '../../api/templates';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Pager } from '../../components/Pager';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { initials } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';
import { fillTemplate } from '../../lib/mergeFields';
import { ComposeModal, type ComposeStart } from './ComposeModal';
import { Reader } from './Reader';

const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

function viewLabel(t: TFn, v: MailView): string {
  switch (v) {
    case 'inbox': return t('Inbox');
    case 'sent': return t('Sent');
    case 'drafts': return t('Drafts');
    case 'archive': return t('Archive');
    case 'unlinked': return t('Unlinked');
    case 'awaiting': return t('Awaiting reply');
    case 'mine': return t('My leads');
  }
}

/**
 * The Email screen (release 2B-2; prototype views-work.js V.email): the user's own mailbox, synced every 5 minutes.
 * Folders and smart views, "Show mail for" Client / Lead / Project, search, the message list, the reader with its
 * linked records. Nobody sees anyone else's mail: the Project filter only narrows your own.
 * `?compose=1` (with `company`, `lead`, `project`) opens Compose preset (the Projects list's Email buttons).
 */
export function EmailPage() {
  const t = useT();
  const toast = useToast();
  const me = useCurrentUser();
  const navigate = useNavigate();
  const { relative } = useFormatDate();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const view: MailView = (MAIL_VIEWS as readonly string[]).includes(params.get('folder') ?? '') ? (params.get('folder') as MailView) : 'inbox';
  const page = Math.max(1, num(params.get('page')) ?? 1);
  const sizeParam = num(params.get('size')) ?? 0;
  const pageSize = (MAIL_PAGE_SIZES as readonly number[]).includes(sizeParam) ? sizeParam : MAIL_PAGE_SIZE;
  const filter: MailFilter = {
    view, company: num(params.get('company')), lead: num(params.get('lead')), project: num(params.get('project')), s: params.get('s') ?? undefined,
    page, pageSize,
  };
  const { data: meta } = useMailMeta();
  const { data: list, isLoading } = useMailList(filter);
  const { data: templates } = useTemplates();
  const sync = useSyncNow();
  const [compose, setCompose] = useState<ComposeStart | null>(null);
  const [search, setSearch] = useState(filter.s ?? '');
  const listRef = useRef<HTMLElement>(null);
  useEffect(() => setSearch(params.get('s') ?? ''), [params]);

  const items = list?.items ?? [];
  const total = list?.total ?? 0;
  const selectedId = num(id ?? null) ?? items[0]?.id ?? null;
  const mailbox = meta?.mailbox ?? null;
  const connected = mailbox?.status === 'connected';
  const lang = me.language;
  const shownTemplates = useMemo(
    () => [...(templates ?? [])].sort((a, b) => Number(b.language === lang) - Number(a.language === lang)).slice(0, 6),
    [templates, lang],
  );

  /**
   * Same screen with some query values changed (selection kept only when asked). A change of folder, filter, search
   * or rows per page goes back to page 1, as the other lists; a change with nothing in it keeps the page.
   */
  const href = (change: Record<string, string | undefined>, keepId = false) => {
    const q = new URLSearchParams(params);
    if (!('page' in change) && Object.keys(change).length) q.delete('page');
    for (const [k, v] of Object.entries(change)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    const s = q.toString();
    return `/email${keepId && id ? `/${id}` : ''}${s ? `?${s}` : ''}`;
  };
  const setQuery = (change: Record<string, string | undefined>) => navigate(href(change));

  // A Compose link (`?compose=1&company=…&lead=…&project=…`) opens Compose once; the filters stay in the address.
  const composeLink = params.get('compose') === '1';
  useEffect(() => {
    if (!composeLink) return;
    setCompose({ companyId: filter.company, leadId: filter.lead, projectId: filter.project });
    const q = new URLSearchParams(params);
    q.delete('compose');
    const s = q.toString();
    navigate(`/email${id ? `/${id}` : ''}${s ? `?${s}` : ''}`, { replace: true });
    // Only the link's arrival should trigger this.
  }, [composeLink]);

  // A page past the end (old link, or the last messages archived): go to the last page that has messages.
  useEffect(() => {
    if (!list || list.items.length > 0 || list.total === 0) return;
    const last = Math.ceil(list.total / list.pageSize);
    if (list.page > last) navigate(href({ page: last > 1 ? String(last) : undefined }, true), { replace: true });
    // Only new data should trigger this.
  }, [list]);

  const folder = (v: MailView, count?: number, hot = false) => (
    <Link key={v} className={view === v ? 'fold on' : 'fold'} to={href({ folder: v === 'inbox' ? undefined : v })}>
      {viewLabel(t, v)}
      {count ? <span className={hot ? 'cnt hot' : 'cnt'}>{count}</span> : null}
    </Link>
  );

  const companyName = meta?.companies.find((c) => c.id === filter.company)?.name;
  const leadOptions = (meta?.leads ?? []).filter((l) => !filter.company || l.companyId === filter.company);
  const leadNumber = meta?.leads.find((l) => l.id === filter.lead)?.number;
  const projectOptions = (meta?.projects ?? []).filter((p) => !filter.company || p.companyId === filter.company);

  const sub = !meta ? null : mailbox ? (
    <>
      {t('{address} · Microsoft 365', { address: mailbox.address })}{' '}
      {connected ? <span className="badge b-ok">{t('Connected')}</span> : <span className="badge b-warn">{t('Needs reconnecting')}</span>} ·{' '}
      {mailbox.lastSyncAt ? t('synced {when}', { when: relative(mailbox.lastSyncAt) }) : t('synced never')} ·{' '}
      {t('every thread links to a Lead, Contact and Company')}
    </>
  ) : (
    <>
      {me.email} · <span className="badge b-warn">{t('Mailbox not connected')}</span>
    </>
  );

  return (
    <>
      <Topbar title={t('Email')} sub={sub}>
        {connected ? (
          <button
            type="button"
            className="btn"
            disabled={sync.isPending}
            onClick={() => sync.mutate(mailbox.id, { onSuccess: () => toast(t('Sync started — new mail appears in a few seconds')), onError: () => toast(t('Sync could not start. Try again.'), 'warn') })}
          >
            {t('Sync now')}
          </button>
        ) : (
          <Link className="btn" to="/settings/connections">
            {t('Connect Microsoft 365')}
          </Link>
        )}
        <button
          type="button"
          className="btn primary"
          onClick={() => setCompose({ companyId: filter.company, companyName, leadId: filter.lead, projectId: filter.project })}
        >
          {t('+ Compose')}
        </button>
      </Topbar>

      {meta && !mailbox ? (
        <div className="mail-connect">
          <span>
            <strong>{t('Connect your mailbox to send and receive from the CRM.')}</strong>{' '}
            {t('Your Microsoft 365 Business Basic account works out of the box; sign in once and the CRM syncs mail and calendar through Microsoft Graph.')}
          </span>
          <div className="grow" />
          <Link className="btn primary" to="/settings/connections">
            {t('Connect Microsoft 365')}
          </Link>
        </div>
      ) : null}

      <div className="filters mail-filters">
        <span className="mail-for">{t('Show mail for')}</span>
        <select
          className="chip mail-pick"
          aria-label={t('Client / company')}
          value={filter.company ?? ''}
          onChange={(e) => setQuery({ company: e.target.value || undefined, lead: undefined, project: undefined })}
        >
          <option value="">{t('Client: all')}</option>
          {(meta?.companies ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          className="chip mail-pick"
          aria-label={t('Lead')}
          value={filter.lead ?? ''}
          onChange={(e) => {
            const l = meta?.leads.find((x) => x.id === Number(e.target.value));
            setQuery({ lead: e.target.value || undefined, company: l?.companyId ? String(l.companyId) : params.get('company') ?? undefined });
          }}
        >
          <option value="">{filter.company ? t('Lead: all for this client') : t('Lead: all')}</option>
          {leadOptions.map((l) => (
            <option key={l.id} value={l.id}>{`${l.number} · ${l.companyName}`}</option>
          ))}
        </select>
        <select
          className="chip mail-pick"
          aria-label={t('Project')}
          value={filter.project ?? ''}
          onChange={(e) => {
            const p = meta?.projects.find((x) => x.id === Number(e.target.value));
            setQuery({ project: e.target.value || undefined, company: p ? String(p.companyId) : params.get('company') ?? undefined });
          }}
        >
          <option value="">{filter.company ? t('Project: all for this client') : t('Project: all')}</option>
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>{`${p.number} · ${p.name}`}</option>
          ))}
        </select>
        {filter.company || filter.lead || filter.project ? (
          <Link className="btn sm" to={href({ company: undefined, lead: undefined, project: undefined })}>
            {t('✕ Clear')}
          </Link>
        ) : null}
        <div className="grow" />
        <form
          className="search mail-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery({ s: search.trim() || undefined });
          }}
        >
          {Icons.search}
          <label className="sr" htmlFor="mail-search">{t('Search mail')}</label>
          <input
            id="mail-search"
            type="search"
            value={search}
            placeholder={t('Search subject, sender, text…')}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => search.trim() !== (filter.s ?? '') && setQuery({ s: search.trim() || undefined })}
          />
        </form>
      </div>

      <div className="mail">
        <nav className="folders" aria-label={t('Mail folders')}>
          {folder('inbox', meta?.unread)}
          {folder('sent')}
          {folder('drafts')}
          {folder('archive')}
          <div className="navsec mail-sec">{t('Smart views')}</div>
          {folder('unlinked', meta?.unlinked, true)}
          {folder('awaiting')}
          {folder('mine')}
          <div className="navsec mail-sec">{t('Templates')}</div>
          {shownTemplates.map((tp) => (
            <button
              key={tp.id}
              type="button"
              className="fold"
              title={tp.subject}
              onClick={() => {
                const ctx = { firstName: '', company: '', me: me.name, leadNumber: '' };
                setCompose({ subject: fillTemplate(tp.subject, ctx), body: fillTemplate(tp.body, ctx) });
              }}
            >
              {tp.name}
              {tp.sourceType === 'oft' ? <span className="mail-oft">.oft</span> : null}
            </button>
          ))}
          <Link className="fold mail-manage" to="/settings/templates">
            {t('Manage templates…')}
          </Link>
        </nav>

        <section className="msglist" aria-label={t('Message list')} ref={listRef}>
          <div className="msglist-head">
            <strong>{viewLabel(t, view)}</strong> · {total}
            {companyName ? ` · ${companyName}` : ''}
            {leadNumber ? ` · ${leadNumber}` : ''}
          </div>
          {items.map((m) => (
            <MessageRow key={m.id} m={m} on={m.id === selectedId} to={`/email/${m.id}${params.toString() ? `?${params.toString()}` : ''}`} />
          ))}
          {!isLoading && items.length === 0 ? (
            <div className="empty">
              {filter.company || filter.lead || filter.project ? t('No messages for this filter in {folder}.', { folder: viewLabel(t, view) }) : t('Nothing here.')}
            </div>
          ) : null}
          {/* Owner request (22 Nov 2026), not in the prototype: the Leads / Companies pager, 50 rows by default. */}
          {list && list.total > 0 ? (
            <Pager
              page={list.page}
              pageSize={list.pageSize}
              total={list.total}
              onPage={(p) => {
                setQuery({ page: p > 1 ? String(p) : undefined });
                // The pager sits under 50 rows: show the new page from its top.
                listRef.current?.scrollIntoView?.({ block: 'start' });
              }}
              sizes={MAIL_PAGE_SIZES}
              onPageSize={(size) => setQuery({ size: size === MAIL_PAGE_SIZE ? undefined : String(size) })}
            />
          ) : null}
        </section>

        {selectedId !== null ? (
          <Reader
            id={selectedId}
            peek={num(id ?? null) === undefined}
            connected={connected}
            onReply={(start) => setCompose(start)}
            onArchived={() => navigate(href({}, false))}
          />
        ) : (
          <div className="reader empty">{t('Select a message.')}</div>
        )}
      </div>

      {compose ? <ComposeModal start={compose} connected={connected} from={mailbox?.address ?? null} onClose={() => setCompose(null)} /> : null}
    </>
  );
}

function MessageRow({ m, on, to }: { m: MailItem; on: boolean; to: string }) {
  const t = useT();
  const { relative } = useFormatDate();
  // Prototype list row: rel(e.at).replace(/, /, ' ') — "Today 09:05", no comma.
  const outbound = m.status !== 'received';
  const who = outbound ? t('To: {to}', { to: m.toAddresses.join(', ') }) : m.fromName || m.fromAddress;
  return (
    <Link className={`msg${on ? ' on' : ''}${m.isRead ? '' : ' unread'}`} to={to} aria-current={on ? 'true' : undefined}>
      <span className="av" aria-hidden="true">{initials(m.fromName || m.fromAddress)}</span>
      <span className="msg-main">
        <span className="who">
          <span className="msg-who">{who}</span> <span className="t">{relative(m.occurredAt).replace(', ', ' ')}</span>
        </span>
        <span className="sub">{m.subject || t('(no subject)')}</span>
        <span className="pre">{m.preview}</span>
        <span className="msg-tags">
          {m.leadNumber ? <span className="badge b-purple">{m.leadNumber}</span> : <span className="badge b-warn">{t('Unlinked · create lead?')}</span>}
          {m.projectNumber ? <span className="badge b-ok">{m.projectNumber}</span> : null}
          {m.status === 'failed' ? <span className="badge b-bad">{t('Failed')}</span> : null}
          {m.status === 'queued' || m.status === 'sending' ? <span className="badge b-grey">{t('Sending')}</span> : null}
        </span>
      </span>
    </Link>
  );
}
