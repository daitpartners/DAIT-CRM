import { Controller, type UseFormReturn } from 'react-hook-form';
import { PRIORITIES, lookupLabel, type LeadType, type Priority } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useLookups } from '../../api/queries';
import { Combobox, type ComboOption } from '../../components/Combobox';
import { FormField } from '../../components/FormField';
import { applyServerIssues } from '../../forms/applyServerIssues';
import { errorText, priorityText } from '../../i18n/labels';
import { useLang, useT, type TFn } from '../../i18n/useT';

/**
 * Lead form state shared by the New lead page and the Edit lead dialog: inputs hold strings
 * ('' = empty); the shared LeadCreate / LeadUpdate schemas trim them and turn '' into null.
 */
export type LeadFormValues = {
  leadType: LeadType;
  companyName: string;
  website: string;
  businessEmail: string;
  phone: string;
  country: string;
  city: string;
  leadSource: string;
  sourceUrl: string;
  priority: Priority;
  nextFollowUp: string;
  notes: string;
  /** Create only. */
  status: string;
  linkCompanyId: number | undefined;
  /** '' = the company's primary contact. */
  contactId: string;
  /** '' = unassigned (allocation rules may assign by country). */
  assignedToId: string;
  updatedAt?: string;
};
export type LeadField = Exclude<keyof LeadFormValues, 'updatedAt'>;
export const LEAD_FIELDS: LeadField[] = [
  'leadType', 'companyName', 'website', 'businessEmail', 'phone', 'country', 'city', 'leadSource', 'sourceUrl', 'priority',
  'nextFollowUp', 'notes', 'status', 'linkCompanyId', 'contactId', 'assignedToId',
];

export function leadFieldMessage(t: TFn, field: LeadField): string {
  switch (field) {
    case 'companyName':
      return t('Enter a company name');
    case 'country':
      return t('Choose a country');
    case 'leadSource':
      return t('Choose a lead source');
    case 'website':
    case 'sourceUrl':
      return t('Enter a valid web address, for example https://example.com');
    case 'businessEmail':
      return t('Enter a valid email address');
    case 'nextFollowUp':
      return t('Enter a valid date');
    default:
      return t('Check this value');
  }
}

/**
 * Marks the form after a failed save: `domain_taken` on the website, `cannot_assign_hidden` on the
 * assignee, validation issues on their fields. Returns the message for the form-level note.
 */
export function leadSaveError(err: unknown, form: UseFormReturn<LeadFormValues>, t: TFn): string | null {
  const code = err instanceof ApiError ? err.code : 'unknown';
  if (code === 'domain_taken') {
    form.setError('website', { type: 'server', message: errorText(t, code) });
    return null;
  }
  if (code === 'cannot_assign_hidden') {
    form.setError('assignedToId', { type: 'server', message: errorText(t, code) });
    return null;
  }
  return applyServerIssues(err, LEAD_FIELDS, form.setError, t, (f) => leadFieldMessage(t, f)).formMessage;
}

type TextField = 'companyName' | 'website' | 'businessEmail' | 'phone' | 'city' | 'sourceUrl' | 'nextFollowUp';

/**
 * The lead form's shared field block: renderers for the inputs both the New lead page and the
 * Edit lead dialog show (ids `ld-<field>`, errors wired to `ld-<field>-err`). Each screen lays
 * them out in its own cards or grid.
 */
export function useLeadFormFields(form: UseFormReturn<LeadFormValues>, opts: { currentSource?: string } = {}) {
  const t = useT();
  const lang = useLang();
  const { data: lookups } = useLookups();
  const { register, control, formState } = form;
  const { errors } = formState;

  const err = (f: LeadField) =>
    errors[f] ? (errors[f]?.type === 'server' ? errors[f]?.message : leadFieldMessage(t, f)) : undefined;
  const aria = (f: LeadField) => ({ 'aria-invalid': Boolean(errors[f]), 'aria-describedby': errors[f] ? `ld-${f}-err` : undefined });

  /** Active lookup values of a group, plus the current value if it has since been retired. */
  const lookupOptions = (group: 'country' | 'lead_source', current: string): ComboOption[] => {
    const list = (lookups?.[group] ?? [])
      .filter((x) => x.isActive || x.value === current)
      .map((x) => ({ value: x.value, label: lookupLabel(x, lang) }));
    if (current && !list.some((o) => o.value === current)) list.push({ value: current, label: current });
    return list;
  };

  const input = (
    f: TextField,
    label: string,
    o: { required?: boolean; type?: string; span?: boolean; placeholder?: string } = {},
  ) => (
    <FormField id={`ld-${f}`} label={label} required={o.required} error={err(f)} className={o.span ? 'span2' : undefined}>
      <input
        id={`ld-${f}`}
        type={o.type ?? 'text'}
        className={errors[f] ? 'in err' : 'in'}
        placeholder={o.placeholder}
        {...aria(f)}
        {...register(f)}
      />
    </FormField>
  );

  const country = (label = t('Country')) => (
    <div>
      <Controller
        control={control}
        name="country"
        render={({ field }) => (
          <Combobox
            id="ld-country"
            label={label}
            required
            options={lookupOptions('country', field.value)}
            value={field.value || null}
            onChange={field.onChange}
            errorId={errors.country ? 'ld-country-err' : undefined}
          />
        )}
      />
      {errors.country ? (
        <div id="ld-country-err" className="err-msg" role="alert">
          {err('country')}
        </div>
      ) : null}
    </div>
  );

  const leadSource = (label = t('Lead source')) => (
    <FormField id="ld-leadSource" label={label} required error={err('leadSource')}>
      <select id="ld-leadSource" className={errors.leadSource ? 'in err' : 'in'} {...aria('leadSource')} {...register('leadSource')}>
        {lookupOptions('lead_source', opts.currentSource ?? '').map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FormField>
  );

  const priority = (label = t('Priority'), required = true) => (
    <FormField id="ld-priority" label={label} required={required} error={err('priority')}>
      <select id="ld-priority" className="in" {...aria('priority')} {...register('priority')}>
        {PRIORITIES.map((x) => (
          <option key={x} value={x}>
            {priorityText(t, x)}
          </option>
        ))}
      </select>
    </FormField>
  );

  const notes = (label = t('Notes'), rows = 3) => (
    <FormField id="ld-notes" label={label} error={err('notes')} className="span2">
      <textarea id="ld-notes" className="in" rows={rows} {...aria('notes')} {...register('notes')} />
    </FormField>
  );

  return { err, aria, input, country, leadSource, priority, notes };
}
