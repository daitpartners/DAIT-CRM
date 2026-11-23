import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CalendarItem } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useCalendar } from '../../api/calendar';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Topbar } from '../../components/Topbar';
import { errorText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import {
  addDays, addMonths, calendarNames, calendarTitle, dayNum, dow, isDate, monthGrid, monthIndex, monthStart, monthWeeks, shortDay,
  todayIn, weekDays, type CalendarView,
} from './dates';
import { EventInfoModal } from './EventInfoModal';
import { NewFollowUpModal } from './NewFollowUpModal';
import { taskTitle } from '../../i18n/systemText';

const VIEWS: CalendarView[] = ['day', 'week', 'month'];

const CHEV_L = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
const CHEV_R = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/**
 * Calendar (prototype V.calendar): mini month and Overdue on the left; Day / Week / Month on the right, with the
 * viewer's follow-ups, calls and meetings and their own Outlook events. URL `?view=&d=&who=all`; Everyone is for
 * administrators only. Click an empty day to plan a follow-up; click an item to open its lead (an event without a
 * lead shows its details).
 */
export function CalendarPage() {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const [searchParams] = useSearchParams();
  const names = useMemo(() => calendarNames(lang), [lang]);
  const today = todayIn(me.timezone);
  const isAdmin = me.role === 'Administrator';

  const qv = searchParams.get('view') as CalendarView | null;
  const view: CalendarView = qv && VIEWS.includes(qv) ? qv : 'month';
  const qd = searchParams.get('d');
  const d = isDate(qd) ? qd : today;
  const who = isAdmin && searchParams.get('who') === 'all' ? 'all' : 'mine';

  // One request covers the month grid of `d`: the month view, the week and day of `d`, and the mini month's dots.
  const grid = monthGrid(d);
  const cal = useCalendar(grid[0]!, grid[41]!, who);
  const all = cal.data?.items ?? [];
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const x of cal.data?.items ?? []) m.set(x.date, [...(m.get(x.date) ?? []), x]);
    return m;
  }, [cal.data]);
  const overdue = cal.data?.overdue ?? [];
  // Until the first answer arrives the counts are unknown: say nothing rather than "0 open items" / "Nothing overdue.".
  const loading = !cal.data && !cal.error;

  // `?new=1&lead=<id>` (the Email reader's Create meeting, prototype) opens New follow-up for that lead on `d`.
  const newLead = searchParams.get('new') === '1' ? Number(searchParams.get('lead')) || undefined : undefined;
  const [adding, setAdding] = useState<string | null>(searchParams.get('new') === '1' ? d : null);
  const [info, setInfo] = useState<CalendarItem | null>(null);

  const link = (patch: Record<string, string>) => {
    const o: Record<string, string> = { view, d, who: who === 'all' ? 'all' : '', ...patch };
    const qs = Object.keys(o)
      .filter((k) => o[k])
      .map((k) => `${k}=${encodeURIComponent(o[k]!)}`)
      .join('&');
    return `/calendar?${qs}`;
  };

  const month = d.slice(0, 7);
  const inMonth = (x: string) => x.slice(0, 7) === month;
  const range = view === 'month' ? grid : view === 'week' ? weekDays(d) : [d];
  const title = calendarTitle(view, d, names);
  const prev = view === 'month' ? addMonths(d, -1) : addDays(d, view === 'week' ? -7 : -1);
  const next = view === 'month' ? addMonths(d, 1) : addDays(d, view === 'week' ? 7 : 1);
  const scope = view === 'month' ? all.filter((x) => inMonth(x.date)) : all.filter((x) => range.includes(x.date));
  const openN = scope.filter((x) => !x.done).length;

  const chip = (x: CalendarItem, full = false) => <Chip key={`${x.kind}-${x.id}`} item={x} full={full} onInfo={setInfo} />;
  const onCell = (day: string) => (e: MouseEvent) => {
    if ((e.target as Element).closest('a,button')) return;
    setAdding(day);
  };

  const mini = (
    <section className="card cmini">
      <div className="cmh">
        <strong>{`${names.months[monthIndex(d)]} ${d.slice(0, 4)}`}</strong>
        <span className="grow" />
        <Link className="cnav" to={link({ d: addMonths(d, -1) })} aria-label={t('Previous month')}>
          {CHEV_L}
        </Link>
        <Link className="cnav" to={link({ d: addMonths(d, 1) })} aria-label={t('Next month')}>
          {CHEV_R}
        </Link>
      </div>
      <div className="cmg">
        {names.narrow.map((x, i) => (
          <span key={`wd-${i}`} className="wd">
            {x}
          </span>
        ))}
        {grid.map((x) => (
          <Link
            key={x}
            to={link({ d: x })}
            className={[
              inMonth(x) ? 'in' : 'out',
              x === today ? 'today' : '',
              x === d && view !== 'month' ? 'sel' : '',
              (byDay.get(x) ?? []).some((i) => !i.done) ? 'has' : '',
            ].filter(Boolean).join(' ')}
            aria-label={shortDay(x, names)}
          >
            {dayNum(x)}
          </Link>
        ))}
      </div>
    </section>
  );

  const overdueBox = (
    <div className="cover">
      <div className="coh">
        {t('Overdue|calendar')} {overdue.length ? <span>{overdue.length}</span> : null}
      </div>
      {overdue.length ? (
        overdue.map((x) => (
          <Link key={`${x.kind}-${x.id}`} className="coi" to={x.leadId ? `/leads/${x.leadId}` : link({ view: 'day', d: x.date })}>
            <strong>{taskTitle(t, x.title)}</strong>
            <span>{[x.company, shortDay(x.date, names) + (x.time ? `, ${x.time}` : '')].filter(Boolean).join(', ')}</span>
          </Link>
        ))
      ) : loading ? null : (
        <div className="con">{t('Nothing overdue.')}</div>
      )}
    </div>
  );

  let body: ReactNode;
  if (view === 'month') {
    const cells = grid.slice(0, monthWeeks(d) * 7);
    body = (
      <div className="cgrid month">
        <div className="cgh">
          {names.days.map((x) => (
            <div key={x}>{x}</div>
          ))}
        </div>
        <div className="cgb">
          {cells.map((x) => {
            const its = byDay.get(x) ?? [];
            return (
              <div key={x} className={['cc', inMonth(x) ? '' : 'out', x === today ? 'today' : ''].filter(Boolean).join(' ')} data-day={x} onClick={onCell(x)}>
                <div className="cn">
                  <span>{(dayNum(x) === 1 ? `${names.monthsShort[monthIndex(x)]} ` : '') + dayNum(x)}</span>
                </div>
                {its.slice(0, 3).map((i) => chip(i))}
                {its.length > 3 ? (
                  <Link className="cmore" to={link({ view: 'day', d: x })}>
                    {t('+{n} more', { n: its.length - 3 })}
                  </Link>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  } else if (view === 'week') {
    body = (
      <div className="cgrid week">
        <div className="cgh">
          {range.map((x) => (
            <div key={x} className={x === today ? 'today' : ''}>
              {names.daysShort[dow(x)]} <b>{dayNum(x)}</b>
            </div>
          ))}
        </div>
        <div className="cgb">
          {range.map((x) => {
            const its = byDay.get(x) ?? [];
            return (
              <div key={x} className={x === today ? 'cc tall today' : 'cc tall'} data-day={x} onClick={onCell(x)}>
                {its.length ? its.map((i) => chip(i)) : <span className="cnone">—</span>}
              </div>
            );
          })}
        </div>
      </div>
    );
  } else {
    const its = byDay.get(d) ?? [];
    body = (
      <div className="cgrid day">
        <div className={d === today ? 'cc tall today' : 'cc tall'} data-day={d} onClick={onCell(d)}>
          {its.length ? its.map((i) => chip(i, true)) : <div className="empty" style={{ padding: '40px 0' }}>{t('Nothing on this day. Click here to add a follow-up.')}</div>}
        </div>
      </div>
    );
  }

  const summary = () => {
    const tail = t('Click an empty slot to add a follow-up; click an item to open its lead.');
    const one = openN === 1;
    const head =
      view === 'month'
        ? one ? t('{n} open item in this month.', { n: openN }) : t('{n} open items in this month.', { n: openN })
        : view === 'week'
          ? one ? t('{n} open item in this week.', { n: openN }) : t('{n} open items in this week.', { n: openN })
          : one ? t('{n} open item in this day.', { n: openN }) : t('{n} open items in this day.', { n: openN });
    return `${head} ${tail}`;
  };

  const viewText = (v: CalendarView) => (v === 'day' ? t('Day') : v === 'week' ? t('Week') : t('Month'));
  const sub = cal.data?.outlook.syncOn ? (
    <>
      {t('Follow-ups, calls and meetings for your leads')} · <span className="badge b-ok">{t('Outlook sync on')}</span>
    </>
  ) : (
    t('Follow-ups, calls and meetings for your leads')
  );

  return (
    <>
      <Topbar title={t('Calendar')} sub={sub}>
        {isAdmin ? (
          <div className="seg link-seg" role="group" aria-label={t('Whose items')}>
            <Link className={who === 'mine' ? 'on' : ''} to={link({ who: '' })}>
              {t('Mine')}
            </Link>
            <Link className={who === 'all' ? 'on' : ''} to={link({ who: 'all' })}>
              {t('Everyone')}
            </Link>
          </div>
        ) : null}
      </Topbar>
      <div className="page ccal">
        <aside className="cside">
          {mini}
          {overdueBox}
        </aside>
        <div className="cmain">
          <div className="cbar">
            <button type="button" className="btn primary" onClick={() => setAdding(view === 'month' ? (inMonth(today) ? today : monthStart(d)) : d)}>
              {Icons.plus}
              {t('New follow-up')}
            </button>
            <Link className="btn" to={link({ d: today })}>
              {t('Today')}
            </Link>
            <Link className="cnav lg" to={link({ d: prev })} aria-label={t('Previous')}>
              {CHEV_L}
            </Link>
            <Link className="cnav lg" to={link({ d: next })} aria-label={t('Next')}>
              {CHEV_R}
            </Link>
            <h2 className="ctitle">{title}</h2>
            <span className="grow" />
            <div className="seg link-seg" role="group" aria-label={t('View')}>
              {VIEWS.map((v) => (
                <Link key={v} className={v === view ? 'on' : ''} to={link({ view: v })}>
                  {viewText(v)}
                </Link>
              ))}
            </div>
          </div>
          {cal.error ? (
            <div className="csum" role="alert">
              {errorText(t, cal.error instanceof ApiError ? cal.error.code : 'unknown')}
            </div>
          ) : (
            <div className="csum">{loading ? '\u00a0' : summary()}</div>
          )}
          {body}
          <div className="cleg">
            <span className="k t-followup" />
            {t('Follow-up')}
            <span className="k t-call" />
            {t('Call')}
            <span className="k t-meeting" />
            {t('Meeting')}
            <span className="k t-internal" />
            {t('Internal')}
            <span className="k over" />
            {t('Overdue|calendar')}
            <span className="k done" />
            {t('Done|calendar')}
          </div>
        </div>
      </div>
      {adding ? <NewFollowUpModal date={adding} leadId={newLead} names={names} onClose={() => setAdding(null)} /> : null}
      {info ? <EventInfoModal item={info} names={names} onClose={() => setInfo(null)} /> : null}
    </>
  );
}

/** A calendar entry: a link to its lead, or (no lead) a button that shows its details. `full` adds "company · lead number". */
function Chip({ item: x, full, onInfo }: { item: CalendarItem; full: boolean; onInfo: (x: CalendarItem) => void }) {
  const t = useT();
  const cls = ['cit', `t-${x.type}`, x.done ? 'done' : '', x.overdue ? 'over' : ''].filter(Boolean).join(' ');
  const tip = taskTitle(t, x.title) + (x.company ? ` · ${x.company}` : '') + (x.done ? ` ${t('(done)')}` : x.overdue ? ` ${t('(overdue)')}` : '');
  const inner = (
    <>
      {x.time ? <span className="tm">{x.time}</span> : null}
      <span className="tt">{taskTitle(t, x.title)}</span>
      {full && x.company ? <span className="co">{x.company + (x.leadNumber ? ` · ${x.leadNumber}` : '')}</span> : null}
    </>
  );
  return x.leadId ? (
    <Link className={cls} to={`/leads/${x.leadId}`} title={tip}>
      {inner}
    </Link>
  ) : (
    <button type="button" className={cls} title={tip} onClick={() => onInfo(x)}>
      {inner}
    </button>
  );
}

