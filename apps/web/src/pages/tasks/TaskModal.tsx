import { useMemo, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { TASK_KINDS, TASK_PRIORITIES, TaskCreate, TaskUpdate, type TaskKind, type TaskPriority } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useLeads } from '../../api/leads';
import { keys, useUsers } from '../../api/queries';
import { useSaveTask, type TaskRow } from '../../api/tasks';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Combobox, type ComboOption } from '../../components/Combobox';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { applyServerIssues } from '../../forms/applyServerIssues';
import { useDebounce } from '../../hooks/useDebounce';
import { errorText, taskKindText, taskPriorityText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';

type Values = {
  title: string; dueDate: string; assignedToId: string; leadId: string; kind: TaskKind; dueTime: string; priority: TaskPriority; note: string;
  updatedAt?: string;
};
type Field = Exclude<keyof Values, 'updatedAt'>;
const FIELDS: Field[] = ['title', 'dueDate', 'assignedToId', 'leadId', 'kind', 'dueTime', 'priority', 'note'];

function fieldMessage(t: TFn, f: Field): string {
  switch (f) {
    case 'title':
      return t('Enter a title');
    case 'dueDate':
      return t('Enter a valid date');
    case 'assignedToId':
      return t('Choose who does it');
    case 'dueTime':
      return t('Enter a time for a call or meeting');
    case 'note':
      return t('Up to 1000 characters');
    default:
      return t('Check this value');
  }
}

/** A task note's length limit (TaskCreate / TaskUpdate). */
const NOTE_MAX = 1000;

/** Today in the browser as YYYY-MM-DD (the default due date). */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Add a manual task (optionally on a lead; `lead` fixes it, as from the lead page's "+ Task"), or edit a task's
 * title, type, due date and time, assignee, priority and note. Only editing offers type and time (owner, release 3C); a
 * call or meeting needs a time. Priority and note are offered in both (web-mail release 3, plan decision 14).
 */
export function TaskModal({ task, lead, onClose }: { task?: TaskRow; lead?: Pick<TaskRow, 'lead'>['lead']; onClose: () => void }) {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: users } = useUsers();
  const save = useSaveTask();
  const [formError, setFormError] = useState<string | null>(null);
  const editing = Boolean(task);
  // The automatic follow-up task is managed from the lead: it stays a follow-up (the server refuses another type).
  const fixedKind = task?.origin === 'follow_up';
  const fixedLead = task ? task.lead : lead;

  const resolver = useMemo<Resolver<Values>>(() => {
    const zod = (editing ? zodResolver(TaskUpdate) : zodResolver(TaskCreate)) as unknown as Resolver<Values>;
    return async (values, ctx, opts) => {
      const result = await zod(
        {
          ...values,
          assignedToId: values.assignedToId ? Number(values.assignedToId) : undefined,
          leadId: values.leadId && !editing ? Number(values.leadId) : undefined,
          // An emptied time is sent as null (cleared); the Add dialog sends neither.
          kind: editing ? values.kind : undefined,
          dueTime: editing ? values.dueTime || null : undefined,
        } as unknown as Values,
        ctx,
        opts,
      );
      // As the server checks it: a call or meeting always has a time. A disabled Type reads as undefined.
      if (editing && (values.kind ?? 'followup') !== 'followup' && !values.dueTime) {
        return { values: {}, errors: { ...result.errors, dueTime: { type: 'required', message: '' } } };
      }
      return result;
    };
  }, [editing]);

  const { register, handleSubmit, setError, setValue, watch, formState } = useForm<Values>({
    resolver,
    defaultValues: {
      title: task?.title ?? '',
      dueDate: task?.dueDate ?? today(),
      assignedToId: String(task?.assignedTo.id ?? me.id),
      leadId: task?.leadId ? String(task.leadId) : lead ? String(lead.id) : '',
      priority: task?.priority ?? 'normal',
      note: task?.note ?? '',
      ...(task ? { kind: task.kind, dueTime: task.dueTime ?? '', updatedAt: task.updatedAt } : {}),
    },
  });
  const { errors } = formState;
  const leadId = watch('leadId');

  // Administrators and managers may give a task to anyone active; others to themselves.
  const assignees: { id: number; name: string }[] = me.can('view_all_leads')
    ? (users ?? []).filter((u) => u.isActive && u.id !== me.id).map(({ id, name }) => ({ id, name }))
    : [];
  // Keep the current assignee selectable when editing someone else's task.
  if (task && task.assignedTo.id !== me.id && !assignees.some((u) => u.id === task.assignedTo.id)) assignees.push(task.assignedTo);

  function submit(v: Values) {
    save.mutate(
      { id: task?.id, body: v as unknown as TaskCreate },
      {
        onSuccess: () => {
          toast(editing ? t('Task updated') : t('Task added'));
          onClose();
        },
        onError: (err) => {
          const code = err instanceof ApiError ? err.code : 'unknown';
          if (code === 'stale') void qc.invalidateQueries({ queryKey: keys.tasksAll });
          if (code === 'cannot_assign_hidden') {
            setError('assignedToId', { type: 'server', message: t('That person cannot see this lead') });
            return;
          }
          if (code === 'follow_up_kind') {
            setError('kind', { type: 'server', message: errorText(t, code) });
            return;
          }
          if (code === 'time_required') {
            setError('dueTime', { type: 'server', message: fieldMessage(t, 'dueTime') });
            return;
          }
          setFormError(applyServerIssues(err, FIELDS, setError, t, (f) => fieldMessage(t, f)).formMessage);
        },
      },
    );
  }

  const err = (f: Field) => (errors[f] ? (errors[f]?.type === 'server' ? errors[f]?.message : fieldMessage(t, f)) : undefined);
  const aria = (f: Field) => ({ 'aria-invalid': Boolean(errors[f]), 'aria-describedby': errors[f] ? `tk-${f}-err` : undefined });

  return (
    <Modal
      title={editing ? t('Edit task') : t('New task')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="task-form" className="btn primary" disabled={save.isPending}>
            {t('Save')}
          </button>
        </>
      }
    >
      <form
        id="task-form"
        noValidate
        className="grid2"
        onSubmit={(e) => {
          setFormError(null);
          void handleSubmit(submit)(e);
        }}
      >
        <FormField id="tk-title" label={t('Title')} required error={err('title')} className="span2">
          <input id="tk-title" className={errors.title ? 'in err' : 'in'} {...aria('title')} {...register('title')} />
        </FormField>
        <FormField id="tk-dueDate" label={t('Due date')} required error={err('dueDate')}>
          <input id="tk-dueDate" type="date" className={errors.dueDate ? 'in err' : 'in'} {...aria('dueDate')} {...register('dueDate')} />
        </FormField>
        {editing ? (
          <>
            <FormField id="tk-dueTime" label={t('Time')} error={err('dueTime')}>
              <input id="tk-dueTime" type="time" className={errors.dueTime ? 'in err' : 'in'} {...aria('dueTime')} {...register('dueTime')} />
            </FormField>
            <FormField id="tk-kind" label={t('Type')} error={err('kind')}>
              <select id="tk-kind" className={errors.kind ? 'in err' : 'in'} disabled={fixedKind} {...aria('kind')} {...register('kind')}>
                {TASK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {taskKindText(t, k)}
                  </option>
                ))}
              </select>
            </FormField>
          </>
        ) : null}
        <FormField id="tk-assignedToId" label={t('Assigned to')} required error={err('assignedToId')}>
          <select id="tk-assignedToId" className={errors.assignedToId ? 'in err' : 'in'} {...aria('assignedToId')} {...register('assignedToId')}>
            <option value={String(me.id)}>{t('Me')}</option>
            {assignees.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="tk-priority" label={t('Priority')} error={err('priority')}>
          <select id="tk-priority" className={errors.priority ? 'in err' : 'in'} {...aria('priority')} {...register('priority')}>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {taskPriorityText(t, p)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="tk-note" label={t('Note')} error={err('note')} className="span2">
          <textarea id="tk-note" className={errors.note ? 'in err' : 'in'} rows={3} maxLength={NOTE_MAX} {...aria('note')} {...register('note')} />
        </FormField>
        <div className="span2">
          {task || lead ? (
            <FormField id="tk-lead" label={t('Lead')}>
              <input id="tk-lead" className="in" readOnly value={fixedLead ? `${fixedLead.number} ${fixedLead.companyName}` : t('No lead')} />
            </FormField>
          ) : (
            <LeadPicker value={leadId} onChange={(v) => setValue('leadId', v)} />
          )}
        </div>
        {formError ? (
          <div className="span2 note warn" role="alert">
            {formError}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

/** Optional lead for a new task, searched server-side (`/leads?q=`). */
function LeadPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const q = useDebounce(text.trim(), 300);
  const { data } = useLeads({ page: 1, pageSize: 20, q: q || undefined });
  const [chosen, setChosen] = useState<ComboOption | null>(null);
  const options = useMemo(() => {
    const opts: ComboOption[] = [{ value: '0', label: t('No lead') }];
    for (const l of data?.items ?? []) opts.push({ value: String(l.id), label: `${l.number} ${l.companyName}` });
    if (chosen && !opts.some((o) => o.value === chosen.value)) opts.splice(1, 0, chosen);
    return opts;
  }, [data, chosen, t]);
  return (
    <Combobox
      id="tk-leadId"
      label={t('Lead')}
      searchable
      options={options}
      value={value || '0'}
      placeholder={t('Type to search leads…')}
      onQuery={setText}
      onChange={(v) => {
        const o = options.find((x) => x.value === v);
        if (o && v !== '0') setChosen(o);
        onChange(v === '0' ? '' : v);
      }}
    />
  );
}
