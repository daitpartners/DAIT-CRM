import { useId, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { safeUrl } from '@dait-crm/shared';
import { ApiError } from '../../../api/client';
import type { CompanyDetail } from '../../../api/companies';
import { useDeleteLocation, useLocations, type LocationSummary } from '../../../api/locations';
import { keys, useLookupText } from '../../../api/queries';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Icons } from '../../../components/Icons';
import { useToast } from '../../../components/Toast';
import { errorText } from '../../../i18n/labels';
import { useLang, useT } from '../../../i18n/useT';
import { LocationModal } from '../LocationModal';

type Props = { company: CompanyDetail; canManage: boolean };

/** Offices, branches and other sites of the company (Headquarters first), one card per site as in the prototype. */
export function LocationsTab({ company, canManage }: Props) {
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const { data: rows, isPending, error } = useLocations(company.id);
  const qc = useQueryClient();
  const remove = useDeleteLocation(company.id);
  // undefined = closed; null = adding; a location = editing it.
  const [editing, setEditing] = useState<LocationSummary | null | undefined>(undefined);

  async function onDelete(l: LocationSummary) {
    const ok = await confirm({
      title: t('Delete location?'),
      body: t('{name} will be removed from {company}. This cannot be undone.', { name: l.name, company: company.name }),
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!ok) return;
    remove.mutate(l.id, {
      onSuccess: () => toast(t('Location deleted')),
      onError: (err) => {
        toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn');
        // It may already be gone (deleted elsewhere): refetch so the row disappears.
        void qc.invalidateQueries({ queryKey: keys.locations(company.id) });
      },
    });
  }

  return (
    <div className="col-main">
      <div className="sec-title-row">
        <h2 id="locations-title">{t('Office & branch locations')}</h2>
        <span className="head-note muted-text">{t('One record per site')}</span>
        <div className="grow" />
        {canManage ? (
          <button type="button" className="btn sm primary" onClick={() => setEditing(null)}>
            {Icons.plus}
            {t('Add location')}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="card empty" role="alert">
          {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
        </div>
      ) : isPending ? (
        <div className="card empty">{t('Loading…')}</div>
      ) : !rows?.length ? (
        <div className="card empty">{t('No locations recorded')}</div>
      ) : (
        rows.map((l) => (
          <LocationCard
            key={l.id}
            l={l}
            canManage={canManage}
            busy={remove.isPending}
            onEdit={() => setEditing(l)}
            onDelete={() => void onDelete(l)}
          />
        ))
      )}
      {editing !== undefined ? <LocationModal companyId={company.id} location={editing ?? undefined} onClose={() => setEditing(undefined)} /> : null}
    </div>
  );
}

type CardProps = { l: LocationSummary; canManage: boolean; busy: boolean; onEdit: () => void; onDelete: () => void };

/** One site as the prototype's card: name · city, type and verification badges, and two definition lists. */
function LocationCard({ l, canManage, busy, onEdit, onDelete }: CardProps) {
  const t = useT();
  const lang = useLang();
  const lookup = useLookupText(lang);
  const headingId = useId();
  const maps = safeUrl(l.mapsUrl);
  const pair = (label: string, value: ReactNode) => (
    <>
      <dt>{label}</dt>
      {value === null || value === undefined || value === '' ? <dd className="null">—</dd> : <dd>{value}</dd>}
    </>
  );
  return (
    <section className="card loc-card" aria-labelledby={headingId}>
      <div className="card-head">
        <h2 id={headingId}>{l.city ? `${l.name} · ${l.city}` : l.name}</h2>
        <span className={l.locationType === 'Headquarters' ? 'badge b-purple' : 'badge b-grey'}>{lookup('location_type', l.locationType)}</span>
        {l.isVerified ? <span className="badge b-ok">{t('Verified|location')}</span> : <span className="badge b-grey">{t('Not verified|location')}</span>}
        {canManage ? (
          <div className="row-actions">
            <button type="button" className="btn xs" onClick={onEdit} aria-label={t('Edit {name}', { name: l.name })}>
              {t('Edit')}
            </button>
            <button type="button" className="btn xs danger" disabled={busy} onClick={onDelete} aria-label={t('Delete {name}', { name: l.name })}>
              {t('Delete')}
            </button>
          </div>
        ) : null}
      </div>
      <div className="kv-cols">
        <dl className="kv">
          {pair(t('Country'), lookup('country', l.country))}
          {pair(t('State / Province'), l.state)}
          {pair(t('City'), l.city)}
          {pair(t('Street address'), l.street)}
          {pair(t('ZIP / Postal code'), l.zip)}
        </dl>
        <dl className="kv">
          {pair(t('Time zone'), l.timezone)}
          {pair(t('Latitude'), l.lat)}
          {pair(t('Longitude'), l.lng)}
          {pair(
            t('Google Maps'),
            maps ? (
              <a href={maps} target="_blank" rel="noopener noreferrer">
                {(l.mapsUrl ?? '').replace(/^https?:\/\//i, '')}
              </a>
            ) : null,
          )}
          {pair(t('Source'), l.source)}
        </dl>
      </div>
    </section>
  );
}
