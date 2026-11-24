import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MAIL_VIEWS, useMailList, useMailMessage, useMailMeta, useSyncNow, type MailFilter, type MailItem, type MailView } from '../../api/mail';
import { clientName } from '../../api/companies';
import { useTemplates } from '../../api/templates';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { useStoredFlag } from '../../hooks/useStoredFlag';
import { initials } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';
import { fillTemplate, fillTemplateHtml } from '../../lib/mergeFields';
import { ComposeModal, type ComposeStart } from './ComposeModal';
import { Reader } from './Reader';

/** Where the Email screen fits the window and the list scrolls in its own column (app.css). */
const WIDE = '(min-width:1100px)';

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
 * No page numbers (owner, 23 Nov 2026): the list loads the next 50 when scrolled near its foot.
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
  const filter: MailFilter = {
    view, company: num(params.get('company')), lead: num(params.get('lead')), project: num(params.get('project')), s: params.get('s') ?? undefined,
  };
  const { data: meta } = useMailMeta();
  const { items, total, isLoading, hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage } = useMailList(filter);
  const { data: templates } = useTemplates();
  const sync = useSyncNow();
  const [compose, setCompose] = useState<ComposeStart | null>(null);
  const [search, setSearch] = useState(filter.s ?? '');
  const rowsRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => setSearch(params.get('s') ?? ''), [params]);

  // Another folder, filter or search starts at the top of the list (on desktop its rows scroll inside their column).
  const listKey = JSON.stringify(filter);
  useEffect(() => {
    if (rowsRef.current) rowsRef.current.scrollTop = 0;
  }, [listKey]);

  // Desktop or not (the 1100 px breakpoint where the rows start scrolling in their own column), followed on resize.
  const [wide, setWide] = useState(() => window.matchMedia?.(WIDE).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(WIDE);
    if (!media) return;
    const change = () => setWide(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  /**
   * The next batch loads when the list's foot comes near: within the rows' own column on desktop (owner, 23 Nov 2026:
   * the screen fits the window), within the window where the page itself scrolls (chosen again when the window crosses
   * the breakpoint). Watching again after each batch keeps loading while the foot is still in view (a tall screen).
   * Nothing is watched while the previous filter's rows stand in for the new ones, so its first batch is asked once.
   */
  const loaded = items.length;
  useEffect(() => {
    const foot = moreRef.current;
    if (!foot || !hasNextPage || isFetchingNextPage || isPlaceholderData || typeof IntersectionObserver === 'undefined') return;
    const rows = rowsRef.current;
    const root = rows && getComputedStyle(rows).overflowY !== 'visible' ? rows : null;
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void fetchNextPage();
    }, { root, rootMargin: '0px 0px 300px 0px' });
    watch.observe(foot);
    return () => watch.disconnect();
  }, [hasNextPage, isFetchingNextPage, isPlaceholderData, loaded, listKey, wide, fetchNextPage]);

  const selectedId = num(id ?? null) ?? items[0]?.id ?? null;
  // The message opened from a link (the Reader's own query): a list answered before the open marked it read
  // still shows its row as read.
  const { data: opened } = useMailMessage(num(id ?? null) ?? null);
  const mailbox = meta?.mailbox ?? null;
  const connected = mailbox?.status === 'connected';
  const lang = me.language;
  const shownTemplates = useMemo(
    () => [...(templates ?? [])].sort((a, b) => Number(b.language === lang) - Number(a.language === lang)).slice(0, 6),
    [templates, lang],
  );

  /** Same screen with some query values changed (selection kept only when asked). */
  const href = (change: Record<string, string | undefined>, keepId = false) => {
    const q = new URLSearchParams(params);
    for (const [k, v] of Object.entries(change)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    const s = q.toString();
    return `/email${keepId && id ? `/${id}` : ''}${s ? `?${s}` : ''}`;
  };
  const setQuery = (change: Record<string, string | undefined>) => navigate(href(change));

  // ?page= and ?size= from the old pager (bookmarks, old links) mean nothing now: they leave the address.
  const oldPaging = params.has('page') || params.has('size');
  useEffect(() => {
    if (oldPaging) navigate(href({ page: undefined, size: undefined }, true), { replace: true });
    // Only their arrival in the address should trigger this.
  }, [oldPaging]);

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

  // Owner addition (23 Nov 2026): the folders / templates column folds to a strip, remembered in this browser. The
  // folder and filters live in the address, so folding loses neither.
  const [foldersClosed, setFoldersClosed] = useStoredFlag('dait-mail-folders-collapsed');
  const foldName = foldersClosed ? t('Expand folders') : t('Collapse folders');
  const foldButton = (
    <button
      type="button"
      className="folders-toggle"
      aria-expanded={!foldersClosed}
      aria-controls="mail-folders"
      aria-label={foldName}
      title={foldName}
      onClick={() => setFoldersClosed(!foldersClosed)}
    >
      {Icons.fold}
    </button>
  );

  const folder = (v: MailView, count?: number, hot = false) => (
    <Link key={v} className={view === v ? 'fold on' : 'fold'} to={href({ folder: v === 'inbox' ? undefined : v })} aria-current={view === v ? 'page' : undefined}>
      {viewLabel(t, v)}
      {count ? <span className={hot ? 'cnt hot' : 'cnt'}>{count}</span> : null}
    </Link>
  );

  const metaCompany = meta?.companies.find((c) => c.id === filter.company);
  const companyName = metaCompany ? clientName(metaCompany) : undefined;
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
            <option key={c.id} value={c.id}>{c.isClient ? `${clientName(c)} · ${t('client|project')}` : clientName(c)}</option>
          ))}
        </select>
        <select
          className="chip mail-pick"
          aria-label={t('Lead')}
          value={filter.lead ?? ''}
          onChange={(e) => {
            const l = meta?.leads.find((x) => x.id === Number(e.target.value));
            // As the prototype's fLead change: the project filter is dropped.
            setQuery({ lead: e.target.value || undefined, company: l?.companyId ? String(l.companyId) : params.get('company') ?? undefined, project: undefined });
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
        <nav id="mail-folders" className={foldersClosed ? 'folders collapsed' : 'folders'} aria-label={t('Mail folders')}>
          {/* One toggle in both states, so it keeps the keyboard focus when pressed. */}
          <div className="folders-head">{foldButton}</div>
          {/* Folded, the list is hidden by CSS on wider screens; on a phone the folders always show (no lone strip). */}
          <div className="folders-list">
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
                  setCompose({
                    subject: fillTemplate(tp.subject, ctx), body: fillTemplate(tp.body, ctx), bodyHtml: tp.bodyHtml ? fillTemplateHtml(tp.bodyHtml, ctx) : null,
                  });
                }}
              >
                {tp.name}
                {tp.sourceType === 'oft' ? <span className="mail-oft">.oft</span> : null}
              </button>
            ))}
            <Link className="fold mail-manage" to="/settings/templates">
              {t('Manage templates…')}
            </Link>
          </div>
        </nav>

        <section className="msglist" aria-label={t('Message list')}>
          <div className="msglist-head">
            <strong>{viewLabel(t, view)}</strong> · {total === 1 ? t('1 message') : t('{n} messages', { n: total })}
            {companyName ? ` · ${companyName}` : ''}
            {leadNumber ? ` · ${leadNumber}` : ''}
          </div>
          {/* The rows scroll on their own on desktop. */}
          <div className="msglist-rows" ref={rowsRef}>
            {items.map((m) => (
              <MessageRow key={m.id} m={opened?.id === m.id && opened.isRead ? { ...m, isRead: true } : m} on={m.id === selectedId} to={`/email/${m.id}${params.toString() ? `?${params.toString()}` : ''}`} />
            ))}
            {!isLoading && items.length === 0 ? (
              <div className="empty">
                {filter.company || filter.lead || filter.project ? t('No messages for this filter in {folder}.', { folder: viewLabel(t, view) }) : t('Nothing here.')}
              </div>
            ) : null}
            {hasNextPage ? (
              <div className="msglist-more" ref={moreRef} role="status">
                {t('Loading…')}
              </div>
            ) : null}
          </div>
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
