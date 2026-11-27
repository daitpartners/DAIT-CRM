import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MAIL_CHIPS, MAIL_SORTS, MAIL_VIEWS, useMailList, useMailMessage, useMailMeta, type ListSort, type MailChip, type MailFilter } from '../../api/mail';
import { clientName } from '../../api/companies';
import { useCurrentUser } from '../../api/useCurrentUser';
import { useStoredFlag } from '../../hooks/useStoredFlag';
import { useT } from '../../i18n/useT';
import { ComposeModal, type ComposeStart } from './ComposeModal';
import { FolderPane, viewLabel } from './FolderPane';
import { MailTopBar, type MailSearch } from './MailTopBar';
import { LeadPanel } from './LeadPanel';
import { MessageList } from './MessageList';
import { ReadingPane } from './ReadingPane';
import { CommandBar } from './CommandBar';
import { rowTarget, selectionTarget, useMailCommands, type MailTarget } from './useMailCommands';

const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
const oneOf = <T extends string>(list: readonly T[], v: string | null): T | undefined => ((list as readonly string[]).includes(v ?? '') ? (v as T) : undefined);
const DATES = ['today', '7d', '30d', '12m', 'custom'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `?mailof=` (`all` or a user id) for a user with `view_team_mail`; anything else, or no right, is your own mailbox. */
function mailOfParam(v: string | null, team: boolean): 'all' | number | undefined {
  if (!team || !v) return undefined;
  return v === 'all' ? 'all' : num(v);
}

/**
 * The list's filters from the address: the folder, Mail of, the search box and Filters panel (`s`, `from`, `to`,
 * `subject`, `leadq`, `owner`, `date`, `since`, `until`, `att`), the list's quick filter, conversation view and sort
 * (`chip`, `conv`, `sort`, `dir`), and `company` / `lead` / `project` from links such as the Projects list's Email
 * buttons. Values the API would refuse are left out.
 */
function filterFrom(params: URLSearchParams, mailOf: 'all' | number | undefined): MailFilter {
  const text = (k: string) => params.get(k)?.trim() || undefined;
  const owner = params.get('owner');
  const date = oneOf(DATES, params.get('date'));
  const day = (k: string) => (date === 'custom' && DAY.test(params.get(k) ?? '') ? params.get(k)! : undefined);
  const f: MailFilter = {
    view: oneOf(MAIL_VIEWS, params.get('folder')) ?? 'inbox',
    company: num(params.get('company')), lead: num(params.get('lead')), project: num(params.get('project')),
    s: text('s'), from: text('from'), to: text('to'), subject: text('subject'), leadQ: text('leadq'),
    owner: owner === 'me' ? 'me' : num(owner), date, since: day('since'), until: day('until'),
    attachments: params.get('att') === '1' || undefined,
    chip: oneOf<MailChip>(MAIL_CHIPS, params.get('chip')), conv: params.get('conv') === '0' ? false : undefined,
    sort: oneOf<ListSort>(MAIL_SORTS, params.get('sort')), dir: oneOf(['asc', 'desc'] as const, params.get('dir')),
    ...(mailOf !== undefined ? { mailOf } : {}),
  };
  // Only what is set, so the list's query key (and the request) stays the same for the same filters.
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as MailFilter;
}

/**
 * The Email screen (web-mail release 2, mockup 2026-11-26-outlook-mail): the top bar with the lead-mail search and its
 * Filters panel, the command bar, and the panes (folders, the message list, the reading pane, the lead panel). Your own mailbox, synced
 * every 5 minutes; Administrators and Managers pick "Mail of:" Me / Everyone / one user to read the team's lead mail,
 * view only (web-mail release 1). A link's `company`, `lead` or `project` narrows the list and shows as a removable chip.
 * `?compose=1` (with `company`, `lead`, `project`) opens Compose preset (the Projects list's Email buttons).
 * No page numbers (owner, 23 Nov 2026): the list loads the next 50 when scrolled near its foot.
 */
export function EmailPage() {
  const t = useT();
  const me = useCurrentUser();
  const navigate = useNavigate();
  const { id } = useParams();
  const [params] = useSearchParams();
  const teamRight = me.can('view_team_mail');
  const mailOf = mailOfParam(params.get('mailof'), teamRight);
  const filter = filterFrom(params, mailOf);
  const view = filter.view;
  const { data: meta } = useMailMeta(mailOf);
  const list = useMailList(filter);
  const { items } = list;
  const [compose, setCompose] = useState<ComposeStart | null>(null);
  /** The list's checked rows (MessageList resets them for another folder, filter or search). */
  const [checked, setChecked] = useState<Set<number>>(() => new Set());

  const selectedId = num(id ?? null) ?? items[0]?.id ?? null;
  // The message opened from a link (the reading pane's own query): a list answered before the open marked it read
  // still shows its row as read.
  const { data: opened } = useMailMessage(num(id ?? null) ?? null);
  // The reading pane's message (its own query, shared): the lead panel shows its lead.
  const peek = num(id ?? null) === undefined;
  const { data: shown } = useMailMessage(selectedId, peek);
  const mailbox = meta?.mailbox ?? null;
  const connected = mailbox?.status === 'connected';

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

  // The screen's commands (rows, menus, the bulk bar); a message moved or deleted while open leaves the reading pane.
  const commands = useMailCommands({
    connected,
    ownAddress: mailbox?.address ?? null,
    onCompose: setCompose,
    newStart: () => ({ companyId: filter.company, companyName, leadId: filter.lead, projectId: filter.project }),
    onGone: (ids) => {
      const open = num(id ?? null);
      if (open !== undefined && ids.includes(open)) navigate(href({}, false));
    },
  });

  /** The Filters panel's Search (and Clear filters): its fields and the search box go in the address. */
  const applySearch = (f: MailSearch) => {
    const custom = f.date === 'custom';
    setQuery({
      s: f.s || undefined, from: f.from.trim() || undefined, to: f.to.trim() || undefined, subject: f.subject.trim() || undefined,
      leadq: f.leadq.trim() || undefined, owner: f.owner || undefined, date: f.date || undefined,
      since: custom ? f.since || undefined : undefined, until: custom ? f.until || undefined : undefined, att: f.att ? '1' : undefined,
    });
  };

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

  // Owner addition (23 Nov 2026): the folder pane folds to a strip, remembered in this browser. The folder and filters
  // live in the address, so folding loses neither.
  const [foldersClosed, setFoldersClosed] = useStoredFlag('dait-mail-folders-collapsed');
  // The lead panel starts folded in a window narrower than 1400 px, and is toggled for this visit (View tab).
  const [leadPanelClosed, setLeadPanelClosed] = useState(() => window.innerWidth < 1400);

  // A link's client / lead / project (release 1's "Show mail for" left the screen): one removable chip naming them
  // ("Linked records" while the names load, or for a record the meta does not list).
  const metaCompany = meta?.companies.find((c) => c.id === filter.company);
  const companyName = metaCompany ? clientName(metaCompany) : undefined;
  const leadNumber = meta?.leads.find((l) => l.id === filter.lead)?.number;
  const metaProject = meta?.projects.find((p) => p.id === filter.project);
  const linked = filter.company || filter.lead || filter.project;
  const chipName = [companyName, leadNumber, metaProject ? `${metaProject.number} · ${metaProject.name}` : undefined].filter(Boolean).join(' · ');
  const teamView = mailOf !== undefined;

  // What the command bar and the shortcuts act on (Outlook): the checked rows while any are checked (rows that left the
  // list are no longer checked); else the open message (the fresher reading-pane copy when loaded), with its row's
  // conversation in the view (F24).
  const selected = items.filter((m) => checked.has(m.id));
  const row = items.find((m) => m.id === selectedId);
  const openItem = opened && opened.id === selectedId ? opened : row;
  const openTarget: MailTarget | null = openItem ? { ids: row ? rowTarget(row).ids : [openItem.id], item: openItem } : null;
  const target = selected.length ? selectionTarget(selected) : openTarget;

  return (
    <div className="wm">
      <MailTopBar meta={meta} mailOf={mailOf} filter={filter} onSearch={(s) => setQuery({ s: s || undefined })} onFilters={applySearch} />

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

      <CommandBar
        target={target}
        commands={commands}
        onCompose={setCompose}
        view={{
          conv: filter.conv !== false, sort: filter.sort ?? 'date', dir: filter.dir ?? 'desc', setQuery,
          foldersClosed, onToggleFolders: () => setFoldersClosed(!foldersClosed),
          leadPanelClosed, onToggleLeadPanel: () => setLeadPanelClosed(!leadPanelClosed),
        }}
      />

      <div className="wm-panes">
        <FolderPane
          view={view}
          meta={meta}
          mailOf={mailOf}
          team={teamRight}
          collapsed={foldersClosed}
          onToggle={() => setFoldersClosed(!foldersClosed)}
          href={(change) => href(change)}
        />

        <MessageList
          view={view}
          teamView={teamView}
          filter={filter}
          unread={meta?.counts.inbox}
          list={list}
          selectedId={selectedId}
          opened={opened}
          rowHref={(rowId) => `/email/${rowId}${params.toString() ? `?${params.toString()}` : ''}`}
          setQuery={setQuery}
          commands={commands}
          checked={checked}
          setChecked={setChecked}
          extra={linked ? (
            <div className="ml-row3">
              <Link className="chip wm-linkchip" to={href({ company: undefined, lead: undefined, project: undefined })} title={t('Clear')}>
                {chipName || t('Linked records')} ✕
              </Link>
            </div>
          ) : null}
        />

        {selectedId !== null ? (
          <>
            <ReadingPane key={selectedId} id={selectedId} peek={peek} teamView={teamView} commands={commands} />
            {shown && shown.id === selectedId ? (
              <LeadPanel m={shown} commands={commands} collapsed={leadPanelClosed} onToggle={() => setLeadPanelClosed(!leadPanelClosed)} />
            ) : null}
          </>
        ) : (
          <section className="rpane empty" aria-label={t('Reading pane')}>{t('Select a message.')}</section>
        )}
      </div>

      {commands.dialog}
      {compose ? <ComposeModal start={compose} connected={connected} from={mailbox?.address ?? null} onClose={() => setCompose(null)} /> : null}
    </div>
  );
}
