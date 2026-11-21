import { useMemo, useState } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { LocationCreate, LocationUpdate, lookupLabel, type LookupGroup } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useSaveLocation, type LocationSummary } from '../../api/locations';
import { keys, useLookups } from '../../api/queries';
import { Combobox, type ComboOption } from '../../components/Combobox';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useLang, useT, type TFn } from '../../i18n/useT';
import { applyServerIssues } from '../../forms/applyServerIssues';
import { timezoneOptions } from '../settings/timezones';

type Props = { companyId: number; location?: LocationSummary; onClose: () => void };

type Values = {
  name: string;
  locationType: string;
  country: string;
  state: string;
  city: string;
  street: string;
  zip: string;
  timezone: string;
  lat: number | null;
  lng: number | null;
  mapsUrl: string;
  phone: string;
  isVerified: boolean;
  source: string;
  updatedAt?: string;
};
type Field = Exclude<keyof Values, 'updatedAt'>;
const FIELDS: Field[] = ['name', 'locationType', 'country', 'state', 'city', 'street', 'zip', 'timezone', 'lat', 'lng', 'mapsUrl', 'phone', 'isVerified', 'source'];

const numberOrNull = (v: unknown) => (v === '' || v == null ? null : Number(v));

function fieldMessage(t: TFn, field: Field): string {
  switch (field) {
    case 'name':
      return t('Enter a location name');
    case 'locationType':
      return t('Choose a location type');
    case 'country':
      return t('Choose a country');
    case 'timezone':
      return t('Choose a time zone');
    case 'lat':
      return t('Enter a latitude from -90 to 90');
    case 'lng':
      return t('Enter a longitude from -180 to 180');
    case 'mapsUrl':
      return t('Enter a valid web address, for example https://example.com');
    case 'source':
      return t('Enter a source');
    default:
      return t('Check this value');
  }
}

/** Add or edit one of a company's office, branch or other sites. */
export function LocationModal({ companyId, location, onClose }: Props) {
  const t = useT();
  const lang = useLang();
  const toast = useToast();
  const { data: lookups } = useLookups();
  const qc = useQueryClient();
  const save = useSaveLocation(companyId);
  const [formError, setFormError] = useState<string | null>(null);
  const editing = Boolean(location);

  const { register, handleSubmit, control, setError, formState } = useForm<Values>({
    resolver: (editing ? zodResolver(LocationUpdate) : zodResolver(LocationCreate)) as unknown as Resolver<Values>,
    defaultValues: {
      name: location?.name ?? '',
      locationType: location?.locationType ?? '',
      country: location?.country ?? '',
      state: location?.state ?? '',
      city: location?.city ?? '',
      street: location?.street ?? '',
      zip: location?.zip ?? '',
      timezone: location?.timezone ?? '',
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      mapsUrl: location?.mapsUrl ?? '',
      phone: location?.phone ?? '',
      isVerified: location?.isVerified ?? false,
      source: location?.source ?? 'Manual',
      ...(location ? { updatedAt: location.updatedAt } : {}),
    },
  });
  const { errors } = formState;

  function submit(v: Values) {
    save.mutate(
      { id: location?.id, body: v as unknown as LocationCreate },
      {
        onSuccess: (saved) => {
          toast(editing ? t('Location updated') : t('{name} added', { name: saved.name }));
          onClose();
        },
        onError: (err) => {
          const code = err instanceof ApiError ? err.code : 'unknown';
          // Someone else saved or deleted it first: refetch so the list and a retry are current.
          if (code === 'stale') void qc.invalidateQueries({ queryKey: keys.locations(companyId) });
          setFormError(applyServerIssues(err, FIELDS, setError, t, (f) => fieldMessage(t, f)).formMessage);
        },
      },
    );
  }

  const err = (f: Field) => (errors[f] ? (errors[f]?.type === 'server' ? errors[f]?.message : fieldMessage(t, f)) : undefined);
  const describe = (f: Field) => (errors[f] ? `loc-${f}-err` : undefined);
  const input = (f: 'name' | 'state' | 'city' | 'street' | 'zip' | 'mapsUrl' | 'phone' | 'source', label: string, opts: { required?: boolean; type?: string; span?: boolean; placeholder?: string } = {}) => (
    <FormField id={`loc-${f}`} label={label} required={opts.required} error={err(f)} className={opts.span ? 'span2' : undefined}>
      <input
        id={`loc-${f}`}
        type={opts.type ?? 'text'}
        className={errors[f] ? 'in err' : 'in'}
        placeholder={opts.placeholder}
        aria-invalid={Boolean(errors[f])}
        aria-describedby={describe(f)}
        {...register(f)}
      />
    </FormField>
  );
  const coord = (f: 'lat' | 'lng', label: string) => (
    <FormField id={`loc-${f}`} label={label} error={err(f)}>
      <input
        id={`loc-${f}`}
        type="number"
        step="any"
        inputMode="decimal"
        className={errors[f] ? 'in err' : 'in'}
        aria-invalid={Boolean(errors[f])}
        aria-describedby={describe(f)}
        {...register(f, { setValueAs: numberOrNull })}
      />
    </FormField>
  );

  const lookupOptions = (group: LookupGroup, current: string): ComboOption[] => {
    const opts = (lookups?.[group] ?? [])
      .filter((x) => x.isActive || x.value === current)
      .map((x) => ({ value: x.value, label: lookupLabel(x, lang) }));
    if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
    return opts;
  };
  const tzOptions = useMemo(() => timezoneOptions(location?.timezone ?? undefined), [location?.timezone]);

  return (
    <Modal
      title={editing ? t('Edit location') : t('Add location')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="location-form" className="btn primary" disabled={save.isPending}>
            {t('Save')}
          </button>
        </>
      }
    >
      <form
        id="location-form"
        noValidate
        className="grid2"
        onSubmit={(e) => {
          setFormError(null);
          void handleSubmit(submit)(e);
        }}
      >
        {input('name', t('Name'), { required: true })}
        <Controller
          control={control}
          name="locationType"
          render={({ field }) => (
            <FormField id="loc-locationType" label={t('Location type')} required error={err('locationType')}>
              <select
                id="loc-locationType"
                className={errors.locationType ? 'in err' : 'in'}
                aria-invalid={Boolean(errors.locationType)}
                aria-describedby={describe('locationType')}
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
              >
                {field.value === '' ? <option value="">{t('Choose…')}</option> : null}
                {lookupOptions('location_type', field.value).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FormField>
          )}
        />
        <div>
          <Controller
            control={control}
            name="country"
            render={({ field }) => (
              <Combobox id="loc-country" label={t('Country')} options={lookupOptions('country', field.value)} value={field.value || null} onChange={field.onChange} required />
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
              <Combobox id="loc-timezone" label={t('Time zone')} options={[{ value: '', label: t('None') }, ...tzOptions]} value={field.value} onChange={field.onChange} />
            )}
          />
          {errors.timezone ? <div className="err-msg" role="alert">{err('timezone')}</div> : null}
        </div>
        {coord('lat', t('Latitude'))}
        {coord('lng', t('Longitude'))}
        {input('mapsUrl', t('Google Maps link'), { type: 'url', placeholder: 'https://', span: true })}
        {input('phone', t('Phone number'), { type: 'tel' })}
        {input('source', t('Source'), { required: true })}
        <label className="check span2">
          <input type="checkbox" {...register('isVerified')} />
          {t('Address verified')}
        </label>
        {formError ? (
          <div className="span2 note warn" role="alert">
            {formError}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
