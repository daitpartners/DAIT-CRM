import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  NOTIFICATION_PAGE_SIZE, useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications, type NotificationRow,
} from '../../api/notifications';
import { Pager } from '../../components/Pager';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

/** Only in-app paths are followed; anything else stays on this page. */
const inApp = (link: string | null): link is string => Boolean(link && link.startsWith('/') && !link.startsWith('//'));

/** The signed-in user's notifications: unread first, then newest first. Opening one marks it read. */
export function NotificationsList() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { date } = useFormatDate();
  const [page, setPage] = useState(1);
  const { data, isPending, error } = useNotifications(page);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  // The API lists newest first; unread ones go to the top of the page.
  const rows = [...(data?.items ?? [])].sort((a, b) => Number(a.isRead) - Number(b.isRead));
  const unread = data?.unread ?? 0;

  function open(n: NotificationRow) {
    if (!n.isRead) markRead.mutate(n.id);
    if (inApp(n.link)) navigate(n.link);
  }

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
          {t('Mark all read')}
        </button>
      </Topbar>
      <div className="page">
        <section className="card flush" aria-label={t('Notifications')}>
          {error ? (
            <div className="empty" role="alert">
              {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
            </div>
          ) : isPending ? (
            <div className="empty">{t('Loading…')}</div>
          ) : rows.length === 0 ? (
            <div className="empty">{t('No notifications yet.')}</div>
          ) : (
            <ul className="nlist">
              {rows.map((n) => (
                <li key={n.id}>
                  <button type="button" className={n.isRead ? 'nrow' : 'nrow unread'} onClick={() => open(n)}>
                    <span className="nb">
                      <strong>{n.text}</strong>
                      {n.detail ? <span className="nd">{n.detail}</span> : null}
                      <span className="nm">{date(n.createdAt)}</span>
                    </span>
                    {n.isRead ? null : (
                      <span className="ndot">
                        <span className="sr">{t('Unread')}</span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data && data.total > 0 ? (
            <div className="foot">
              <Pager page={page} pageSize={NOTIFICATION_PAGE_SIZE} total={data.total} onPage={setPage} />
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}
