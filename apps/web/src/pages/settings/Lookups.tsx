import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LOOKUP_GROUPS, LookupValueCreate, type LookupGroup, type LookupValuePatch } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { keys, useLookupGroup, type LookupValue } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { AccessDenied } from '../../components/AccessDenied';
import { Combobox } from '../../components/Combobox';
import { useConfirm } from '../../components/ConfirmDialog';
import { Table } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { errorText, groupText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { InlineText } from './InlineText';

export function Lookups() {
  const me = useCurrentUser();
  if (!me.can('manage_lookups')) return <AccessDenied />;
  return <LookupsEditor />;
}

function LookupsEditor() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [group, setGroup] = useState<LookupGroup>('lead_status');
  const { data: items, isPending } = useLookupGroup(group);

  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: keys.lookupGroup(group) }), qc.invalidateQueries({ queryKey: keys.lookups, exact: true })]);
  const onError = (err: unknown) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn');

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: LookupValuePatch }) => api<LookupValue>(`/api/lookups/${id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await refresh();
      toast(t('Saved'));
    },
    onError,
  });

  const reorder = useMutation({
    mutationFn: (ids: number[]) => api<void>(`/api/lookups/${group}/order`, { method: 'PUT', body: { ids } }),
    onMutate: (ids) => {
      // Optimistic: show the new order at once.
      const prev = qc.getQueryData<LookupValue[]>(keys.lookupGroup(group));
      if (prev) qc.setQueryData(keys.lookupGroup(group), ids.map((id) => prev.find((v) => v.id === id)!).filter(Boolean));
      return { prev };
    },
    onError: (err, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.lookupGroup(group), ctx.prev);
      onError(err);
    },
    onSettled: refresh,
  });

  function move(index: number, delta: -1 | 1) {
    if (!items) return;
    const ids = items.map((v) => v.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    reorder.mutate(ids);
  }

  async function toggle(v: LookupValue) {
    const ok = await confirm(
      v.isActive
        ? { title: t('Deactivate value?'), body: t('"{label}" will no longer be offered in dropdowns. Records that use it keep it.', { label: v.label }), confirmLabel: t('Deactivate'), danger: true }
        : { title: t('Reactivate value?'), body: t('"{label}" will be offered in dropdowns again.', { label: v.label }), confirmLabel: t('Reactivate') },
    );
    if (ok) patch.mutate({ id: v.id, body: { isActive: !v.isActive } });
  }

  function saveText(v: LookupValue, field: 'label' | 'labelEs' | 'labelFr', next: string): boolean {
    const value = next.trim();
    if ((v[field] ?? '') === value) return true;
    if (!value) {
      toast(t('Labels cannot be blank'), 'warn');
      return false;
    }
    patch.mutate({ id: v.id, body: { [field]: value } });
    return true;
  }

  const groupOptions = LOOKUP_GROUPS.map((g) => ({ value: g, label: groupText(t, g) }));
  const count = items?.length ?? 0;

  return (
    <section className="card flush" aria-labelledby="lookups-title">
      <div className="head">
        <h2 id="lookups-title">{t('Dropdown configuration')}</h2>
        <div className="grow" />
        <div style={{ width: 260, maxWidth: '100%' }}>
          <Combobox id="lookup-group" label={t('List')} hideLabel options={groupOptions} value={group} onChange={(g) => setGroup(g as LookupGroup)} required />
        </div>
      </div>
      <Table
        head={[t('Order'), t('Value'), t('Label (English)'), t('Spanish'), t('French'), t('Status'), <span className="sr">{t('Actions')}</span>]}
        isEmpty={isPending || count === 0}
        empty={isPending ? t('Loading…') : t('No values in this list yet')}
      >
        {items?.map((v, i) => (
          <tr key={v.id}>
            <td>
              <div className="row-actions">
                <button type="button" className="btn xs" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)} aria-label={t('Move "{label}" up', { label: v.label })}>
                  ↑
                </button>
                <button type="button" className="btn xs" disabled={i === count - 1 || reorder.isPending} onClick={() => move(i, 1)} aria-label={t('Move "{label}" down', { label: v.label })}>
                  ↓
                </button>
              </div>
            </td>
            <td>
              <code>{v.value}</code>
            </td>
            <td>
              <InlineText label={t('Label (English) for {value}', { value: v.value })} value={v.label} onSave={(s) => saveText(v, 'label', s)} />
            </td>
            <td>
              <InlineText label={t('Spanish label for {value}', { value: v.value })} value={v.labelEs ?? ''} onSave={(s) => saveText(v, 'labelEs', s)} />
            </td>
            <td>
              <InlineText label={t('French label for {value}', { value: v.value })} value={v.labelFr ?? ''} onSave={(s) => saveText(v, 'labelFr', s)} />
            </td>
            <td>{v.isActive ? <span className="badge b-ok">{t('Active')}</span> : <span className="badge b-grey">{t('Inactive')}</span>}</td>
            <td>
              <button type="button" className={v.isActive ? 'btn xs danger' : 'btn xs'} onClick={() => toggle(v)}>
                {v.isActive ? t('Deactivate') : t('Reactivate')}
              </button>
            </td>
          </tr>
        ))}
      </Table>
      <AddValueForm group={group} onAdded={refresh} />
    </section>
  );
}

function AddValueForm({ group, onAdded }: { group: LookupGroup; onAdded: () => Promise<unknown> }) {
  const t = useT();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [labelEs, setLabelEs] = useState('');
  const [labelFr, setLabelFr] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (body: LookupValueCreate) => api<LookupValue>('/api/lookups', { method: 'POST', body }),
    onSuccess: async () => {
      setValue('');
      setLabel('');
      setLabelEs('');
      setLabelFr('');
      await onAdded();
      toast(t('Value added'));
    },
    onError: (err) => setError(errorText(t, err instanceof ApiError ? err.code : 'unknown')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = LookupValueCreate.safeParse({
      group,
      value,
      label,
      ...(labelEs.trim() ? { labelEs } : {}),
      ...(labelFr.trim() ? { labelFr } : {}),
    });
    if (!parsed.success) {
      setError(t('Enter a value and an English label'));
      return;
    }
    add.mutate(parsed.data);
  }

  return (
    <form className="inline-form" onSubmit={submit} noValidate aria-label={t('Add value')}>
      <div>
        <label className="lbl" htmlFor="new-value">
          {t('Value')}{' '}
          <span className="req" aria-hidden="true">*</span>
        </label>
        <input id="new-value" className="in" value={value} onChange={(e) => setValue(e.target.value)} required />
      </div>
      <div>
        <label className="lbl" htmlFor="new-label">
          {t('Label (English)')}{' '}
          <span className="req" aria-hidden="true">*</span>
        </label>
        <input id="new-label" className="in" value={label} onChange={(e) => setLabel(e.target.value)} required />
      </div>
      <div>
        <label className="lbl" htmlFor="new-label-es">
          {t('Spanish')}
        </label>
        <input id="new-label-es" className="in" value={labelEs} onChange={(e) => setLabelEs(e.target.value)} />
      </div>
      <div>
        <label className="lbl" htmlFor="new-label-fr">
          {t('French')}
        </label>
        <input id="new-label-fr" className="in" value={labelFr} onChange={(e) => setLabelFr(e.target.value)} />
      </div>
      <button type="submit" className="btn primary" disabled={add.isPending} style={{ flex: '0 0 auto' }}>
        {t('Add value')}
      </button>
      {error ? (
        <div className="err-msg" role="alert" style={{ flexBasis: '100%' }}>
          {error}
        </div>
      ) : null}
    </form>
  );
}
