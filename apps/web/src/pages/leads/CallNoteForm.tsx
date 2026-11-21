import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { CALL_OUTCOMES, isClosedStatus, type CallOutcome } from '@dait-crm/shared';
import { useLeadAction, type LeadFull } from '../../api/leads';
import type { LookupValue } from '../../api/queries';
import { FormField } from '../../components/FormField';
import { useToast } from '../../components/Toast';
import { applyServerIssues } from '../../forms/applyServerIssues';
import { leadStatusText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';
import { useActionError } from './staleToast';

type Values = { outcome: CallOutcome; minutes: string; body: string; statusAfter: string; nextFollowUp: string };
type Field = keyof Values;
const FIELDS: Field[] = ['outcome', 'minutes', 'body', 'statusAfter', 'nextFollowUp'];

export function callOutcomeText(t: TFn, outcome: CallOutcome): string {
  switch (outcome) {
    case 'Connected':
      return t('Connected|call');
    case 'No answer':
      return t('No answer');
    case 'Voicemail':
      return t('Voicemail');
    case 'Wrong number':
      return t('Wrong number');
    case 'Callback requested':
      return t('Callback requested');
    default:
      return outcome;
  }
}

function fieldMessage(t: TFn, f: Field): string {
  if (f === 'minutes') return t('Enter whole minutes, 0 to 600');
  if (f === 'nextFollowUp') return t('Enter a valid date');
  return t('Check this value');
}

/**
 * The compose panel's "Call note" tab (formerly the Log call dialog): outcome, minutes, note, an optional status
 * after the call and the next follow-up, in one POST to `/log-call`. Closed statuses are not offered (Lost /
 * Not Relevant need a reason: use Close lead). After a save the form clears for the next call.
 */
export function CallNoteForm({ lead, statuses, disabled }: { lead: LeadFull; statuses: LookupValue[]; disabled?: boolean }) {
  const t = useT();
  const toast = useToast();
  const action = useLeadAction();
  const onFail = useActionError();
  const [formError, setFormError] = useState<string | null>(null);
  const defaults = (): Values => ({ outcome: 'Connected', minutes: '', body: '', statusAfter: '', nextFollowUp: lead.nextFollowUp ?? '' });
  const { register, handleSubmit, setError, watch, reset, resetField, formState } = useForm<Values>({ defaultValues: defaults() });
  const { errors, dirtyFields } = formState;
  // The follow-up can change elsewhere on the page (Follow-up tab): an untouched field follows it.
  useEffect(() => {
    if (!dirtyFields.nextFollowUp) resetField('nextFollowUp', { defaultValue: lead.nextFollowUp ?? '' });
  }, [lead.nextFollowUp, dirtyFields.nextFollowUp, resetField]);
  const options = statuses
    .filter((s) => s.isActive && !isClosedStatus(s.value) && s.value !== lead.status)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  // A closed lead keeps no follow-up unless the call reopens it.
  const followUpAllowed = !isClosedStatus(lead.status) || watch('statusAfter') !== '';

  function submit(v: Values) {
    setFormError(null);
    const minutes = v.minutes.trim() === '' ? undefined : Number(v.minutes);
    if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 0 || minutes > 600)) {
      setError('minutes', { type: 'server', message: fieldMessage(t, 'minutes') });
      return;
    }
    // Send the follow-up only when the user changed it: an untouched field must not clear or move it.
    const changed = followUpAllowed && Boolean(dirtyFields.nextFollowUp) && v.nextFollowUp !== (lead.nextFollowUp ?? '');
    action.mutate(
      {
        lead,
        action: 'log-call',
        body: {
          outcome: v.outcome,
          ...(minutes !== undefined ? { minutes } : {}),
          ...(v.body.trim() ? { body: v.body.trim() } : {}),
          ...(v.statusAfter ? { statusAfter: v.statusAfter } : {}),
          ...(changed ? { nextFollowUp: v.nextFollowUp || null } : {}),
        },
      },
      {
        onSuccess: (saved) => {
          toast(t('Call logged'));
          reset({ ...defaults(), nextFollowUp: saved.nextFollowUp ?? '' });
        },
        onError: (err) => {
          onFail(err);
          setFormError(applyServerIssues(err, FIELDS, setError, t, (f) => fieldMessage(t, f)).formMessage);
        },
      },
    );
  }

  const err = (f: Field) => (errors[f] ? (errors[f]?.message || fieldMessage(t, f)) : undefined);
  const aria = (f: Field) => ({ 'aria-invalid': Boolean(errors[f]), 'aria-describedby': errors[f] ? `lc-${f}-err` : undefined });

  return (
    <form noValidate className="cnote" aria-label={t('Call note')} onSubmit={(e) => void handleSubmit(submit)(e)}>
      <fieldset className="grid3 bare" disabled={disabled}>
        <FormField id="lc-outcome" label={t('Outcome')} required error={err('outcome')}>
          <select id="lc-outcome" className="in" {...aria('outcome')} {...register('outcome')}>
            {CALL_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {callOutcomeText(t, o)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="lc-minutes" label={t('Minutes')} error={err('minutes')}>
          <input id="lc-minutes" type="number" min={0} max={600} step={1} className={errors.minutes ? 'in err' : 'in'} {...aria('minutes')} {...register('minutes')} />
        </FormField>
        <FormField id="lc-statusAfter" label={t('Status after call')} error={err('statusAfter')}>
          <select id="lc-statusAfter" className="in" {...aria('statusAfter')} {...register('statusAfter')}>
            <option value="">{t('Keep {status}', { status: leadStatusText(t, lead.status) })}</option>
            {options.map((s) => (
              <option key={s.value} value={s.value}>
                {leadStatusText(t, s.value)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="lc-body" label={t('Note')} error={err('body')} className="span3">
          <textarea id="lc-body" className="in" rows={4} placeholder={t('Key points, objections, next step agreed…')} {...aria('body')} {...register('body')} />
        </FormField>
        <FormField id="lc-nextFollowUp" label={t('Next follow-up')} error={err('nextFollowUp')}>
          <input
            id="lc-nextFollowUp"
            type="date"
            className={errors.nextFollowUp ? 'in err' : 'in'}
            disabled={!followUpAllowed}
            {...aria('nextFollowUp')}
            {...register('nextFollowUp')}
          />
        </FormField>
      </fieldset>
      {formError ? (
        <div className="note warn" role="alert">
          {formError}
        </div>
      ) : null}
      <div className="form-end">
        <button type="submit" className="btn primary" disabled={disabled || action.isPending}>
          {t('Save call')}
        </button>
      </div>
    </form>
  );
}
