import { useMemo, useState, type ReactNode } from 'react';
import { safeUrl } from '@dait-crm/shared';
import { LEAD_ACTIVITY_PAGE_SIZE, useEarlierActivities, type ActivityRow, type LeadFull } from '../../api/leads';
import { Icons } from '../../components/Icons';
import { useFormatDate } from '../../hooks/useFormatDate';
import { leadStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

const ICON: Record<string, keyof typeof Icons> = {
  call: 'phone', email: 'mail', meeting: 'calendar', note: 'note', research: 'search', status: 'flag',
  assign: 'user', transfer: 'swap', ai: 'spark', created: 'star', quote: 'note',
};

/** One timeline row: icon by activity type, title, "from → to" for status changes, body, who and when. */
export function TimelineEntry({ activity: a, last, extra }: { activity: ActivityRow; last?: boolean; extra?: ReactNode }) {
  const t = useT();
  const { date } = useFormatDate();
  const link = safeUrl(a.url);
  return (
    <li className="tl">
      <div className="rail" aria-hidden="true">
        <div className="dot">{Icons[ICON[a.activityType] ?? 'note']}</div>
        {last ? null : <div className="line" />}
      </div>
      <div className="ev">
        <strong>{a.title}</strong>
        {a.activityType === 'status' && a.statusTo ? (
          <div className="b">
            {a.statusFrom ? `${leadStatusText(t, a.statusFrom)} → ` : null}
            {leadStatusText(t, a.statusTo)}
          </div>
        ) : null}
        {a.body ? <div className="b pre">{a.body}</div> : null}
        {link ? (
          <div className="b">
            <a href={link} target="_blank" rel="noopener noreferrer">
              {a.url}
            </a>
          </div>
        ) : null}
        <div className="m">
          {a.by ? a.by.name : t('System')} · {date(a.occurredAt)}
          {extra}
        </div>
      </div>
    </li>
  );
}

/** The lead's activities, newest first: page 1 comes with the lead, "Show earlier" adds 15 at a time. */
export function Timeline({ lead }: { lead: LeadFull }) {
  const t = useT();
  const [pages, setPages] = useState(1);
  const earlier = useEarlierActivities(lead.id, pages);
  const loading = earlier.some((q) => q.isFetching && !q.data);
  const rows = useMemo(() => {
    // A new activity shifts later pages by one: drop rows already shown.
    const seen = new Set<number>();
    const out: ActivityRow[] = [];
    for (const a of [...lead.activities, ...earlier.flatMap((q) => q.data ?? [])]) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
    return out;
  }, [lead.activities, earlier]);
  const more = pages * LEAD_ACTIVITY_PAGE_SIZE < lead.activityTotal;

  return (
    <section className="card" aria-labelledby="lead-tl-title">
      <h2 id="lead-tl-title" className="card-title">
        {t('Timeline')}
      </h2>
      {rows.length === 0 ? (
        <div className="empty">{t('No activity yet')}</div>
      ) : (
        <ol className="timeline" aria-label={t('Activity timeline')}>
          {rows.map((a, i) => (
            <TimelineEntry key={a.id} activity={a} last={i === rows.length - 1 && !more} />
          ))}
        </ol>
      )}
      {more ? (
        <div>
          <button type="button" className="btn sm" disabled={loading} onClick={() => setPages((p) => p + 1)}>
            {loading ? t('Loading…') : t('Show earlier')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
