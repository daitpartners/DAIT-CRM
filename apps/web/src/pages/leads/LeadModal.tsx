import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LEAD_TYPES, LeadCreate, LeadUpdate, PRIORITIES, lookupLabel, type LeadType, type Priority } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useDuplicateCheck, type DuplicateCandidate, type DuplicateResult } from '../../api/companies';
import { contactName, useContacts } from '../../api/contacts';
import { useSaveLead, type LeadDetail } from '../../api/leads';
import { useLookups, useUsers } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Combobox, type ComboOption } from '../../components/Combobox';
import { CompanyPicker } from '../../components/CompanyPicker';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { applyServerIssues } from '../../forms/applyServerIssues';
import { errorText, leadStatusText, leadTypeText, priorityText } from '../../i18n/labels';
import { useLang, useT, type TFn } from '../../i18n/useT';

type Props = {
  /** Edit this lead's details; leave out to create one. */
  lead?: LeadDetail;
  /** New lead only: start linked to this company (the company profile's Leads tab). */
  company?: { id: number; name: string; country: string };
  onClose: () => void;
};

/** Form state: inputs hold strings ('' = empty); the shared schema trims them and turns '' into null. */
type Values = {
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
type Field = Exclude<keyof Values, 'updatedAt'>;
const FIELDS: Field[] = [
  'leadType', 'companyName', 'website', 'businessEmail', 'phone', 'country', 'city', 'leadSource', 'sourceUrl', 'priority',
  'nextFollowUp', 'notes', 'status', 'linkCompanyId', 'contactId', 'assignedToId',
];
/** Fields PATCH /leads/:id accepts (status, assignee, company and contact have their own endpoints). */
const DETAIL_FIELDS = [
  'leadType', 'companyName', 'website', 'businessEmail', 'phone', 'country', 'city', 'leadSource', 'sourceUrl', 'priority',
  'nextFollowUp', 'notes',
] as const;

function fieldMessage(t: TFn, field: Field): string {
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

const text = (v: string | null | undefined) => v ?? '';

/** Create (no `lead`) or edit a lead (spec §4.2), validated with the shared LeadCreate / LeadUpdate schemas. */
export function LeadModal({ lead, company, onClose }: Props) {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const toast = useToast();
  const { data: lookups } = useLookups();
  const { data: users } = useUsers();
  const save = useSaveLead();
  const [formError, setFormError] = useState<string | null>(null);
  // The linked company's label, for a link made from the duplicate hint (the picker's search may not return it).
  const [linked, setLinked] = useState<ComboOption | null>(company ? { value: String(company.id), label: company.name } : null);
  const editing = Boolean(lead);

  const sources = (lookups?.lead_source ?? []).filter((x) => x.isActive || x.value === lead?.leadSource);
  const defaultSource = sources.find((x) => x.value === 'Manual Entry')?.value ?? sources[0]?.value ?? '';

  const resolver = useMemo<Resolver<Values>>(() => {
    const zod = (editing ? zodResolver(LeadUpdate) : zodResolver(LeadCreate)) as unknown as Resolver<Values>;
    // Select values are strings in the form: ids become numbers, '' leaves the field out.
    return (values, ctx, opts) => {
      const out: Record<string, unknown> = editing
        ? Object.fromEntries([...DETAIL_FIELDS, 'updatedAt'].map((k) => [k, values[k as keyof Values]]))
        : {
            ...values,
            contactId: values.contactId ? Number(values.contactId) : undefined,
            assignedToId: values.assignedToId ? Number(values.assignedToId) : undefined,
          };
      out.nextFollowUp = values.nextFollowUp || null;
      return zod(out as unknown as Values, ctx, opts);
    };
  }, [editing]);

  const { register, handleSubmit, control, setError, setValue, getValues, formState } = useForm<Values>({
    resolver,
    defaultValues: {
      leadType: lead?.leadType ?? 'Lead',
      companyName: lead ? lead.companyName : (company?.name ?? ''),
      website: text(lead?.website),
      businessEmail: text(lead?.businessEmail),
      phone: text(lead?.phone),
      country: lead ? lead.country : (company?.country ?? ''),
      city: text(lead?.city),
      leadSource: lead?.leadSource ?? defaultSource,
      sourceUrl: text(lead?.sourceUrl),
      priority: lead?.priority ?? 'Medium',
      nextFollowUp: text(lead?.nextFollowUp),
      notes: text(lead?.notes),
      status: lead?.status ?? 'New',
      linkCompanyId: company?.id,
      contactId: '',
      assignedToId: '',
      ...(lead ? { updatedAt: lead.updatedAt } : {}),
    },
  });
  const { errors } = formState;

  // Lookups may arrive after the form opened: pick the default source then.
  useEffect(() => {
    if (!editing && defaultSource && !getValues('leadSource')) setValue('leadSource', defaultSource);
  }, [defaultSource, editing]);

  const [companyName, website, businessEmail, country, linkCompanyId] = useWatch({
    control,
    name: ['companyName', 'website', 'businessEmail', 'country', 'linkCompanyId'],
  });
  const checkEnabled = !editing && linkCompanyId === undefined && Boolean(companyName.trim() || website.trim() || businessEmail.trim());
  const dup = useDuplicateCheck({ name: companyName, website, businessEmail, country }, checkEnabled, 'leads');
  const duplicates = checkEnabled ? dup.data : undefined;

  const contacts = useContacts({ companyId: linkCompanyId, page: 1, pageSize: 100, sort: 'lastName' }, linkCompanyId !== undefined);

  function link(c: DuplicateCandidate) {
    setLinked({ value: String(c.id), label: c.name });
    setValue('linkCompanyId', c.id);
    setValue('contactId', '');
  }

  function submit(v: Values) {
    save.mutate(
      // Editing: the lead prop is refetched after a stale refusal, so a retry carries its fresh updatedAt.
      { id: lead?.id, body: (lead ? { ...v, updatedAt: lead.updatedAt } : v) as unknown as LeadCreate },
      {
        onSuccess: (saved) => {
          toast(editing ? t('Lead updated') : t('{number} created|lead', { number: saved.number }));
          onClose();
        },
        onError: (err) => {
          const code = err instanceof ApiError ? err.code : 'unknown';
          // Someone else saved first: useSaveLead refetches leads and tasks so a retry carries the fresh updatedAt.
          if (code === 'stale') toast(errorText(t, code), 'warn');
          if (code === 'domain_taken') {
            setError('website', { type: 'server', message: errorText(t, code) });
            return;
          }
          if (code === 'cannot_assign_hidden') {
            setError('assignedToId', { type: 'server', message: errorText(t, code) });
            return;
          }
          setFormError(applyServerIssues(err, FIELDS, setError, t, (f) => fieldMessage(t, f)).formMessage);
        },
      },
    );
  }

  const err = (f: Field) => (errors[f] ? (errors[f]?.type === 'server' ? errors[f]?.message : fieldMessage(t, f)) : undefined);
  const aria = (f: Field) => ({ 'aria-invalid': Boolean(errors[f]), 'aria-describedby': errors[f] ? `ld-${f}-err` : undefined });
  const input = (
    f: 'companyName' | 'website' | 'businessEmail' | 'phone' | 'city' | 'sourceUrl' | 'nextFollowUp',
    label: string,
    opts: { required?: boolean; type?: string; span?: boolean; placeholder?: string } = {},
  ) => (
    <FormField id={`ld-${f}`} label={label} required={opts.required} error={err(f)} className={opts.span ? 'span2' : undefined}>
      <input
        id={`ld-${f}`}
        type={opts.type ?? 'text'}
        className={errors[f] ? 'in err' : 'in'}
        placeholder={opts.placeholder}
        {...aria(f)}
        {...register(f)}
      />
    </FormField>
  );

  /** Active lookup values of a group, plus the current value if it has since been retired. */
  const lookupOptions = (group: 'country' | 'lead_source', current: string): ComboOption[] => {
    const opts = (lookups?.[group] ?? [])
      .filter((x) => x.isActive || x.value === current)
      .map((x) => ({ value: x.value, label: lookupLabel(x, lang) }));
    if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
    return opts;
  };

  // Mirrors the API: Administrator / Manager may assign anyone active; everyone else only themselves.
  const assignees = me.can('view_all_leads')
    ? (users ?? []).filter((u) => u.isActive && u.id !== me.id).sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <Modal
      title={editing ? t('Edit lead') : t('New lead')}
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
        <FormField id="ld-leadType" label={t('Lead type')} required error={err('leadType')}>
          <select id="ld-leadType" className="in" {...aria('leadType')} {...register('leadType')}>
            {LEAD_TYPES.map((x) => (
              <option key={x} value={x}>
                {leadTypeText(t, x)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="ld-priority" label={t('Priority')} required error={err('priority')}>
          <select id="ld-priority" className="in" {...aria('priority')} {...register('priority')}>
            {PRIORITIES.map((x) => (
              <option key={x} value={x}>
                {priorityText(t, x)}
              </option>
            ))}
          </select>
        </FormField>
        {input('companyName', t('Company name'), { required: true, span: true })}
        {duplicates ? (
          <div className="span2">
            <LeadDuplicateHint result={duplicates} onLink={link} />
          </div>
        ) : null}
        {!editing ? (
          <>
            <div>
              <CompanyPicker
                id="ld-linkCompanyId"
                label={t('Link to existing company')}
                value={linkCompanyId}
                selected={linked}
                onChange={(id) => {
                  setValue('linkCompanyId', id);
                  setValue('contactId', '');
                }}
              />
              {linkCompanyId !== undefined ? (
                <button
                  type="button"
                  className="btn sm link-clear"
                  onClick={() => {
                    setLinked(null);
                    setValue('linkCompanyId', undefined);
                    setValue('contactId', '');
                  }}
                >
                  {t('Unlink company')}
                </button>
              ) : null}
            </div>
            <FormField id="ld-contactId" label={t('Contact person')} error={err('contactId')}>
              <select id="ld-contactId" className="in" disabled={linkCompanyId === undefined} {...aria('contactId')} {...register('contactId')}>
                <option value="">{linkCompanyId === undefined ? t('Link a company first') : t('Primary contact')}</option>
                {(contacts.data?.items ?? []).map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {contactName(c)}
                  </option>
                ))}
              </select>
            </FormField>
          </>
        ) : null}
        {input('website', t('Website'), { type: 'url', placeholder: 'https://' })}
        {input('businessEmail', t('Business email'), { type: 'email' })}
        {input('phone', t('Phone number'), { type: 'tel' })}
        <div>
          <Controller
            control={control}
            name="country"
            render={({ field }) => (
              <Combobox
                id="ld-country"
                label={t('Country')}
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
        {input('city', t('City'))}
        <FormField id="ld-leadSource" label={t('Lead source')} required error={err('leadSource')}>
          <select id="ld-leadSource" className={errors.leadSource ? 'in err' : 'in'} {...aria('leadSource')} {...register('leadSource')}>
            {lookupOptions('lead_source', lead?.leadSource ?? '').map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FormField>
        {input('sourceUrl', t('Source URL'), { type: 'url', placeholder: 'https://' })}
        {!editing ? (
          <>
            <FormField id="ld-assignedToId" label={t('Assigned to')} error={err('assignedToId')}>
              <select id="ld-assignedToId" className={errors.assignedToId ? 'in err' : 'in'} {...aria('assignedToId')} {...register('assignedToId')}>
                <option value="">{t('Unassigned')}</option>
                <option value={String(me.id)}>{t('Me')}</option>
                {assignees.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField id="ld-status" label={t('Status')}>
              {/* A new lead always starts as New; status changes happen on the lead page. */}
              <select id="ld-status" className="in" disabled {...register('status')}>
                <option value="New">{leadStatusText(t, 'New')}</option>
              </select>
            </FormField>
          </>
        ) : null}
        {input('nextFollowUp', t('Next follow-up'), { type: 'date' })}
        <FormField id="ld-notes" label={t('Notes')} error={err('notes')} className="span2">
          <textarea id="ld-notes" className="in" rows={3} {...aria('notes')} {...register('notes')} />
        </FormField>
        {formError ? (
          <div className="span2 note warn" role="alert">
            {formError}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

/** Candidates the user may open carry their details; a hidden company is reported by number and name only. */
const canOpen = (c: DuplicateCandidate) => 'country' in c;

/**
 * Company match under the lead's company name. Unlike the company form nothing blocks: a company
 * may have many leads. An automatic match (same website or email domain) is offered as a link;
 * review matches are listed with a Link button each.
 */
export function LeadDuplicateHint({ result, onLink }: { result: DuplicateResult; onLink: (c: DuplicateCandidate) => void }) {
  const t = useT();
  const label = (c: DuplicateCandidate) => `${c.number} ${c.name}`;
  if (result.auto) {
    const c = result.auto;
    return (
      <div className="note info" role="status">
        {t('This company exists: {company}', { company: label(c) })}{' '}
        {canOpen(c) ? (
          <button type="button" className="btn sm" onClick={() => onLink(c)}>
            {t('Link to {number}', { number: c.number })}
          </button>
        ) : (
          t('The lead will be linked to it.')
        )}
      </div>
    );
  }
  if (result.review.length === 0) return null;
  return (
    <div className="note warn" role="status">
      <strong>{t('Possible duplicates')}</strong>
      <ul className="dup-list">
        {result.review.map(({ candidate, how }) => (
          <li key={candidate.id}>
            {label(candidate)}
            {' · '}
            {how === 'legal_name' ? t('same legal name') : how === 'name_country' ? t('same name and country') : t('same website domain')}
            {canOpen(candidate) ? (
              <>
                {' '}
                <button type="button" className="btn xs" onClick={() => onLink(candidate)}>
                  {t('Link')}
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
