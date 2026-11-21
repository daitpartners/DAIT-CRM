import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { TASK_TABS } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useSaveTask, useSnoozeTask, useTasks, type TaskRow, type TaskTab } from '../../api/tasks';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Pager } from '../../components/Pager';
import { Tabs } from '../../components/Tabs';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText, taskOriginText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { TaskModal } from './TaskModal';

const PAGE_SIZE = 25;

/** Tasks (prototype V.tasks): Today / Overdue / Upcoming / Done, mine or (managers) the team's. */
export function TasksList() {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const { day } = useFormatDate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: TaskTab = (TASK_TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as TaskTab) : 'today';
  const team = me.can('view_all_leads') && searchParams.get('scope') === 'team';
  const pageNum = Number(searchParams.get('page'));
  const page = Number.isInteger(pageNum) && pageNum > 0 ? pageNum : 1;
  const { data, isPending, error } = useTasks({ tab, page, pageSize: PAGE_SIZE, ...(team ? { assignedTo: 'all' as const } : {}) });
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
      if (!('page' in patch)) next.delete('page');
      return next;
    });

  const fail = (err: unknown) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn');

  function tick(task: TaskRow) {
    save.mutate(
      { id: task.id, body: { isDone: !task.isDone, updatedAt: task.updatedAt } },
      { onSuccess: () => toast(task.isDone ? t('Task reopened') : t('Task done')), onError: fail },
    );
  }

  const counts = data?.counts;
  const tabs = [
    { id: 'today', label: t('Today'), count: counts?.today },
    { id: 'overdue', label: t('Overdue|tasks'), count: counts?.overdue },
    { id: 'upcoming', label: t('Upcoming'), count: counts?.upcoming },
    { id: 'done', label: t('Done|tasks'), count: counts?.done },
  ];
  const empty = {
    today: t('Nothing due today.'),
    overdue: t('Nothing overdue.'),
    upcoming: t('Nothing coming up.'),
    done: t('No completed tasks yet.'),
  }[tab];
  const rows = data?.items ?? [];
  const busy = save.isPending || snooze.isPending;

  return (
    <>
      <Topbar title={t('Tasks')} sub={t('Follow-ups, new assignments and transferred leads')}>
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
      <div className="page">
        <section className="card flush" aria-label={t('Tasks')}>
          <Tabs tabs={tabs} active={tab} onChange={(id) => go({ tab: id === 'today' ? undefined : id })} label={t('Task views')}>
            {error ? (
              <div className="empty" role="alert">
                {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
              </div>
            ) : isPending ? (
              <div className="empty">{t('Loading…')}</div>
            ) : rows.length === 0 ? (
              <div className="empty">{empty}</div>
            ) : (
              <ul className="task-list">
                {rows.map((task) => (
                  <li key={task.id} className={['task', task.isOverdue ? 'over' : '', task.isDone ? 'done' : ''].filter(Boolean).join(' ')}>
                    <input
                      type="checkbox"
                      checked={task.isDone}
                      disabled={busy}
                      onChange={() => tick(task)}
                      aria-label={task.isDone ? t('Mark not done: {title}', { title: task.title }) : t('Mark done: {title}', { title: task.title })}
                    />
                    <span className="grow">
                      <strong>{task.title}</strong>
                      <span className="m">
                        {task.isOverdue ? (
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
                    {!task.isDone ? (
                      <span className="task-actions">
                        <button type="button" className="btn xs" onClick={() => setEditing(task)}>
                          {t('Edit')}
                        </button>
                        <button
                          type="button"
                          className="btn xs"
                          disabled={busy}
                          title={t('Move to tomorrow')}
                          onClick={() => snooze.mutate(task, { onSuccess: () => toast(t('Moved to tomorrow')), onError: fail })}
                        >
                          {t('Snooze')}
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {data && data.total > 0 ? (
              <div className="foot">
                <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => go({ page: p > 1 ? String(p) : undefined })} />
              </div>
            ) : null}
          </Tabs>
        </section>
      </div>
      {editing ? <TaskModal task={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
