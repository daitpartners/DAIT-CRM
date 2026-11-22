import { useState } from 'react';
import { isClosedStatus, type TaskKind } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useLeads, type LeadSummary } from '../../api/leads';
import { useUsers } from '../../api/queries';
import { useSaveTask } from '../../api/tasks';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Combobox } from '../../components/Combobox';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useDebounce } from '../../hooks/useDebounce';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { isDate, shortDay, type CalendarNames } from './dates';

const leadLabel = (l: LeadSummary) => [l.number, l.companyName, l.contact?.name].filter(Boolean).join(' · ');

/**
 * Prototype "New follow-up" (V.calendar): lead, what to do, type, assignee, date and time. Saves a task of that kind
 * (a call or meeting needs a time) with a "planned" entry on the lead's timeline. Checked as the prototype, one
 * message at a time.
 */
export function NewFollowUpModal({ date, names, onClose }: { date: string; names: CalendarNames; onClose: () => void }) {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const save = useSaveTask();
  const { data: users } = useUsers();

  // Lead: open, non-archived leads the user can see, searched on the server; the chosen one stays chosen.
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<LeadSummary | null>(null);
  const debounced = useDebounce(q.trim(), 250);
  const { data } = useLeads({ q: debounced || undefined, pageSize: 25, tab: 'all' });
  const found = (data?.items ?? []).filter((l) => !l.archivedAt && !isClosedStatus(l.status));
  const leads = !q.trim() && chosen && !found.some((l) => l.id === chosen.id) ? [chosen, ...found] : found;

  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<TaskKind>('followup');
  const [assignedToId, setAssignedToId] = useState(String(me.id));
  const [day, setDay] = useState(date);
  const [time, setTime] = useState('');

  // As the task rules: administrators and managers may give it to anyone active; others to themselves.
  const assignees = [
    { id: me.id, name: me.name },
    ...(me.can('view_all_leads') ? (users ?? []).filter((u) => u.isActive && u.id !== me.id).map(({ id, name }) => ({ id, name })) : []),
  ];

  function go() {
    const warn = (m: string) => toast(m, 'warn');
    if (!chosen) return warn(t('Choose a lead'));
    if (!title.trim()) return warn(t('Say what needs doing'));
    if (!isDate(day)) return warn(t('Choose a date'));
    if (kind !== 'followup' && !time) return warn(kind === 'call' ? t('A call needs a time') : t('A meeting needs a time'));
    save.mutate(
      {
        body: {
          leadId: chosen.id, title: title.trim(), dueDate: day, assignedToId: Number(assignedToId), kind,
          ...(time ? { dueTime: time } : {}), timeline: true,
        },
      },
      {
        onSuccess: () => {
          const when = shortDay(day, names);
          toast(kind === 'call' ? t('Call added for {date}', { date: when }) : kind === 'meeting' ? t('Meeting added for {date}', { date: when }) : t('Follow-up added for {date}', { date: when }));
          onClose();
        },
        onError: (err) => warn(errorText(t, err instanceof ApiError ? err.code : 'unknown')),
      },
    );
  }

  return (
    <Modal
      title={t('New follow-up')}
      onClose={onClose}
      focusDialog
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={go}>
            {t('Add to calendar')}
          </button>
        </>
      }
    >
      <div className="grid2">
        <div className="span2">
          <Combobox
            id="fuLead"
            label={t('Lead')}
            required
            searchable
            options={leads.map((l) => ({ value: String(l.id), label: leadLabel(l) }))}
            value={chosen ? String(chosen.id) : null}
            placeholder={t('— choose a lead —')}
            onQuery={setQ}
            onChange={(v) => setChosen(leads.find((l) => String(l.id) === v) ?? null)}
          />
        </div>
        <div className="span2">
          <label className="lbl" htmlFor="fuTitle">
            {t('What to do')} <span className="req">*</span>
          </label>
          <input id="fuTitle" className="in" value={title} placeholder={t('e.g. Call back about the proposal')} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label className="lbl" htmlFor="fuType">
            {t('Type')}
          </label>
          <select id="fuType" className="in" value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
            <option value="followup">{t('Follow-up (task)')}</option>
            <option value="call">{t('Call')}</option>
            <option value="meeting">{t('Meeting')}</option>
          </select>
        </div>
        <div>
          <label className="lbl" htmlFor="fuWho">
            {t('Assigned to')}
          </label>
          <select id="fuWho" className="in" value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)}>
            {assignees.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="lbl" htmlFor="fuDate">
            {t('Date')} <span className="req">*</span>
          </label>
          <input id="fuDate" className="in" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </div>
        <div>
          <label className="lbl" htmlFor="fuTime">
            {t('Time')} <span className="dim">{t('· optional for a follow-up')}</span>
          </label>
          <input id="fuTime" className="in" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}
