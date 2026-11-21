import { useMemo, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { LEAD_TYPES, LeadUpdate } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { useSaveContact, useUpdateContactProfile } from '../../api/contacts';
import { useLeadAction, useSaveLead, type LeadDetail, type LeadFull } from '../../api/leads';
import { keys } from '../../api/queries';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText, leadTypeText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { ExperienceEditor, toExperience, toXpRows, type XpRow } from './ExperienceEditor';
import { leadSaveError, useLeadFormFields, type LeadFormValues } from './LeadFormFields';

type Props = {
  /** The lead whose details are edited (a new lead is created on the `/leads/new` page). */
  lead: LeadDetail;
  onClose: () => void;
};

/** Fields PATCH /leads/:id accepts (status, assignee, company and contact have their own endpoints). */
const DETAIL_FIELDS = [
  'leadType', 'companyName', 'website', 'businessEmail', 'phone', 'country', 'city', 'leadSource', 'sourceUrl', 'priority',
  'nextFollowUp', 'notes', 'outreachLanguage',
] as const;

const text = (v: string | null | undefined) => v ?? '';

/** The form's starting values: the lead being edited, with its `updatedAt`. */
function formValues(lead: LeadDetail): LeadFormValues {
  return {
    leadType: lead.leadType,
    companyName: lead.companyName,
    website: text(lead.website),
    businessEmail: text(lead.businessEmail),
    phone: text(lead.phone),
    country: lead.country,
    city: text(lead.city),
    outreachLanguage: lead.outreachLanguage,
    leadSource: lead.leadSource,
    sourceUrl: text(lead.sourceUrl),
    priority: lead.priority,
    nextFollowUp: text(lead.nextFollowUp),
    notes: text(lead.notes),
    status: lead.status,
    linkCompanyId: undefined,
    contactId: '',
    assignedToId: '',
    updatedAt: lead.updatedAt,
  };
}

/** Edit lead (spec §4.2), validated with the shared LeadUpdate schema. */
export function LeadModal({ lead, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const save = useSaveLead();
  const qc = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const saveContact = useSaveContact();
  const saveProfile = useUpdateContactProfile();
  const linkContact = useLeadAction();
  // Experience (owner, 22 Nov 2026): the contact's roles, or a new person's name + roles on a lead without a contact.
  const startRows = useMemo(() => toXpRows(lead.contact?.experience ?? []), [lead.contact]);
  const [xpRows, setXpRows] = useState<XpRow[]>(startRows);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const busy = save.isPending || saveContact.isPending || saveProfile.isPending || linkContact.isPending;

  const resolver = useMemo<Resolver<LeadFormValues>>(() => {
    const zod = zodResolver(LeadUpdate) as unknown as Resolver<LeadFormValues>;
    return (values, ctx, opts) => {
      const out: Record<string, unknown> = Object.fromEntries([...DETAIL_FIELDS, 'updatedAt'].map((k) => [k, values[k as keyof LeadFormValues]]));
      out.nextFollowUp = values.nextFollowUp || null;
      return zod(out as unknown as LeadFormValues, ctx, opts);
    };
  }, []);

  const form = useForm<LeadFormValues>({ resolver, defaultValues: formValues(lead) });
  const { register, handleSubmit, reset } = form;
  const f = useLeadFormFields(form, { currentSource: lead.leadSource });

  /** Checks the Experience section; returns the roles to save, or null after showing what is missing. */
  function experienceToSave(): { experience: ReturnType<typeof toExperience>; newPerson: boolean } | null {
    const experience = toExperience(xpRows);
    if (experience === null) {
      setFormError(t('Each role needs a job title, a company and a start'));
      return null;
    }
    const newPerson = lead.contact === null && lead.companyId !== null && (first.trim() !== '' || last.trim() !== '' || experience.length > 0);
    if (newPerson && (!first.trim() || !last.trim())) {
      setFormError(t('Enter the first and last name of the person these roles belong to'));
      return null;
    }
    return { experience, newPerson };
  }

  async function submit(v: LeadFormValues) {
    setFormError(null);
    const xp = experienceToSave();
    if (!xp) return;
    let saved: LeadDetail;
    try {
      // Sends the updatedAt the form was opened (or last reset) with, never the live one.
      saved = await save.mutateAsync({ id: lead.id, body: v as unknown as LeadUpdate });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale') {
        toast(errorText(t, err.code), 'warn');
        void reloadAfterStale(lead.id);
        return;
      }
      setFormError(leadSaveError(err, form, t));
      return;
    }
    try {
      const experience = xp.experience ?? [];
      if (lead.contact && JSON.stringify(experience) !== JSON.stringify(toExperience(startRows))) {
        await saveProfile.mutateAsync({ id: lead.contact.id, updatedAt: lead.contact.updatedAt, profile: { experience } });
      } else if (xp.newPerson && lead.companyId !== null) {
        const person = await saveContact.mutateAsync({
          body: { companyId: lead.companyId, firstName: first.trim(), lastName: last.trim(), contactType: 'Other', isPrimary: false },
        });
        if (experience.length) await saveProfile.mutateAsync({ id: person.id, updatedAt: person.updatedAt, profile: { experience } });
        await linkContact.mutateAsync({ lead: saved, action: 'contact', body: { contactId: person.id } });
      }
      toast(t('Lead updated'));
    } catch (err) {
      // The lead itself is saved; say which part did not go through.
      toast(t('The lead was saved, but the experience was not: {reason}', { reason: errorText(t, err instanceof ApiError ? err.code : 'unknown') }), 'warn');
    }
    onClose();
  }

  /**
   * Someone else saved first: load the lead as it is now and show it in the form (with its new
   * updatedAt), so the user checks the other change before saving again instead of overwriting it.
   */
  async function reloadAfterStale(id: number) {
    try {
      const fresh = await qc.fetchQuery({
        queryKey: keys.lead(id),
        queryFn: () => api<LeadFull>(`/api/leads/${id}`),
        staleTime: 0,
      });
      reset(formValues(fresh));
      setFormError(t('This lead was changed by someone else. The form now shows the latest values; check them and save again.'));
    } catch (e) {
      setFormError(errorText(t, e instanceof ApiError ? e.code : 'unknown'));
    }
  }

  return (
    <Modal
      title={t('Edit lead')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="lead-form" className="btn primary" disabled={busy}>
            {t('Save')}
          </button>
        </>
      }
    >
      <form
        id="lead-form"
        noValidate
        className="grid2 wide-form"
        onSubmit={(e) => {
          setFormError(null);
          void handleSubmit(submit)(e);
        }}
      >
        <FormField id="ld-leadType" label={t('Lead type')} required error={f.err('leadType')}>
          <select id="ld-leadType" className="in" {...f.aria('leadType')} {...register('leadType')}>
            {LEAD_TYPES.map((x) => (
              <option key={x} value={x}>
                {leadTypeText(t, x)}
              </option>
            ))}
          </select>
        </FormField>
        {f.priority()}
        {f.input('companyName', t('Company name'), { required: true, span: true })}
        {f.input('website', t('Website'), { type: 'url', placeholder: 'https://' })}
        {f.input('businessEmail', t('Business email'), { type: 'email' })}
        {f.input('phone', t('Phone number'), { type: 'tel' })}
        {f.country()}
        {f.input('city', t('City'))}
        {f.outreachLanguage()}
        {f.leadSource()}
        {f.input('sourceUrl', t('Source URL'), { type: 'url', placeholder: 'https://' })}
        {f.input('nextFollowUp', t('Next follow-up'), { type: 'date' })}
        {f.notes()}
        <ExperienceEditor
          rows={xpRows}
          onRows={setXpRows}
          name={lead.contact === null ? { first, last, onFirst: setFirst, onLast: setLast } : undefined}
          note={lead.companyId === null ? t('Choose the company for this lead first (the Choose company card on the lead page); then add experience here.') : undefined}
        />
        {formError ? (
          <div className="span2 note warn" role="alert">
            {formError}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
