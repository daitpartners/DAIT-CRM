import { useState } from 'react';
import { safeUrl } from '@dait-crm/shared';
import { ApiError } from '../../../api/client';
import type { CompanyDetail } from '../../../api/companies';
import { useDeleteLocation, useLocations, type LocationSummary } from '../../../api/locations';
import { useLookupText } from '../../../api/queries';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Icons } from '../../../components/Icons';
import { Table } from '../../../components/Table';
import { useToast } from '../../../components/Toast';
import { errorText } from '../../../i18n/labels';
import { useLang, useT } from '../../../i18n/useT';
import { LocationModal } from '../LocationModal';

type Props = { company: CompanyDetail; canManage: boolean };

/** Offices, branches and other sites of the company (Headquarters first). */
export function LocationsTab({ company, canManage }: Props) {
  const t = useT();
  const lang = useLang();
  const lookup = useLookupText(lang);
  const confirm = useConfirm();
  const toast = useToast();
  const { data: rows, isPending, error } = useLocations(company.id);
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
      onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
    });
  }

  const dim = <span className="dim">—</span>;
  const head = [t('Name'), t('Type'), t('City'), t('Country'), t('Verified|location'), t('Source'), ...(canManage ? [<span className="sr">{t('Actions')}</span>] : [])];

  return (
    <section className="card flush" aria-labelledby="locations-title">
      <div className="head">
        <h2 id="locations-title">{t('Office & branch locations')}</h2>
        <div className="grow" />
        {canManage ? (
          <button type="button" className="btn sm primary" onClick={() => setEditing(null)}>
            {Icons.plus}
            {t('Add location')}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="empty" role="alert">
          {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
        </div>
      ) : (
        <Table head={head} isEmpty={isPending || !rows?.length} empty={isPending ? t('Loading…') : t('No locations recorded')}>
          {rows?.map((l) => {
            const maps = safeUrl(l.mapsUrl);
            return (
              <tr key={l.id}>
                <td>
                  <strong>{l.name}</strong>
                  {l.street || maps ? (
                    <span className="cell-sub">
                      {l.street}
                      {l.street && maps ? ' · ' : null}
                      {maps ? (
                        <a href={maps} target="_blank" rel="noopener noreferrer">
                          {t('Map')}
                        </a>
                      ) : null}
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className={l.locationType === 'Headquarters' ? 'badge b-purple' : 'badge b-grey'}>{lookup('location_type', l.locationType)}</span>
                </td>
                <td>{l.city ?? dim}</td>
                <td>{lookup('country', l.country)}</td>
                <td>{l.isVerified ? <span className="badge b-ok">{t('Verified|location')}</span> : <span className="dim">{t('Not verified|location')}</span>}</td>
                <td>{l.source}</td>
                {canManage ? (
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn xs" onClick={() => setEditing(l)} aria-label={t('Edit {name}', { name: l.name })}>
                        {t('Edit')}
                      </button>
                      <button
                        type="button"
                        className="btn xs danger"
                        disabled={remove.isPending}
                        onClick={() => void onDelete(l)}
                        aria-label={t('Delete {name}', { name: l.name })}
                      >
                        {t('Delete')}
                      </button>
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </Table>
      )}
      {editing !== undefined ? <LocationModal companyId={company.id} location={editing ?? undefined} onClose={() => setEditing(undefined)} /> : null}
    </section>
  );
}
