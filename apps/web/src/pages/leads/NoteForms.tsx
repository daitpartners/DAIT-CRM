import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLeadNote, type LeadFull } from '../../api/leads';
import { FormField } from '../../components/FormField';
import { useToast } from '../../components/Toast';
import { applyServerIssues } from '../../forms/applyServerIssues';
import { useT, type TFn } from '../../i18n/useT';
import { localDayPlus } from './FollowUpPanel';
import { useActionError } from './staleToast';

type MeetingValues = { title: string; date: string; time: string; body: string };
type MeetingField = keyof MeetingValues;

function meetingMessage(t: TFn, f: MeetingField): string {
  if (f === 'title') return t('Enter a title');
  if (f === 'date' || f === 'time') return t('Enter a valid date');
  return t('Check this value');
}

/**
 * The compose panel's "Meeting" tab: records a meeting on the timeline (`POST /meeting`, a `meeting` activity
 * dated when it took place). No calendar invite: the prototype's length, place and invitees come with release 3.
 */
export function MeetingForm({ lead, disabled }: { lead: LeadFull; disabled?: boolean }) {
  const t = useT();
  const toast = useToast();
  const note = useLeadNote();
  const onFail = useActionError();
  const [formError, setFormError] = useState<string | null>(null);
  const defaults = (): MeetingValues => ({
    title: t('Meeting · {company}', { company: lead.companyName }), date: localDayPlus(0), time: '10:00', body: '',
  });
  const { register, handleSubmit, setError, reset, formState } = useForm<MeetingValues>({ defaultValues: defaults() });
  const { errors } = formState;

  function submit(v: MeetingValues) {
    setFormError(null);
    const at = new Date(`${v.date}T${v.time || '00:00'}`);
    if (Number.isNaN(at.getTime())) {
      setError('date', { type: 'server', message: meetingMessage(t, 'date') });
      return;
    }
    note.mutate(
      { lead, kind: 'meeting', body: { title: v.title.trim(), occurredAt: at.toISOString(), ...(v.body.trim() ? { body: v.body.trim() } : {}) } },
      {
        onSuccess: () => {
          toast(t('Meeting saved'));
          reset(defaults());
        },
        onError: (err) => {
          onFail(err);
          // The API names the date `occurredAt`; it is shown on the Date field.
          const issues = applyServerIssues(
            err,
            ['title', 'body', 'occurredAt'] as const,
            (f, e) => setError(f === 'occurredAt' ? 'date' : f, e),
            t,
            (f) => meetingMessage(t, f === 'occurredAt' ? 'date' : f),
          );
          setFormError(issues.formMessage);
        },
      },
    );
  }

  const err = (f: MeetingField) => (errors[f] ? (errors[f]?.message || meetingMessage(t, f)) : undefined);
  const aria = (f: MeetingField) => ({ 'aria-invalid': Boolean(errors[f]), 'aria-describedby': errors[f] ? `mt-${f}-err` : undefined });

  return (
    <form noValidate aria-label={t('Meeting')} onSubmit={(e) => void handleSubmit(submit)(e)}>
      <fieldset className="grid3 bare" disabled={disabled}>
        <FormField id="mt-title" label={t('Title')} required error={err('title')} className="span3">
          <input id="mt-title" className={errors.title ? 'in err' : 'in'} {...aria('title')} {...register('title', { validate: (v) => v.trim() !== '' })} />
        </FormField>
        <FormField id="mt-date" label={t('Date')} required error={err('date')}>
          <input id="mt-date" type="date" className={errors.date ? 'in err' : 'in'} {...aria('date')} {...register('date', { required: true })} />
        </FormField>
        <FormField id="mt-time" label={t('Time')} error={err('time')}>
          <input id="mt-time" type="time" className="in" {...aria('time')} {...register('time')} />
        </FormField>
        <div />
        <FormField id="mt-body" label={t('Notes')} error={err('body')} className="span3">
          <textarea id="mt-body" className="in" rows={4} placeholder={t('Who attended, what was agreed, next steps…')} {...aria('body')} {...register('body')} />
        </FormField>
      </fieldset>
      {formError ? (
        <div className="note warn" role="alert">
          {formError}
        </div>
      ) : null}
      <div className="form-end">
        <span className="dim">{t('Saved on the timeline. Calendar invites come with release 3.')}</span>
        <button type="submit" className="btn primary" disabled={disabled || note.isPending}>
          {t('Save meeting')}
        </button>
      </div>
    </form>
  );
}

type ResearchValues = { title: string; url: string; body: string };
type ResearchField = keyof ResearchValues;
const RESEARCH_FIELDS: ResearchField[] = ['title', 'url', 'body'];

function researchMessage(t: TFn, f: ResearchField): string {
  if (f === 'title') return t('Enter a title');
  if (f === 'url') return t('Enter a valid web address');
  return t('Check this value');
}

/** The compose panel's "Research note" tab: a finding from outside the CRM (`POST /research`, a `research` activity). */
export function ResearchForm({ lead, disabled }: { lead: LeadFull; disabled?: boolean }) {
  const t = useT();
  const toast = useToast();
  const note = useLeadNote();
  const onFail = useActionError();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, reset, formState } = useForm<ResearchValues>({ defaultValues: { title: '', url: '', body: '' } });
  const { errors } = formState;

  function submit(v: ResearchValues) {
    setFormError(null);
    note.mutate(
      {
        lead,
        kind: 'research',
        body: { title: v.title.trim(), ...(v.url.trim() ? { url: v.url.trim() } : {}), ...(v.body.trim() ? { body: v.body.trim() } : {}) },
      },
      {
        onSuccess: () => {
          toast(t('Research saved'));
          reset();
        },
        onError: (err) => {
          onFail(err);
          setFormError(applyServerIssues(err, RESEARCH_FIELDS, setError, t, (f) => researchMessage(t, f)).formMessage);
        },
      },
    );
  }

  const err = (f: ResearchField) => (errors[f] ? (errors[f]?.message || researchMessage(t, f)) : undefined);
  const aria = (f: ResearchField) => ({ 'aria-invalid': Boolean(errors[f]), 'aria-describedby': errors[f] ? `rs-${f}-err` : undefined });

  return (
    <form noValidate aria-label={t('Research note')} onSubmit={(e) => void handleSubmit(submit)(e)}>
      <div className="note ai">
        {t('Save anything you found outside the CRM: LinkedIn, news, annual reports, competitor notes. Saved against this lead on its timeline.')}
      </div>
      <fieldset className="grid2 bare" disabled={disabled}>
        <FormField id="rs-title" label={t('Title')} required error={err('title')}>
          <input
            id="rs-title"
            className={errors.title ? 'in err' : 'in'}
            placeholder={t('e.g. LinkedIn: new CFO appointed')}
            {...aria('title')}
            {...register('title', { validate: (v) => v.trim() !== '' })}
          />
        </FormField>
        <FormField id="rs-url" label={t('Link (optional)')} error={err('url')}>
          <input id="rs-url" type="url" className={errors.url ? 'in err' : 'in'} placeholder="https://" {...aria('url')} {...register('url')} />
        </FormField>
        <FormField id="rs-body" label={t('Notes')} error={err('body')} className="span2">
          <textarea
            id="rs-body"
            className="in"
            rows={5}
            placeholder={t('What did you learn, and why does it matter for this deal?')}
            {...aria('body')}
            {...register('body')}
          />
        </FormField>
      </fieldset>
      {formError ? (
        <div className="note warn" role="alert">
          {formError}
        </div>
      ) : null}
      <div className="form-end">
        <button type="submit" className="btn primary" disabled={disabled || note.isPending}>
          {t('Save research')}
        </button>
      </div>
    </form>
  );
}

