import { Fragment, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  NOTIFICATION_PAGE_SIZE, useMarkAllNotificationsRead, useMarkNotificationRead, useNavCounts, useNotifications, type NotificationRow,
} from '../../api/notifications';
import { useTasks } from '../../api/tasks';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Pager } from '../../components/Pager';
import { Tabs } from '../../components/Tabs';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { systemDetail, systemText } from '../../i18n/systemText';

/** Only in-app paths are followed; anything else stays on this page. */
const inApp = (link: string | null): link is string => Boolean(link && link.startsWith('/') && !link.startsWith('//'));

type Kind = 'leads' | 'tasks' | 'email' | 'mailer' | 'quotes' | 'ai' | 'calendar' | 'projects' | 'mailbox' | 'other';
/**
 * The kind shown on a row (prototype KIND, review #28), read from where the notification points: the link does not
 * depend on the language the text was stored in.
 */
const kindOf = (n: NotificationRow): Kind => {
  const l = n.link ?? '';
  if (l.startsWith('/leads/')) return 'leads';
  if (l === '/tasks' || l.startsWith('/tasks?')) return 'tasks';
  if (l.startsWith('/quotations')) return 'quotes';
  if (/^\/companies\/\d+#(ai|sources)$/.test(l)) return 'ai';
  if (l.startsWith('/mailer')) return 'mailer';
  if (l.startsWith('/projects')) return 'projects';
  if (l.startsWith('/email')) return 'email';
  if (l.startsWith('/calendar')) return 'calendar';
  if (l.startsWith('/settings/connections')) return 'mailbox';
  return 'other';
};
/** Icon and colour per kind (prototype KIND: person, mailS, quoteS, spark, calS, swap; clock for Other). */
const KIND_STYLE: Record<Kind, { icon: ReactNode; bg: string }> = {
  leads: { icon: Icons.user, bg: '#EFE6FD' },
  tasks: { icon: Icons.tasks, bg: '#FFF8EC' },
  email: { icon: Icons.mail, bg: '#E4D5FB' },
  mailer: { icon: Icons.send, bg: '#FFF1E0' },
  quotes: { icon: Icons.quote, bg: '#FFF1E0' },
  ai: { icon: Icons.spark, bg: '#FFF8EC' },
  calendar: { icon: Icons.calendar, bg: '#EFE6FD' },
  projects: { icon: Icons.swap, bg: '#EFE6FD' },
  mailbox: { icon: Icons.mail, bg: '#E6F6EC' },
  other: { icon: Icons.bell, bg: '#EDE9F4' },
};

/** YYYY-MM-DD of an instant in a time zone. */
const ymdIn = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/**
 * The signed-in user's notifications (prototype V.notifications): attention links for overdue and
 * due-today tasks, All / Unread tabs, newest first under Today / Yesterday / Earlier. Opening one marks it read.
 */
export function NotificationsList() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const me = useCurrentUser();
  const { date } = useFormatDate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'unread' ? 'unread' : 'all';
  const pageNum = Number(searchParams.get('page'));
  const page = Number.isInteger(pageNum) && pageNum > 0 ? pageNum : 1;
  const allQ = useNotifications(tab === 'all' ? page : 1);
  const unreadQ = useNotifications(tab === 'unread' ? page : 1, true);
  const { data, isPending, error } = tab === 'unread' ? unreadQ : allQ;
  // The attention strip: the signed-in user's own open tasks (every origin), overdue and due today.
  const tasks = useTasks({ tab: 'today', pageSize: 1 });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const unread = data?.unread ?? 0;
  const allTotal = allQ.data?.total;
  const rows = data?.items ?? [];

  const go = (patch: Record<string, string | undefined>) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!('page' in patch)) next.delete('page');
      return next;
    });

  function open(n: NotificationRow) {
    if (!n.isRead) markRead.mutate(n.id);
    if (inApp(n.link)) navigate(n.link);
  }

  const today = ymdIn(new Date(), me.timezone);
  const yesterday = ymdIn(new Date(Date.now() - 86_400_000), me.timezone);
  const group = (n: NotificationRow) => {
    const d = ymdIn(new Date(n.createdAt), me.timezone);
    return d === today ? t('Today') : d === yesterday ? t('Yesterday') : t('Earlier');
  };
  // 24-hour, as the rest of the CRM (review #28).
  const time = (iso: string) => new Intl.DateTimeFormat(me.language, { timeZone: me.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const kindText: Record<Kind, string> = {
    leads: t('Leads'), tasks: t('Tasks'), email: t('Email'), mailer: t('Mailer'), quotes: t('Quotations'), ai: t('AI research'),
    calendar: t('Calendar'), projects: t('Projects'), mailbox: t('Mailbox'), other: t('Other|notification'),
  };

  // Prototype attention strip: also unread email and running mailer runs (your own mailbox only).
  const counts = useNavCounts().data;
  const mail = me.rights.includes('use_email');
  const unreadMail = mail ? (counts?.mailUnread ?? 0) : 0;
  const runs = mail ? (counts?.mailerLive ?? 0) : 0;
  const overdue = tasks.data?.counts.overdue ?? 0;
  const dueToday = tasks.data?.counts.today ?? 0;
  const attention = [
    overdue ? { cls: 'bad', text: overdue === 1 ? t('1 overdue open task') : t('{n} overdue open tasks', { n: overdue }) } : null,
    dueToday ? { cls: 'warn', text: dueToday === 1 ? t('1 open task due today') : t('{n} open tasks due today', { n: dueToday }) } : null,
    unreadMail ? { cls: '', to: '/email', text: unreadMail === 1 ? t('1 unread email') : t('{n} unread emails', { n: unreadMail }) } : null,
    runs ? { cls: '', to: '/mailer', text: runs === 1 ? t('1 mailer run in progress') : t('{n} mailer runs in progress', { n: runs }) } : null,
  ].filter((x): x is { cls: string; text: string; to?: string } => x !== null);

  let last: string | null = null;
  return (
    <>
      <Topbar title={t('Notifications')} sub={t('What has happened on your leads, newest first')}>
        <button
          type="button"
          className="btn"
          disabled={unread === 0 || markAll.isPending}
          onClick={() =>
            markAll.mutate(undefined, {
              onSuccess: () => toast(t('All notifications marked as read')),
              onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
            })
          }
        >
          {t('Mark all as read')}
        </button>
      </Topbar>
      <div className="page">
        {attention.length ? (
          <div className="natt">
            {attention.map((a) => (
              <Link key={a.to ?? a.cls} className={a.cls || undefined} to={a.to ?? '/tasks'}>
                {a.text} →
              </Link>
            ))}
          </div>
        ) : null}
        <section className="card flush" aria-label={t('Notifications')}>
          <Tabs
            tabs={[
              { id: 'all', label: t('All|notifications'), count: allTotal },
              { id: 'unread', label: t('Unread'), count: data ? unread : undefined, countClass: unread ? 'bad' : undefined },
            ]}
            active={tab}
            onChange={(id) => go({ tab: id === 'unread' ? 'unread' : undefined })}
            label={t('Notification views')}
          >
            <div className="filters">
              <div className="grow" />
              {data && allTotal !== undefined ? (
                <span className="muted filters-count">{t('Showing {n} of {total}', { n: data.total, total: allTotal })}</span>
              ) : null}
            </div>
            {error ? (
              <div className="empty" role="alert">
                {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
              </div>
            ) : isPending ? (
              <div className="empty">{t('Loading…')}</div>
            ) : rows.length === 0 ? (
              <div className="empty">{tab === 'unread' ? t('You are all caught up.') : t('No notifications yet.')}</div>
            ) : (
              <ul className="nlist">
                {rows.map((n) => {
                  const g = group(n);
                  const head = g !== last ? <li className="ngh">{g}</li> : null;
                  last = g;
                  const kind = kindOf(n);
                  return (
                    <Fragment key={n.id}>
                      {head}
                      <li>
                        <button type="button" className={n.isRead ? 'nrow' : 'nrow unread'} onClick={() => open(n)}>
                          <span className="ni" style={{ background: KIND_STYLE[kind].bg }} aria-hidden="true">
                            {KIND_STYLE[kind].icon}
                          </span>
                          <span className="nb">
                            <strong>{systemText(t, n.text)}</strong>
                            {n.detail ? <span className="nd">{systemDetail(t, n.detail)}</span> : null}
                            <span className="nm">
                              {kindText[kind]} · {g === t('Earlier') ? date(n.createdAt) : `${g}, ${time(n.createdAt)}`}
                            </span>
                          </span>
                          {n.isRead ? null : (
                            <span className="ndot">
                              <span className="sr">{t('Unread')}</span>
                            </span>
                          )}
                        </button>
                      </li>
                    </Fragment>
                  );
                })}
              </ul>
            )}
            {data && data.total > NOTIFICATION_PAGE_SIZE ? (
              <div className="foot">
                <Pager page={page} pageSize={NOTIFICATION_PAGE_SIZE} total={data.total} onPage={(p) => go({ page: p > 1 ? String(p) : undefined })} />
              </div>
            ) : null}
          </Tabs>
        </section>
      </div>
    </>
  );
}
