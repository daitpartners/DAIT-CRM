import { useMemo, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { TaskCreate, TaskUpdate } from '@dait-crm/shared';
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
import { useT, type TFn } from '../../i18n/useT';

type Values = { title: string; dueDate: string; assignedToId: string; leadId: string; updatedAt?: string };
type Field = Exclude<keyof Values, 'updatedAt'>;
const FIELDS: Field[] = ['title', 'dueDate', 'assignedToId', 'leadId'];

function fieldMessage(t: TFn, f: Field): string {
  switch (f) {
    case 'title':
      return t('Enter a title');
    case 'dueDate':
      return t('Enter a valid date');
    case 'assignedToId':
      return t('Choose who does it');
    default:
      return t('Check this value');
  }
}

/** Today in the browser as YYYY-MM-DD (the default due date). */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Add a manual task (optionally on a lead; `lead` fixes it, as from the lead page's "+ Task"), or edit a task's
 * title, due date and assignee.
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
  const fixedLead = task ? task.lead : lead;

  const resolver = useMemo<Resolver<Values>>(() => {
    const zod = (editing ? zodResolver(TaskUpdate) : zodResolver(TaskCreate)) as unknown as Resolver<Values>;
    return (values, ctx, opts) =>
      zod(
        {
          ...values,
          assignedToId: values.assignedToId ? Number(values.assignedToId) : undefined,
          leadId: values.leadId && !editing ? Number(values.leadId) : undefined,
        } as unknown as Values,
        ctx,
        opts,
      );
  }, [editing]);

  const { register, handleSubmit, setError, setValue, watch, formState } = useForm<Values>({
    resolver,
    defaultValues: {
      title: task?.title ?? '',
      dueDate: task?.dueDate ?? today(),
      assignedToId: String(task?.assignedTo.id ?? me.id),
      leadId: task?.leadId ? String(task.leadId) : lead ? String(lead.id) : '',
      ...(task ? { updatedAt: task.updatedAt } : {}),
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
