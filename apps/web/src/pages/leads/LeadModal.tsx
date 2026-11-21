import { useMemo, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { LEAD_TYPES, LeadUpdate } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { useSaveLead, type LeadDetail, type LeadFull } from '../../api/leads';
import { keys } from '../../api/queries';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText, leadTypeText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { leadSaveError, useLeadFormFields, type LeadFormValues } from './LeadFormFields';

type Props = {
  /** The lead whose details are edited (a new lead is created on the `/leads/new` page). */
  lead: LeadDetail;
  onClose: () => void;
};

/** Fields PATCH /leads/:id accepts (status, assignee, company and contact have their own endpoints). */
const DETAIL_FIELDS = [
  'leadType', 'companyName', 'website', 'businessEmail', 'phone', 'country', 'city', 'leadSource', 'sourceUrl', 'priority',
  'nextFollowUp', 'notes',
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

  function submit(v: LeadFormValues) {
    save.mutate(
      // Sends the updatedAt the form was opened (or last reset) with, never the live one.
      { id: lead.id, body: v as unknown as LeadUpdate },
      {
        onSuccess: () => {
          toast(t('Lead updated'));
          onClose();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'stale') {
            toast(errorText(t, err.code), 'warn');
            void reloadAfterStale(lead.id);
            return;
          }
          setFormError(leadSaveError(err, form, t));
        },
      },
    );
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
          <button type="submit" form="lead-form" className="btn primary" disabled={save.isPending}>
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
        {f.leadSource()}
        {f.input('sourceUrl', t('Source URL'), { type: 'url', placeholder: 'https://' })}
        {f.input('nextFollowUp', t('Next follow-up'), { type: 'date' })}
        {f.notes()}
        {formError ? (
          <div className="span2 note warn" role="alert">
            {formError}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
