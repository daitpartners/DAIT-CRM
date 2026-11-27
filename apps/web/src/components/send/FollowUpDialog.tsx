import { useId, useRef, useState } from 'react';
import {
  DEFAULT_SEND_FOLLOW_UP, UNDO_SEND_SECONDS, instantIn, sendFollowUpChoices, type SendFollowUp, type SendFollowUpKey, type TaskKind,
  type TaskPriority,
} from '@dait-crm/shared';
import { useUsers } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { errorText, taskPriorityText } from '../../i18n/labels';
import { useLang, useT, type TFn } from '../../i18n/useT';
import { whenLabel } from '../../pages/email/sendDates';
import { Icons } from '../Icons';
import { useDialogFocus } from '../Modal';

/** A task note's length limit (SendFollowUp, as TaskCreate). */
const NOTE_MAX = 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type Choice = SendFollowUpKey | 'custom';

function choiceText(t: TFn, key: SendFollowUpKey): string {
  switch (key) {
    case 'tomorrow':
      return t('Tomorrow');
    case 'threeWorkingDays':
      return t('In 3 working days');
    case 'oneWeek':
      return t('In 1 week');
    case 'twoWeeks':
      return t('In 2 weeks');
  }
}

/** The box's Type: Email files a follow-up task, Call a call, Meeting a meeting (spec). */
const KINDS: { kind: TaskKind; label: (t: TFn) => string }[] = [
  { kind: 'followup', label: (t) => t('Email') },
  { kind: 'call', label: (t) => t('Call') },
  { kind: 'meeting', label: (t) => t('Meeting') },
];

/**
 * "Set the next follow-up" (mockup state 6), opened by Send (or Schedule) on a mail to an open lead: when to follow up
 * (Tomorrow, In 3 working days — the default —, In 1 week, In 2 weeks, all at 09:00 counted from `baseDay`, or a chosen
 * date and time), the task's title, assignee (others only with view_all_leads, as TaskModal), type, priority and note,
 * and whether the lead's next follow-up moves too. A chosen time not after `sendAt` (default: the end of the Undo
 * window) is refused. `onSend(followUp)` sends with it, `onSend(null)` without.
 */
export function FollowUpDialog({ lead, who, subject, baseDay, sendAt, busy = false, error = null, onSend, onCancel }: {
  lead: { number: string; company: string; status: string };
  who: string;
  subject: string;
  /** The user's day the presets count from: today, or the day a scheduled send goes out. */
  baseDay: string;
  /** When the mail leaves: a scheduled send's time; a send now leaves at the end of the Undo window. */
  sendAt?: Date;
  /** While the send is being made: nothing closes the box (the send would go on after a Cancel). */
  busy?: boolean;
  /** Why the last send was refused (already in the user's words): shown in the box, which keeps what was entered. */
  error?: string | null;
  onSend(followUp: SendFollowUp | null): void;
  onCancel(): void;
}) {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const { data: users } = useUsers();
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const cancel = () => {
    if (!busy) onCancel();
  };
  useDialogFocus(ref, cancel, 'input[type="radio"]:checked');

  const choices = sendFollowUpChoices(baseDay);
  const fallback = choices.find((c) => c.key === DEFAULT_SEND_FOLLOW_UP)!;
  const [pick, setPick] = useState<Choice>(DEFAULT_SEND_FOLLOW_UP);
  const [customDay, setCustomDay] = useState(fallback.date);
  const [customTime, setCustomTime] = useState(fallback.time);
  const [title, setTitle] = useState(t('Follow up: {subject}', { subject }));
  const [assignee, setAssignee] = useState(String(me.id));
  const [kind, setKind] = useState<TaskKind>('followup');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [note, setNote] = useState('');
  const [updateLead, setUpdateLead] = useState(true);

  // Administrators and managers may give it to anyone active; others to themselves (as TaskModal).
  const others = me.can('view_all_leads') ? (users ?? []).filter((u) => u.isActive && u.id !== me.id) : [];
  const other = others.find((u) => String(u.id) === assignee);

  const chosen = pick === 'custom' ? { date: customDay, time: customTime } : choices.find((c) => c.key === pick)!;
  const wellFormed = DAY.test(chosen.date) && TIME.test(chosen.time);
  const leaves = sendAt ?? new Date(Date.now() + UNDO_SEND_SECONDS * 1000);
  const tooEarly = pick === 'custom' && wellFormed && instantIn(chosen.date, chosen.time, me.timezone).getTime() <= leaves.getTime();
  const when = wellFormed ? whenLabel(chosen.date, chosen.time, me.timezone, lang) : null;
  const canSend = wellFormed && !tooEarly && title.trim() !== '' && !busy;

  function send() {
    if (!canSend) return;
    const trimmed = note.trim();
    onSend({
      date: chosen.date,
      time: chosen.time,
      title: title.trim(),
      assignedToId: Number(assignee),
      kind,
      priority,
      ...(trimmed ? { note: trimmed } : {}),
      updateLead,
    });
  }

  const f = (name: string) => `${id}-${name}`;

  return (
    <div
      className="modal-bg wm-send"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div ref={ref} className="modal fu" role="dialog" aria-modal="true" aria-labelledby={f('title')}>
        <div className="fu-h">
          <h2 id={f('title')}>{t('Set the next follow-up')}</h2>
          <span className={`lchip st-${lead.status.replace(/\s+/g, '-')}`}><i />{lead.number} · {lead.company}</span>
        </div>
        <p className="fu-q">{t('Your email is ready to send. When should you follow up with {who}?', { who })}</p>
        <div className="fu-opts" role="radiogroup" aria-label={t('Follow-up date')}>
          {choices.map((c) => (
            <label key={c.key} className={pick === c.key ? 'radio-card on' : 'radio-card'}>
              <input type="radio" name={f('when')} value={c.key} checked={pick === c.key} onChange={() => setPick(c.key)} />
              <span className="fu-txt">
                <b>{choiceText(t, c.key)}</b>
                {c.key === DEFAULT_SEND_FOLLOW_UP ? <span className="def">{t('Default')}</span> : null}
                <small>{whenLabel(c.date, c.time, me.timezone, lang)}</small>
              </span>
            </label>
          ))}
          <label className={pick === 'custom' ? 'radio-card on fu-custom' : 'radio-card fu-custom'}>
            <input type="radio" name={f('when')} value="custom" checked={pick === 'custom'} onChange={() => setPick('custom')} />
            <span className="fu-txt">
              <b>{t('Choose date and time')}</b>
              <span className="custom-row">
                <input
                  className="in"
                  type="date"
                  aria-label={t('Date')}
                  value={customDay}
                  min={baseDay}
                  onFocus={() => setPick('custom')}
                  onChange={(e) => setCustomDay(e.target.value)}
                />
                <input
                  className="in fu-time"
                  inputMode="numeric"
                  maxLength={5}
                  placeholder="HH:MM"
                  aria-label={t('Time (24-hour)')}
                  value={customTime}
                  onFocus={() => setPick('custom')}
                  onChange={(e) => setCustomTime(e.target.value.trim())}
                />
              </span>
            </span>
          </label>
        </div>
        <div className="fu-hint">{t('Working days skip Saturday and Sunday. Times are 24-hour.')}</div>
        <div>
          <label className="lbl" htmlFor={f('task')}>{t('Task title')}</label>
          <input
            id={f('task')}
            className={title.trim() ? 'in' : 'in err'}
            value={title}
            maxLength={200}
            aria-invalid={!title.trim()}
            aria-describedby={title.trim() ? undefined : f('task-err')}
            onChange={(e) => setTitle(e.target.value)}
          />
          {title.trim() ? null : <div id={f('task-err')} className="err-msg">{t('Enter a title')}</div>}
        </div>
        <div className="grid3">
          <div>
            <label className="lbl" htmlFor={f('who')}>{t('Assigned to')}</label>
            <select id={f('who')} className="in" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value={String(me.id)}>{t('Me ({name})', { name: me.name })}</option>
              {others.map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="lbl" htmlFor={f('kind')}>{t('Type')}</label>
            <select id={f('kind')} className="in" value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
              {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label(t)}</option>)}
            </select>
          </div>
          <div>
            <label className="lbl" htmlFor={f('prio')}>{t('Priority')}</label>
            <select id={f('prio')} className="in" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {(['normal', 'high'] as const).map((p) => <option key={p} value={p}>{taskPriorityText(t, p)}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="lbl" htmlFor={f('note')}>{t('Note')} <span className="lbl-note">{t('(optional)')}</span></label>
          <textarea
            id={f('note')}
            className="in"
            rows={2}
            maxLength={NOTE_MAX}
            placeholder={t('e.g. Ask whether the CTO has reviewed the examples')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={updateLead} onChange={(e) => setUpdateLead(e.target.checked)} />
          {t("Also update the lead's next follow-up")}
        </label>
        {error ? <div className="note danger" role="alert">{error}</div> : null}
        {tooEarly ? (
          <div className="note danger" role="alert">{errorText(t, 'follow_up_time')}</div>
        ) : when ? (
          <div className="note ok" aria-live="polite">
            <b>{other ? t("Added to {name}'s Tasks", { name: other.name }) : t('Added to your Tasks')}</b> · {t('due {when}.', { when })}
          </div>
        ) : null}
        <div className="actions">
          <button type="button" className="linkbtn" disabled={busy} onClick={() => onSend(null)}>{t('Send without follow-up')}</button>
          <button type="button" className="btn" disabled={busy} onClick={cancel}>{t('Cancel')}</button>
          <button type="button" className="btn primary" disabled={!canSend} onClick={send}>
            <span className="ico">{Icons.send}</span>
            {t('Send and add follow-up')}
          </button>
        </div>
      </div>
    </div>
  );
}
