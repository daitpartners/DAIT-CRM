import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CompanyCreate, CompanyStatus, CompanyUpdate, lookupLabel, type LookupGroup } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { keys, useDuplicateCheck, type CompanyDetail } from '../../api/companies';
import { useLookups } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { COMBO_MIN, Combobox, type ComboOption } from '../../components/Combobox';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { companyStatusText, errorText } from '../../i18n/labels';
import { useLang, useT, type TFn } from '../../i18n/useT';
import { timezoneOptions } from '../settings/timezones';
import { applyServerIssues } from '../../forms/applyServerIssues';
import { DuplicateHint } from './DuplicateHint';

/** Field groups of the company form: A Overview, B Address, C Size & financial, D Products & services, E Digital presence. */
export type CompanySection = 'overview' | 'address' | 'size' | 'products' | 'digital';

type Props = {
  company?: CompanyDetail;
  onClose: () => void;
  /** Editing only: focus (and scroll to) the first field of this group when the form opens. */
  section?: CompanySection;
};

/** The first field of each group; `section` focuses it. */
const SECTION_FIRST: Record<CompanySection, string> = {
  overview: 'co-name',
  address: 'co-country',
  size: 'co-employeeCount',
  products: 'co-mainProducts',
  digital: 'co-socialFacebook',
};

/** Form state: text inputs hold strings ('' = empty); the shared schema trims them and turns '' into null. */
type Values = {
  name: string;
  legalName: string;
  website: string;
  businessEmail: string;
  industry: string;
  businessCategory: string;
  businessType: string;
  yearEstablished: number | null;
  description: string;
  linkedinUrl: string;
  status: CompanyStatus;
  country: string;
  state: string;
  city: string;
  street: string;
  zip: string;
  timezone: string;
  employeeCount: number | null;
  employeeRange: string;
  annualRevenue: number | null;
  revenueCurrency: string;
  revenueRange: string;
  ownershipType: string;
  registrationNumber: string;
  stockExchange: string;
  stockSymbol: string;
  mainProducts: string;
  mainServices: string;
  /** Comma-separated in the form; sent as a list. */
  businessVerticals: string;
  targetMarkets: string;
  geographicMarkets: string;
  keyBrands: string;
  specialisation: string;
  socialFacebook: string;
  socialInstagram: string;
  socialX: string;
  socialYoutube: string;
  socialOther: string;
  /** Editing only, and only for roles that may set the Client flag (view_all_companies). */
  isClient?: boolean;
  updatedAt?: string;
};
type Field = Exclude<keyof Values, 'updatedAt'>;
const FIELDS: Field[] = [
  'name', 'legalName', 'website', 'businessEmail', 'industry', 'businessCategory', 'businessType', 'yearEstablished',
  'description', 'linkedinUrl', 'status', 'country', 'state', 'city', 'street', 'zip', 'timezone',
  'employeeCount', 'employeeRange', 'annualRevenue', 'revenueCurrency', 'revenueRange', 'ownershipType',
  'registrationNumber', 'stockExchange', 'stockSymbol', 'mainProducts', 'mainServices', 'businessVerticals',
  'targetMarkets', 'geographicMarkets', 'keyBrands', 'specialisation', 'socialFacebook', 'socialInstagram',
  'socialX', 'socialYoutube', 'socialOther',
];
type ListField = 'businessVerticals' | 'targetMarkets' | 'geographicMarkets';
const LIST_FIELDS: ListField[] = ['businessVerticals', 'targetMarkets', 'geographicMarkets'];
type LookupField = 'industry' | 'businessCategory' | 'businessType' | 'employeeRange' | 'revenueCurrency' | 'revenueRange' | 'ownershipType';

/** "a, b ,, c" → ['a', 'b', 'c'] */
const splitList = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
const numberOrNull = (v: unknown) => (v === '' || v == null ? null : Number(v));

const text = (v: string | null | undefined) => v ?? '';

function fieldMessage(t: TFn, field: Field): string {
  switch (field) {
    case 'name':
      return t('Enter a company name');
    case 'country':
      return t('Choose a country');
    case 'website':
    case 'linkedinUrl':
    case 'socialFacebook':
    case 'socialInstagram':
    case 'socialX':
    case 'socialYoutube':
    case 'socialOther':
      return t('Enter a valid web address, for example https://example.com');
    case 'employeeCount':
    case 'annualRevenue':
      return t('Enter a number of 0 or more');
    case 'revenueCurrency':
      return t('Choose a currency');
    case 'businessVerticals':
    case 'targetMarkets':
    case 'geographicMarkets':
      return t('Up to 50 entries of 100 characters each, separated by commas');
    case 'businessEmail':
      return t('Enter a valid email address');
    case 'yearEstablished':
      return t('Enter a year from 1800 to this year');
    case 'timezone':
      return t('Choose a time zone');
    default:
      return t('Check this value');
  }
}

/**
 * Add (no `company`) or edit a company's Overview (A) and Address (B) sections.
 * Validation uses the shared CompanyCreate / CompanyUpdate schemas; a live duplicate check runs as the user types.
 */
export function CompanyModal({ company, onClose, section }: Props) {
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: lookups } = useLookups();
  const [formError, setFormError] = useState<string | null>(null);
  const editing = Boolean(company);
  const me = useCurrentUser();
  // The API refuses isClient from other roles, so it is neither shown nor sent for them.
  const canSetClient = editing && me.can('view_all_companies');

  const resolver = useMemo<Resolver<Values>>(() => {
    // The shared schemas also normalise (trim, '' → null, bare host → https://); their types differ from Values.
    const zod = (editing ? zodResolver(CompanyUpdate) : zodResolver(CompanyCreate)) as unknown as Resolver<Values>;
    // Comma-separated list inputs become arrays before validation.
    return (values, ctx, opts) => {
      const out: Record<string, unknown> = { ...values };
      for (const f of LIST_FIELDS) out[f] = splitList(values[f] ?? '');
      return zod(out as unknown as Values, ctx, opts);
    };
  }, [editing]);

  const { register, handleSubmit, control, setError, formState } = useForm<Values>({
    resolver,
    defaultValues: {
      name: text(company?.name),
      legalName: text(company?.legalName),
      website: text(company?.website),
      businessEmail: text(company?.businessEmail),
      industry: text(company?.industry),
      businessCategory: text(company?.businessCategory),
      businessType: text(company?.businessType),
      yearEstablished: company?.yearEstablished ?? null,
      description: text(company?.description),
      linkedinUrl: text(company?.linkedinUrl),
      status: company?.status ?? 'Active',
      country: text(company?.country),
      state: text(company?.state),
      city: text(company?.city),
      street: text(company?.street),
      zip: text(company?.zip),
      timezone: text(company?.timezone),
      employeeCount: company?.employeeCount ?? null,
      employeeRange: text(company?.employeeRange),
      annualRevenue: company?.annualRevenue ?? null,
      revenueCurrency: text(company?.revenueCurrency),
      revenueRange: text(company?.revenueRange),
      ownershipType: text(company?.ownershipType),
      registrationNumber: text(company?.registrationNumber),
      stockExchange: text(company?.stockExchange),
      stockSymbol: text(company?.stockSymbol),
      mainProducts: text(company?.mainProducts),
      mainServices: text(company?.mainServices),
      businessVerticals: (company?.businessVerticals ?? []).join(', '),
      targetMarkets: (company?.targetMarkets ?? []).join(', '),
      geographicMarkets: (company?.geographicMarkets ?? []).join(', '),
      keyBrands: text(company?.keyBrands),
      specialisation: text(company?.specialisation),
      socialFacebook: text(company?.socialFacebook),
      socialInstagram: text(company?.socialInstagram),
      socialX: text(company?.socialX),
      socialYoutube: text(company?.socialYoutube),
      socialOther: text(company?.socialOther),
      ...(company ? { updatedAt: company.updatedAt } : {}),
      ...(company && canSetClient ? { isClient: company.isClient } : {}),
    },
  });
  const { errors } = formState;

  // Runs after the dialog's own initial focus (child effects first), so the chosen group wins.
  useEffect(() => {
    if (!section || !editing) return;
    const el = document.getElementById(SECTION_FIRST[section]);
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus();
  }, [section, editing]);

  const [name, website, businessEmail, legalName, country] = useWatch({
    control,
    name: ['name', 'website', 'businessEmail', 'legalName', 'country'],
  });
  const checkEnabled = Boolean(name.trim() || website.trim() || businessEmail.trim());
  const dup = useDuplicateCheck({ name, website, businessEmail, legalName, country, excludeId: company?.id }, checkEnabled);
  const duplicates = checkEnabled ? dup.data : undefined;
  const blocked = Boolean(duplicates?.auto);

  const save = useMutation({
    mutationFn: (v: Values) =>
      company
        ? api<CompanyDetail>(`/api/companies/${company.id}`, { method: 'PATCH', body: v })
        : api<CompanyDetail>('/api/companies', { method: 'POST', body: v }),
    onSuccess: async (saved) => {
      qc.setQueryData(keys.company(saved.id), saved);
      await qc.invalidateQueries({ queryKey: keys.companiesAll });
      toast(editing ? t('Company updated') : t('{number} created|company', { number: saved.number }));
      onClose();
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : 'unknown';
      // Someone else saved first: refetch so a retry (after reopening) carries the fresh updatedAt.
      if (code === 'stale') {
        void qc.invalidateQueries({ queryKey: keys.companiesAll });
        if (company) void qc.invalidateQueries({ queryKey: keys.company(company.id) });
      }
      if (code === 'domain_taken') {
        setError('website', { type: 'server', message: errorText(t, code) });
        return;
      }
      setFormError(applyServerIssues(err, FIELDS, setError, t, (f) => fieldMessage(t, f)).formMessage);
    },
  });

  const err = (f: Field) => (errors[f] ? (errors[f]?.type === 'server' ? errors[f]?.message : fieldMessage(t, f)) : undefined);
  const input = (f: Field, label: string, opts: { required?: boolean; type?: string; span?: boolean; placeholder?: string; hint?: string } = {}) => (
    <FormField id={`co-${f}`} label={label} required={opts.required} error={err(f)} className={opts.span ? 'span2' : undefined}>
      <input
        id={`co-${f}`}
        type={opts.type ?? 'text'}
        className={errors[f] ? 'in err' : 'in'}
        placeholder={opts.placeholder}
        aria-invalid={Boolean(errors[f])}
        aria-describedby={[errors[f] ? `co-${f}-err` : '', opts.hint ? `co-${f}-hint` : ''].filter(Boolean).join(' ') || undefined}
        {...register(f)}
      />
      {opts.hint ? (
        <div id={`co-${f}-hint`} className="hint-text">
          {opts.hint}
        </div>
      ) : null}
    </FormField>
  );

  /** Lookup options for a group: active values, plus the current value if it has since been retired. */
  const lookupOptions = (group: LookupGroup, current: string): ComboOption[] => {
    const opts = (lookups?.[group] ?? [])
      .filter((x) => x.isActive || x.value === current)
      .map((x) => ({ value: x.value, label: lookupLabel(x, lang) }));
    if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
    return opts;
  };

  /** An optional lookup field: a native select for short lists, otherwise a searchable combobox with a "None" option. */
  const lookupField = (f: LookupField, group: LookupGroup, label: string) => (
    <Controller
      control={control}
      name={f}
      render={({ field }) => {
        const opts = lookupOptions(group, field.value);
        if (opts.length + 1 < COMBO_MIN) {
          return (
            <FormField id={`co-${f}`} label={label} error={err(f)}>
              <select
                id={`co-${f}`}
                className={errors[f] ? 'in err' : 'in'}
                aria-invalid={Boolean(errors[f])}
                aria-describedby={errors[f] ? `co-${f}-err` : undefined}
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
              >
                <option value="">{t('None')}</option>
                {opts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FormField>
          );
        }
        return (
          <div>
            <Combobox id={`co-${f}`} label={label} options={[{ value: '', label: t('None') }, ...opts]} value={field.value ?? ''} onChange={field.onChange} />
            {errors[f] ? <div id={`co-${f}-err`} className="err-msg" role="alert">{err(f)}</div> : null}
          </div>
        );
      }}
    />
  );

  const numberInput = (f: 'employeeCount' | 'annualRevenue', label: string) => (
    <FormField id={`co-${f}`} label={label} error={err(f)}>
      <input
        id={`co-${f}`}
        type="number"
        min={0}
        inputMode="decimal"
        className={errors[f] ? 'in err' : 'in'}
        aria-invalid={Boolean(errors[f])}
        aria-describedby={errors[f] ? `co-${f}-err` : undefined}
        {...register(f, { setValueAs: numberOrNull })}
      />
    </FormField>
  );

  const textArea = (f: 'mainProducts' | 'mainServices' | 'specialisation', label: string) => (
    <FormField id={`co-${f}`} label={label} error={err(f)} className="span2">
      <textarea
        id={`co-${f}`}
        className={errors[f] ? 'in err' : 'in'}
        rows={3}
        aria-invalid={Boolean(errors[f])}
        aria-describedby={errors[f] ? `co-${f}-err` : undefined}
        {...register(f)}
      />
    </FormField>
  );

  const tzOptions = useMemo(() => timezoneOptions(company?.timezone ?? undefined), [company?.timezone]);

  return (
    <Modal
      title={editing ? t('Edit company') : t('Add company')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="submit"
            form="company-form"
            className="btn primary"
            disabled={save.isPending || blocked}
            title={blocked ? t('A company with this website or email domain already exists') : undefined}
          >
            {t('Save')}
          </button>
        </>
      }
    >
      <form id="company-form" noValidate onSubmit={(e) => {
          // A message from an earlier attempt must not outlive the next one.
          setFormError(null);
          void handleSubmit((v) => !blocked && save.mutate(v))(e);
        }} className="grid2 company-form">
        <h3 className="span2 form-sec">{t('Overview')}</h3>
        {input('name', t('Company name'), { required: true, span: true })}
        {duplicates ? (
          <div className="span2">
            <DuplicateHint result={duplicates} />
          </div>
        ) : null}
        {input('legalName', t('Legal name'))}
        {input('website', t('Website'), { type: 'url', placeholder: 'https://' })}
        {input('businessEmail', t('Business email'), { type: 'email' })}
        {input('linkedinUrl', t('LinkedIn URL'), { type: 'url', placeholder: 'https://' })}
        {lookupField('industry', 'industry', t('Industry'))}
        {lookupField('businessCategory', 'business_category', t('Business category'))}
        {lookupField('businessType', 'business_type', t('Business type'))}
        <FormField id="co-yearEstablished" label={t('Year established')} error={err('yearEstablished')}>
          <input
            id="co-yearEstablished"
            type="number"
            inputMode="numeric"
            className={errors.yearEstablished ? 'in err' : 'in'}
            aria-invalid={Boolean(errors.yearEstablished)}
            aria-describedby={errors.yearEstablished ? 'co-yearEstablished-err' : undefined}
            {...register('yearEstablished', { setValueAs: numberOrNull })}
          />
        </FormField>
        <FormField id="co-status" label={t('Status')} required error={err('status')}>
          <select id="co-status" className="in" {...register('status')}>
            {CompanyStatus.options.map((s) => (
              <option key={s} value={s}>
                {companyStatusText(t, s)}
              </option>
            ))}
          </select>
        </FormField>
        {canSetClient ? (
          <div className="span2">
            <label className="check">
              <input type="checkbox" id="co-isClient" {...register('isClient')} />
              {t('Client (an existing customer)')}
            </label>
          </div>
        ) : null}
        <FormField id="co-description" label={t('Description')} error={err('description')} className="span2">
          <textarea id="co-description" className="in" rows={3} {...register('description')} />
        </FormField>

        <h3 className="span2 form-sec">{t('Address')}</h3>
        <div>
          <Controller
            control={control}
            name="country"
            render={({ field }) => (
              <Combobox id="co-country" label={t('Country')} options={lookupOptions('country', field.value)} value={field.value || null} onChange={field.onChange} required />
            )}
          />
          {errors.country ? <div className="err-msg" role="alert">{err('country')}</div> : null}
        </div>
        {input('state', t('State / Province'))}
        {input('city', t('City'))}
        {input('zip', t('ZIP / Postal code'))}
        {input('street', t('Street address'), { span: true })}
        <div className="span2">
          <Controller
            control={control}
            name="timezone"
            render={({ field }) => (
              <Combobox id="co-timezone" label={t('Time zone')} options={[{ value: '', label: t('None') }, ...tzOptions]} value={field.value} onChange={field.onChange} />
            )}
          />
          {errors.timezone ? <div className="err-msg" role="alert">{err('timezone')}</div> : null}
        </div>
        {editing ? (
          <>
            <h3 className="span2 form-sec">{t('Size & financial')}</h3>
            {numberInput('employeeCount', t('Employee count'))}
            {lookupField('employeeRange', 'employee_range', t('Employee range'))}
            {numberInput('annualRevenue', t('Annual revenue'))}
            {lookupField('revenueCurrency', 'currency', t('Revenue currency'))}
            {lookupField('revenueRange', 'revenue_range', t('Revenue range'))}
            {lookupField('ownershipType', 'ownership_type', t('Ownership type'))}
            {input('registrationNumber', t('Registration number'))}
            {input('stockExchange', t('Stock exchange'))}
            {input('stockSymbol', t('Stock symbol'))}

            <h3 className="span2 form-sec">{t('Products & services')}</h3>
            {textArea('mainProducts', t('Main products'))}
            {textArea('mainServices', t('Main services'))}
            {input('businessVerticals', t('Business verticals'), { span: true, hint: t('Separate entries with commas') })}
            {input('targetMarkets', t('Target markets'), { span: true, hint: t('Separate entries with commas') })}
            {input('geographicMarkets', t('Geographic markets'), { span: true, hint: t('Separate entries with commas') })}
            {input('keyBrands', t('Key brands'), { span: true })}
            {textArea('specialisation', t('Specialisation'))}

            <h3 className="span2 form-sec">{t('Digital presence')}</h3>
            {input('socialFacebook', t('Facebook'), { type: 'url', placeholder: 'https://' })}
            {input('socialInstagram', t('Instagram'), { type: 'url', placeholder: 'https://' })}
            {input('socialX', t('X / Twitter'), { type: 'url', placeholder: 'https://' })}
            {input('socialYoutube', t('YouTube'), { type: 'url', placeholder: 'https://' })}
            {input('socialOther', t('Other social profile'), { type: 'url', placeholder: 'https://', span: true })}
          </>
        ) : null}
        {formError ? (
          <div className="span2 note warn" role="alert">
            {formError}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
