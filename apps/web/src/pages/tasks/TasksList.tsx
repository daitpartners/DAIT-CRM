import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useRefreshWhenOutOfDate } from '../../api/leads';
import { useOpenTasks, useSaveTask, useSnoozeTask, useTasks, type TaskRow } from '../../api/tasks';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Pager } from '../../components/Pager';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText, taskOriginText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { TaskModal } from './TaskModal';

/** Completed tasks per page in the side card. */
const DONE_PAGE_SIZE = 10;

/**
 * Tasks (prototype V.tasks): one card with Overdue / Due today / Upcoming sections of open tasks,
 * and a side column with Completed and "How tasks get here". Mine, or (view_all_leads) the team's.
 */
export function TasksList() {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const team = me.can('view_all_leads') && searchParams.get('scope') === 'team';
  const doneNum = Number(searchParams.get('donePage'));
  const donePage = Number.isInteger(doneNum) && doneNum > 0 ? doneNum : 1;
  const open = useOpenTasks(team ? 'all' : undefined);
  const done = useTasks({ tab: 'done', page: donePage, pageSize: DONE_PAGE_SIZE, ...(team ? { assignedTo: 'all' as const } : {}) });
  const save = useSaveTask();
  const snooze = useSnoozeTask();
  const [editing, setEditing] = useState<TaskRow | 'new' | null>(null);

  const go = (patch: Record<string, string | undefined>) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!('donePage' in patch)) next.delete('donePage');
      return next;
    });

  const refreshIfOutOfDate = useRefreshWhenOutOfDate();
  const fail = (err: unknown) => {
    refreshIfOutOfDate(err);
    toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn');
  };
  const busy = save.isPending || snooze.isPending;

  const row = (task: TaskRow) => (
    <TaskItem
      key={task.id}
      task={task}
      busy={busy}
      onTick={() =>
        save.mutate(
          { id: task.id, body: { isDone: !task.isDone, updatedAt: task.updatedAt } },
          { onSuccess: () => toast(task.isDone ? t('Task reopened') : t('Task done')), onError: fail },
        )
      }
      onEdit={() => setEditing(task)}
      onSnooze={() => snooze.mutate(task, { onSuccess: () => toast(t('Moved to tomorrow')), onError: fail })}
    />
  );

  const counts = open.data?.counts;
  const section = (id: 'overdue' | 'today' | 'upcoming', title: string, badge: ReactNode) => {
    const rows = open.data?.sections[id] ?? [];
    const total = counts?.[id] ?? 0;
    return (
      <section className="task-sec" aria-labelledby={`tasks-${id}`}>
        <h2 id={`tasks-${id}`}>
          {title}
          {badge}
        </h2>
        {rows.length ? <ul className="task-list flat">{rows.map(row)}</ul> : <p className="muted none">{t('None.|tasks')}</p>}
        {total > rows.length ? <p className="muted none">{t('Showing the first {n} of {total}.', { n: rows.length, total })}</p> : null}
      </section>
    );
  };
  const error = open.error ?? done.error;

  return (
    <>
      <Topbar title={t('Tasks')} sub={t('Pending and overdue follow-ups, new assignments and transferred leads')}>
        {me.can('view_all_leads') ? (
          <div className="seg" role="group" aria-label={t('Whose tasks')}>
            <button type="button" className={team ? 'btn' : 'btn primary'} aria-pressed={!team} onClick={() => go({ scope: undefined })}>
              {t('My tasks')}
            </button>
            <button type="button" className={team ? 'btn primary' : 'btn'} aria-pressed={team} onClick={() => go({ scope: 'team' })}>
              {t('Team')}
            </button>
          </div>
        ) : null}
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>
          {Icons.plus}
          {t('New task')}
        </button>
      </Topbar>
      <div className="page cols">
        <div className="card col-main tasks-main">
          {error ? (
            <div className="empty" role="alert">
              {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
            </div>
          ) : open.isPending ? (
            <div className="empty">{t('Loading…')}</div>
          ) : (
            <>
              {section('overdue', t('Overdue|tasks'), <> <span className="badge b-bad">{counts?.overdue ?? 0}</span></>)}
              {section('today', t('Due today'), <> <span className="badge b-purple">{counts?.today ?? 0}</span></>)}
              {section('upcoming', t('Upcoming'), null)}
            </>
          )}
        </div>
        <aside className="col-side">
          <section className="card" aria-labelledby="tasks-done">
            <h2 id="tasks-done">{t('Completed|tasks')}</h2>
            {done.isPending ? (
              <p className="muted none">{t('Loading…')}</p>
            ) : done.data?.items.length ? (
              <ul className="task-list flat">{done.data.items.map(row)}</ul>
            ) : (
              <p className="muted none">{t('None yet.|tasks')}</p>
            )}
            {done.data && done.data.total > DONE_PAGE_SIZE ? (
              <Pager
                page={done.data.page}
                pageSize={done.data.pageSize}
                total={done.data.total}
                onPage={(p) => go({ donePage: p > 1 ? String(p) : undefined })}
              />
            ) : null}
          </section>
          <section className="card" aria-labelledby="tasks-how">
            <h2 id="tasks-how">{t('How tasks get here')}</h2>
            <ul className="how-list">
              <li>{t('Lead assigned or transferred to you')}</li>
              <li>{t('Follow-up date set on a lead')}</li>
              <li>{t('Added manually on a lead, email or meeting')}</li>
              <li>{t('Quotation revision requested')}</li>
            </ul>
          </section>
        </aside>
      </div>
      {editing ? <TaskModal task={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

type TaskItemProps = { task: TaskRow; busy: boolean; onTick: () => void; onEdit: () => void; onSnooze: () => void };

/** The prototype's checkbox row: title, "when · lead · origin · assignee", a state badge, and Edit / Snooze. */
function TaskItem({ task, busy, onTick, onEdit, onSnooze }: TaskItemProps) {
  const t = useT();
  const { day } = useFormatDate();
  return (
    <li className={['task', task.isOverdue ? 'over' : '', task.isDone ? 'done' : ''].filter(Boolean).join(' ')}>
      <input
        type="checkbox"
        checked={task.isDone}
        disabled={busy}
        onChange={onTick}
        aria-label={task.isDone ? t('Mark not done: {title}', { title: task.title }) : t('Mark done: {title}', { title: task.title })}
      />
      <span className="grow">
        <strong>{task.title}</strong>
        <span className="m">
          {task.isDone ? (
            day(task.dueDate)
          ) : task.isOverdue ? (
            <span className="overdue">{t('Overdue · {date}', { date: day(task.dueDate) })}</span>
          ) : task.isToday ? (
            t('Today')
          ) : (
            day(task.dueDate)
          )}
          {task.lead ? (
            <>
              {' · '}
              <Link to={`/leads/${task.lead.id}`}>{task.lead.number}</Link> {task.lead.companyName}
            </>
          ) : null}
          {' · '}
          {taskOriginText(t, task.origin)}
          {' · '}
          {task.assignedTo.name}
          {task.closedReason ? ` · ${task.closedReason}` : null}
        </span>
      </span>
      {task.isDone ? (
        <span className="badge b-ok">{t('Done|tasks')}</span>
      ) : task.isOverdue ? (
        <span className="badge b-bad">{t('Overdue|tasks')}</span>
      ) : task.isToday ? (
        <span className="badge b-purple">{t('Today')}</span>
      ) : (
        <span className="badge b-grey">{t('Upcoming')}</span>
      )}
      {!task.isDone ? (
        <span className="task-actions">
          <button type="button" className="btn xs" onClick={onEdit}>
            {t('Edit')}
          </button>
          <button type="button" className="btn xs" disabled={busy} title={t('Move to tomorrow')} onClick={onSnooze}>
            {t('Snooze')}
          </button>
        </span>
      ) : null}
    </li>
  );
}
