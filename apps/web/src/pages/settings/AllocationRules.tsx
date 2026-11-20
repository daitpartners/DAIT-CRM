import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { lookupLabel } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { keys, useAllocationRules, useLookups, useUsers, type AllocationRule } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { AccessDenied } from '../../components/AccessDenied';
import { useConfirm } from '../../components/ConfirmDialog';
import { Icons } from '../../components/Icons';
import { Table } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { AllocationModal } from './AllocationModal';

export function AllocationRules() {
  const me = useCurrentUser();
  if (!me.can('view_admin_settings')) return <AccessDenied />;
  return <RulesTable canEdit={me.can('manage_allocation')} />;
}

function RulesTable({ canEdit }: { canEdit: boolean }) {
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: rules, isPending, error } = useAllocationRules();
  const { data: users } = useUsers();
  const { data: lookups } = useLookups();
  const [editing, setEditing] = useState<AllocationRule | 'new' | null>(null);

  const userName = (id: number) => users?.find((u) => u.id === id)?.name ?? `#${id}`;
  const countryName = (v: string) => {
    const row = lookups?.country?.find((c) => c.value === v);
    return row ? lookupLabel(row, lang) : v;
  };
  const countriesText = (r: AllocationRule) =>
    r.matchCountries.length === 1 && r.matchCountries[0] === '*' ? t('All countries') : r.matchCountries.map(countryName).join(', ');
  const assignText = (r: AllocationRule) =>
    Array.isArray(r.assignTo)
      ? r.assignTo.length > 1
        ? t('{names} (round-robin)', { names: r.assignTo.map(userName).join(' → ') })
        : r.assignTo.map(userName).join('')
      : userName(r.assignTo);

  const patch = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) => api<AllocationRule>(`/api/allocation-rules/${id}`, { method: 'PATCH', body: { isActive } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.allocation });
      toast(t('Saved'));
    },
    onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api<void>(`/api/allocation-rules/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.allocation });
      toast(t('Rule deleted'));
    },
    onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
  });

  async function del(r: AllocationRule) {
    const ok = await confirm({ title: t('Delete rule?'), body: t('"{name}" will be removed. New leads will no longer be routed by it.', { name: r.name }), confirmLabel: t('Delete'), danger: true });
    if (ok) remove.mutate(r.id);
  }

  const head = [t('Rule'), t('Countries'), t('Assign to'), t('Priority'), t('Active')];
  return (
    <section className="card flush" aria-labelledby="alloc-title">
      <div className="head">
        <div>
          <h2 id="alloc-title">{t('Allocation rules')}</h2>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{t('New leads go to the first active rule (lowest priority number) that matches their country.')}</div>
        </div>
        <div className="grow" />
        {canEdit ? (
          <button type="button" className="btn primary sm" onClick={() => setEditing('new')}>
            {Icons.plus}
            {t('Add rule')}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="empty" role="alert">{errorText(t, error instanceof ApiError ? error.code : 'unknown')}</div>
      ) : (
        <Table
          head={canEdit ? [...head, <span className="sr">{t('Actions')}</span>] : head}
          isEmpty={isPending || !rules?.length}
          empty={isPending ? t('Loading…') : t('No allocation rules yet')}
        >
          {rules?.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="wrap">{countriesText(r)}</td>
              <td className="wrap">{assignText(r)}</td>
              <td>{r.priority}</td>
              <td>
                {canEdit ? (
                  <label className="sw">
                    <input type="checkbox" checked={r.isActive} onChange={() => patch.mutate({ id: r.id, isActive: !r.isActive })} aria-label={t('Rule "{name}" active', { name: r.name })} />
                  </label>
                ) : r.isActive ? (
                  <span className="badge b-ok">{t('Active')}</span>
                ) : (
                  <span className="badge b-grey">{t('Inactive')}</span>
                )}
              </td>
              {canEdit ? (
                <td>
                  <div className="row-actions">
                    <button type="button" className="btn xs" onClick={() => setEditing(r)}>
                      {t('Edit')}
                    </button>
                    <button type="button" className="btn xs danger" onClick={() => del(r)}>
                      {t('Delete')}
                    </button>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </Table>
      )}
      {editing ? <AllocationModal rule={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}
