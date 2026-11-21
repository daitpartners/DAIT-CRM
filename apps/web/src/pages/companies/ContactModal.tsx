import { useState } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { ContactCreate, ContactUpdate, lookupLabel } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useContactDuplicateCheck, useSaveContact, type ContactSummary } from '../../api/contacts';
import { keys, useLookups } from '../../api/queries';
import { CompanyPicker } from '../../components/CompanyPicker';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useLang, useT, type TFn } from '../../i18n/useT';
import { applyServerIssues } from '../../forms/applyServerIssues';
import { ContactDuplicateHint } from './ContactDuplicateHint';

type Props = {
  /** The company to add to. Leave out (when adding) to choose the company in the form. */
  companyId?: number;
  /** Edit this contact; leave out to add one. */
  contact?: ContactSummary;
  onClose: () => void;
  /** Called with the saved contact before the dialog closes (the lead page links a new contact to its lead). */
  onSaved?: (contact: ContactSummary) => void;
};

/** Form state: text inputs hold strings ('' = empty); the shared schema trims them and turns '' into null. */
type Values = {
  companyId: number | undefined;
  firstName: string;
  lastName: string;
  designation: string;
  department: string;
  businessEmail: string;
  phone: string;
  mobile: string;
  linkedinUrl: string;
  contactType: string;
  isPrimary: boolean;
  updatedAt?: string;
};
type Field = Exclude<keyof Values, 'updatedAt' | 'companyId'>;
const FIELDS: Field[] = [
  'firstName', 'lastName', 'designation', 'department', 'businessEmail', 'phone', 'mobile', 'linkedinUrl', 'contactType', 'isPrimary',
];

function fieldMessage(t: TFn, field: Field): string {
  switch (field) {
    case 'firstName':
      return t('Enter a first name');
    case 'lastName':
      return t('Enter a last name');
    case 'businessEmail':
      return t('Enter a valid email address');
    case 'linkedinUrl':
      return t('Enter a valid web address, for example https://example.com');
    case 'contactType':
      return t('Choose a contact type');
    default:
      return t('Check this value');
  }
}

/** Add or edit a contact (section F), validated with the shared ContactCreate / ContactUpdate schemas. */
export function ContactModal({ companyId, contact, onClose, onSaved }: Props) {
  const t = useT();
  const lang = useLang();
  const toast = useToast();
  const { data: lookups } = useLookups();
  const save = useSaveContact();
  const [formError, setFormError] = useState<string | null>(null);
  const editing = Boolean(contact);
  const qc = useQueryClient();
  // A fixed company (profile tab, or editing) hides the company picker.
  const fixedCompanyId = contact?.companyId ?? companyId;

  const { register, handleSubmit, control, setError, setValue, formState } = useForm<Values>({
    // ContactUpdate strips companyId; both schemas normalise blanks to null.
    resolver: (editing ? zodResolver(ContactUpdate) : zodResolver(ContactCreate)) as unknown as Resolver<Values>,
    defaultValues: {
      companyId: fixedCompanyId,
      firstName: contact?.firstName ?? '',
      lastName: contact?.lastName ?? '',
      designation: contact?.designation ?? '',
      department: contact?.department ?? '',
      businessEmail: contact?.businessEmail ?? '',
      phone: contact?.phone ?? '',
      mobile: contact?.mobile ?? '',
      linkedinUrl: contact?.linkedinUrl ?? '',
      contactType: contact?.contactType ?? 'Other',
      isPrimary: contact?.isPrimary ?? false,
      ...(contact ? { updatedAt: contact.updatedAt } : {}),
    },
  });
  const { errors } = formState;

  const [businessEmail, phone, mobile, firstName, lastName, chosenCompanyId] = useWatch({
    control,
    name: ['businessEmail', 'phone', 'mobile', 'firstName', 'lastName', 'companyId'],
  });
  const checkEnabled = Boolean(businessEmail.trim() || phone.trim() || mobile.trim() || (firstName.trim() && lastName.trim()));
  const dup = useContactDuplicateCheck(
    { businessEmail, phone, mobile, firstName, lastName, companyId: chosenCompanyId, excludeId: contact?.id },
    checkEnabled,
  );
  const duplicates = checkEnabled ? dup.data : undefined;
  const blocked = Boolean(duplicates?.auto);

  function submit(v: Values) {
    if (blocked) return;
    save.mutate(
      { id: contact?.id, body: v as unknown as ContactCreate },
      {
        onSuccess: (saved) => {
          toast(editing ? t('Contact updated') : t('{name} added', { name: `${saved.firstName} ${saved.lastName}` }));
          onSaved?.(saved);
          onClose();
        },
        onError: (err) => {
          const code = err instanceof ApiError ? err.code : 'unknown';
          // Someone else saved first: refetch so a retry (after reopening) carries the fresh updatedAt.
          if (code === 'stale') {
            void qc.invalidateQueries({ queryKey: keys.contactsAll });
            void qc.invalidateQueries({ queryKey: keys.companiesAll });
          }
          if (err instanceof ApiError && err.issues?.length) {
            if (err.issues.some((i) => i.path[0] === 'companyId')) setError('companyId', { type: 'server' });
          }
          setFormError(applyServerIssues(err, FIELDS, setError, t, (f) => fieldMessage(t, f)).formMessage);
        },
      },
    );
  }

  const err = (f: Field) => (errors[f] ? (errors[f]?.type === 'server' ? errors[f]?.message : fieldMessage(t, f)) : undefined);
  const input = (f: Exclude<Field, 'isPrimary' | 'contactType'>, label: string, opts: { required?: boolean; type?: string; span?: boolean; placeholder?: string } = {}) => (
    <FormField id={`ct-${f}`} label={label} required={opts.required} error={err(f)} className={opts.span ? 'span2' : undefined}>
      <input
        id={`ct-${f}`}
        type={opts.type ?? 'text'}
        className={errors[f] ? 'in err' : 'in'}
        placeholder={opts.placeholder}
        aria-invalid={Boolean(errors[f])}
        aria-describedby={errors[f] ? `ct-${f}-err` : undefined}
        {...register(f)}
      />
    </FormField>
  );

  const current = contact?.contactType ?? 'Other';
  const typeOptions = (lookups?.contact_type ?? [])
    .filter((x) => x.isActive || x.value === current)
    .map((x) => ({ value: x.value, label: lookupLabel(x, lang) }));
  if (!typeOptions.some((o) => o.value === current)) typeOptions.push({ value: current, label: current });

  // The primary contact can only change by promoting another contact.
  const primaryLocked = Boolean(contact?.isPrimary);

  return (
    <Modal
      title={editing ? t('Edit contact') : t('Add contact')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="submit"
            form="contact-form"
            className="btn primary"
            disabled={save.isPending || blocked}
            title={blocked ? t('A contact with this email address already exists') : undefined}
          >
            {t('Save')}
          </button>
        </>
      }
    >
      <form
        id="contact-form"
        noValidate
        className="grid2"
        onSubmit={(e) => {
          setFormError(null);
          void handleSubmit(submit)(e);
        }}
      >
        {fixedCompanyId === undefined ? (
          <CompanyPicker
            id="ct-companyId"
            label={t('Company')}
            required
            className="span2"
            value={chosenCompanyId}
            invalid={Boolean(errors.companyId)}
            errorText={t('Choose a company')}
            onChange={(id) => setValue('companyId', id, { shouldValidate: formState.isSubmitted })}
          />
        ) : null}
        {input('firstName', t('First name'), { required: true })}
        {input('lastName', t('Last name'), { required: true })}
        {input('designation', t('Designation'))}
        {input('department', t('Department'))}
        {input('businessEmail', t('Business email'), { type: 'email', span: true })}
        {input('phone', t('Phone number'), { type: 'tel' })}
        {input('mobile', t('Mobile number'), { type: 'tel' })}
        {input('linkedinUrl', t('LinkedIn profile'), { type: 'url', placeholder: 'https://', span: true })}
        {duplicates ? (
          <div className="span2">
            <ContactDuplicateHint result={duplicates} />
          </div>
        ) : null}
        <FormField id="ct-contactType" label={t('Contact type')} required error={err('contactType')}>
          <select
            id="ct-contactType"
            className={errors.contactType ? 'in err' : 'in'}
            aria-invalid={Boolean(errors.contactType)}
            aria-describedby={errors.contactType ? 'ct-contactType-err' : undefined}
            {...register('contactType')}
          >
            {typeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FormField>
        <div>
          <span className="lbl" aria-hidden="true">
            &nbsp;
          </span>
          <label className="check" title={primaryLocked ? t('Make another contact primary to change this') : undefined}>
            <input type="checkbox" disabled={primaryLocked} {...register('isPrimary')} />
            {t('Primary contact')}
          </label>
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
