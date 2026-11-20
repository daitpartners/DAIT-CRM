import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AllocationRuleCreate, lookupLabel } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { keys, useLookups, useUsers, type AllocationRule } from '../../api/queries';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { MultiCombobox } from '../../components/MultiCombobox';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';

type Props = { rule?: AllocationRule; onClose: () => void };

export function AllocationModal({ rule, onClose }: Props) {
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: lookups } = useLookups();
  const { data: users } = useUsers();

  const isAll = rule ? rule.matchCountries.length === 1 && rule.matchCountries[0] === '*' : false;
  const [name, setName] = useState(rule?.name ?? '');
  const [allCountries, setAllCountries] = useState(isAll);
  const [countries, setCountries] = useState<string[]>(rule && !isAll ? rule.matchCountries : []);
  const [assignees, setAssignees] = useState<string[]>(rule ? (Array.isArray(rule.assignTo) ? rule.assignTo : [rule.assignTo]).map(String) : []);
  const [priority, setPriority] = useState(String(rule?.priority ?? 10));
  const [errors, setErrors] = useState<Partial<Record<'name' | 'countries' | 'assignees' | 'priority' | 'form', string>>>({});

  const countryOptions = (lookups?.country ?? []).map((c) => ({ value: c.value, label: lookupLabel(c, lang) }));
  // Keep countries already on the rule even if their lookup value was since deactivated.
  for (const c of countries) if (!countryOptions.some((o) => o.value === c)) countryOptions.push({ value: c, label: c });
  const userOptions = (users ?? []).filter((u) => u.isActive).map((u) => ({ value: String(u.id), label: u.name }));

  const save = useMutation({
    mutationFn: (body: AllocationRuleCreate) =>
      rule
        ? api<AllocationRule>(`/api/allocation-rules/${rule.id}`, { method: 'PATCH', body })
        : api<AllocationRule>('/api/allocation-rules', { method: 'POST', body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.allocation });
      toast(rule ? t('Rule updated') : t('Rule added'));
      onClose();
    },
    onError: (err) => setErrors({ form: errorText(t, err instanceof ApiError ? err.code : 'unknown') }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const ids = assignees.map(Number);
    const body = {
      name,
      matchCountries: allCountries ? ['*'] : countries,
      assignTo: ids.length === 1 ? ids[0] : ids,
      priority: Number(priority),
    };
    const parsed = AllocationRuleCreate.safeParse(body);
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === 'name') next.name = t('Enter a rule name');
        if (key === 'matchCountries') next.countries = t('Choose at least one country, or all countries');
        if (key === 'assignTo') next.assignees = t('Choose at least one user');
        if (key === 'priority') next.priority = t('Enter a whole number, 0 or more');
      }
      setErrors(next);
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  return (
    <Modal
      title={rule ? t('Edit allocation rule') : t('Add allocation rule')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="rule-form" className="btn primary" disabled={save.isPending}>
            {rule ? t('Save') : t('Add rule')}
          </button>
        </>
      }
    >
      <form id="rule-form" noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="grid2">
          <FormField id="rule-name" label={t('Rule name')} required error={errors.name}>
            <input id="rule-name" className={errors.name ? 'in err' : 'in'} value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField id="rule-priority" label={t('Priority')} required error={errors.priority}>
            <input id="rule-priority" className={errors.priority ? 'in err' : 'in'} type="number" min={0} step={1} inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </FormField>
        </div>
        <div>
          <label className="check">
            <input type="checkbox" checked={allCountries} onChange={(e) => setAllCountries(e.target.checked)} />
            {t('All countries (*)')}
          </label>
        </div>
        <div>
          <MultiCombobox id="rule-countries" label={t('Countries')} options={countryOptions} values={countries} onChange={setCountries} disabled={allCountries} required={!allCountries} />
          {errors.countries ? <div className="err-msg" role="alert">{errors.countries}</div> : null}
        </div>
        <div>
          <MultiCombobox id="rule-users" label={t('Assign to')} options={userOptions} values={assignees} onChange={setAssignees} required />
          {errors.assignees ? <div className="err-msg" role="alert">{errors.assignees}</div> : null}
          {assignees.length > 1 ? (
            <div className="note info" style={{ marginTop: 8 }}>
              {t('Round-robin: matching leads are shared in turn between these {n} users, in the order listed.', { n: assignees.length })}
            </div>
          ) : null}
        </div>
        {errors.form ? (
          <div className="note warn" role="alert">
            {errors.form}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
