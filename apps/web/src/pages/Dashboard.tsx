import { Link, useNavigate } from 'react-router-dom';
import { formatMoney } from '@dait-crm/shared';
import { ApiError } from '../api/client';
import { useDashboard } from '../api/dashboard';
import { useRefreshWhenOutOfDate } from '../api/leads';
import { useMarkNotificationRead, type NotificationRow } from '../api/notifications';
import { useSaveTask, type TaskRow } from '../api/tasks';
import { useCurrentUser } from '../api/useCurrentUser';
import { Icons } from '../components/Icons';
import { Tile } from '../components/Tile';
import { Topbar } from '../components/Topbar';
import { useToast } from '../components/Toast';
import { useFormatDate } from '../hooks/useFormatDate';
import { errorText, leadStatusText } from '../i18n/labels';
import { useT, type TFn } from '../i18n/useT';
import { TaskItem } from './tasks/TasksList';

/** Only in-app paths are followed from a notification. */
const inApp = (link: string | null): link is string => Boolean(link && link.startsWith('/') && !link.startsWith('//'));

/** The time now (HH:MM, 24-hour) in a time zone; the browser's own time for an unknown zone. */
function timeIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  } catch {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

/** The hour (0–23) now in a time zone. */
const hourIn = (timeZone: string): number => Number(timeIn(timeZone).slice(0, 2));

/** Agenda colours as the prototype: calls in rust, meetings and follow-ups in purple. */
const agendaColour = (task: TaskRow) => (task.kind === 'call' ? '#BA5326' : '#822CDB');

function greeting(t: TFn, hour: number, name: string): string {
  if (hour < 12) return t('Good morning, {name}', { name });
  if (hour < 18) return t('Good afternoon, {name}', { name });
  return t('Good evening, {name}', { name });
}

/**
 * Dashboard (prototype V.dashboard): greeting and date, tiles (my open leads, follow-ups due today, meetings today
 * and quotes awaiting response), then Tasks & follow-ups, Today's agenda with Notifications, and My pipeline by
 * status. Everything is the signed-in user's own, whatever their role. Meetings today and Today's agenda are the
 * user's own timed tasks for today (calls, meetings, timed follow-ups); Outlook events are never shown here.
 */
export function Dashboard() {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const navigate = useNavigate();
  const { date } = useFormatDate();
  const { data, error, isPending } = useDashboard();
  const save = useSaveTask();
  const markRead = useMarkNotificationRead();
  const refreshIfOutOfDate = useRefreshWhenOutOfDate();

  const fail = (err: unknown) => {
    refreshIfOutOfDate(err);
    toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn');
  };
  const busy = save.isPending;

  const firstName = (data?.greeting.name ?? me.name).split(' ')[0] ?? '';
  const today = data?.greeting.date;
  const longDate = today
    ? new Intl.DateTimeFormat(me.language === 'en' ? 'en-GB' : me.language, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
        new Date(`${today}T00:00:00Z`),
      )
    : '';
  const sub = t('{date} · everything assigned to you across leads, email, calendar and quotations', { date: longDate });
  const tiles = data?.tiles;
  const unread = tiles?.unreadNotifications ?? 0;

  function openNote(n: NotificationRow) {
    if (!n.isRead) markRead.mutate(n.id);
    if (inApp(n.link)) navigate(n.link);
  }

  const max = Math.max(1, ...(data?.pipeline.map((p) => p.count) ?? []));
  // The prototype's meta: each of the user's Sent / Negotiating quotations' totals, joined " · ".
  const awaiting = data?.awaitingQuotes;
  const agenda = data?.agenda;
  const now = timeIn(me.timezone);
  const next = agenda?.find((a) => !a.isDone && (a.dueTime ?? '') > now);

  return (
    <>
      <Topbar title={greeting(t, hourIn(me.timezone), firstName)} sub={today ? sub : undefined}>
        <button
          type="button"
          className="btn bell-btn"
          aria-label={unread ? t('Notifications ({n} unread)', { n: unread }) : t('Notifications')}
          onClick={() => navigate('/notifications')}
        >
          {Icons.bell}
          {unread ? <span className="badge b-warn bell-count">{unread}</span> : null}
        </button>
        {me.can('manage_leads') ? (
          <button type="button" className="btn primary" onClick={() => navigate('/leads/new')}>
            {Icons.plus}
            {t('New lead')}
          </button>
        ) : null}
      </Topbar>
      <div className="page">
        <div className="tiles">
          <Tile
            label={t('My open leads')}
            value={tiles?.myOpenLeads ?? '—'}
            meta={tiles ? t('{n} new since yesterday', { n: tiles.newSinceYesterday }) : undefined}
            to="/leads?tab=mine"
          />
          <Tile
            label={t('Follow-ups due today')}
            value={tiles?.tasksDueToday ?? '—'}
            meta={tiles ? t('{n} overdue', { n: tiles.overdue }) : undefined}
            metaClass="bad"
            to="/tasks"
          />
          <Tile
            label={t('Meetings today')}
            value={agenda?.length ?? '—'}
            meta={agenda ? (next ? t('next at {time} · {title}', { time: next.dueTime ?? '', title: next.title }) : '—') : undefined}
            to="/calendar"
          />
          <Tile
            label={t('Quotes awaiting response')}
            value={awaiting?.length ?? '—'}
            meta={awaiting ? awaiting.map((q) => formatMoney(q.total, q.currency)).join(' · ') || '—' : undefined}
            to="/quotations"
          />
        </div>

        {error ? (
          <div className="card empty" role="alert">
            {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
          </div>
        ) : (
          <div className="cols dash-cols">
            <section className="card dash-tasks" aria-labelledby="dash-tasks">
              <div className="card-head">
                <h2 id="dash-tasks">{t('Tasks & follow-ups')}</h2>
                {tiles ? (
                  <div className="dash-badges">
                    <span className="badge b-bad">{t('{n} overdue', { n: tiles.overdue })}</span>
                    <span className="badge b-purple">{t('{n} today', { n: tiles.tasksDueToday })}</span>
                    <span className="badge b-grey">{t('{n} upcoming', { n: tiles.upcoming })}</span>
                  </div>
                ) : null}
              </div>
              {isPending ? (
                <p className="muted none">{t('Loading…')}</p>
              ) : data.tasks.length ? (
                <ul className="task-list flat">
                  {data.tasks.map((task) => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      busy={busy}
                      onTick={() =>
                        save.mutate(
                          { id: task.id, body: { isDone: !task.isDone, updatedAt: task.updatedAt } },
                          { onSuccess: () => toast(t('Task done')), onError: fail },
                        )
                      }
                    />
                  ))}
                </ul>
              ) : (
                <div className="empty">{t('Nothing due. Nice.')}</div>
              )}
              <Link to="/tasks" className="dash-more">
                {tiles?.openTasks === 1 ? t('View all 1 task') : t('View all {n} tasks', { n: tiles?.openTasks ?? 0 })}
              </Link>
            </section>

            <div className="dash-mid">
              <section className="card" aria-labelledby="dash-agenda">
                <div className="card-head">
                  <h2 id="dash-agenda">{t("Today's agenda")}</h2>
                  <Link to="/calendar" className="dash-cal">
                    {t('Open calendar')}
                  </Link>
                </div>
                {isPending ? (
                  <p className="muted none">{t('Loading…')}</p>
                ) : data.agenda.length ? (
                  <ul className="agenda">
                    {data.agenda.map((a) => (
                      <li key={a.id}>
                        <span className="ag-time">{a.dueTime}</span>
                        <span className="ag-body" style={{ borderLeftColor: agendaColour(a) }}>
                          <strong>{a.title}</strong>
                          <span className="m">
                            {a.lead?.companyName ?? a.assignedTo.name}
                            {a.kind === 'call' ? ` · ${t('Phone')}` : a.kind === 'meeting' ? ' · Microsoft Teams' : null}
                            {a.lead ? (
                              <>
                                {' · '}
                                <Link to={`/leads/${a.lead.id}`}>{a.lead.number}</Link>
                              </>
                            ) : null}
                            {a.isDone ? ` · ${t('done')}` : null}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted none">{t('No events today.')}</p>
                )}
              </section>
              <section className="card" aria-labelledby="dash-notes">
                <h2 id="dash-notes">{t('Notifications')}</h2>
                {isPending ? (
                  <p className="muted none">{t('Loading…')}</p>
                ) : data.notifications.length ? (
                  <ul className="dnotes">
                    {data.notifications.map((n) => (
                      <li key={n.id}>
                        <button type="button" className={n.isRead ? 'dnote' : 'dnote unread'} onClick={() => openNote(n)}>
                          <span className="dot" aria-hidden="true" />
                          <span>
                            <strong>{n.text}</strong>
                            <span className="m">
                              {date(n.createdAt)}
                              {n.detail ? ` · ${n.detail}` : null}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted none">{t('No notifications.')}</p>
                )}
              </section>
            </div>

            <section className="card dash-pipe" aria-labelledby="dash-pipe">
              <h2 id="dash-pipe">{t('My pipeline by status')}</h2>
              {isPending ? (
                <p className="muted none">{t('Loading…')}</p>
              ) : (
                <>
                  <ul className="pipe-bars">
                    {data.pipeline.map((p, i) => (
                      <li key={p.status}>
                        <div className="pipe-row">
                          <span>{leadStatusText(t, p.status)}</span>
                          <strong>{p.count}</strong>
                        </div>
                        <div className="bar" aria-hidden="true">
                          <div style={{ width: `${Math.round((p.count / max) * 100)}%`, background: i > 3 ? '#BA5326' : '#822CDB' }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="muted pipe-foot">{t('Won: {won} · Lost: {lost}', { won: data.closed.won, lost: data.closed.lost })}</div>
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
