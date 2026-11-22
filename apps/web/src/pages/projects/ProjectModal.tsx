import { useEffect, useRef, useState } from 'react';
import { PROJECT_STATUSES, QUOTE_CURRENCIES, primaryStakeholderIds, type ProjectStatus, type QuoteCurrency } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { clientName } from '../../api/companies';
import { useCreateProject, useProjectFormOptions, useUpdateProject, type ProjectRow } from '../../api/projects';
import { useCurrentUser } from '../../api/useCurrentUser';
import { CompanyPicker } from '../../components/CompanyPicker';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText, leadStatusText, projectStatusText, quoteStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { todayIn } from '../calendar/dates';

export type ProjectPreset = { companyId?: number; leadId?: number; name?: string; value?: number; currency?: QuoteCurrency; quotationId?: number };

type Props = { preset?: ProjectPreset; existing?: ProjectRow; onClose: () => void };

/**
 * Create / Edit project (prototype V.projectModal, field for field). The Client (clients only, locked when editing)
 * drives the other choices: changing it reloads its leads, Accepted quotations and contacts and re-ticks the default
 * stakeholders (the lead's contact, the primary contact and Decision Makers). Validation is by toast, as the
 * prototype. Used from the Projects list, the lead page, the company page and the Won dialog.
 */
export function ProjectModal({ preset = {}, existing, onClose }: Props) {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const create = useCreateProject();
  const update = useUpdateProject();
  const editing = Boolean(existing);

  const [companyId, setCompanyId] = useState<number | undefined>(existing?.company.id ?? preset.companyId);
  const [leadId, setLeadId] = useState(String(existing ? existing.lead?.id ?? '' : preset.leadId ?? ''));
  const [name, setName] = useState(existing?.name ?? preset.name ?? '');
  const [status, setStatus] = useState<ProjectStatus>(existing?.status ?? 'Active');
  const [startDate, setStartDate] = useState(existing?.startDate ?? todayIn(me.timezone));
  const [value, setValue] = useState(existing ? (existing.value === null ? '' : String(existing.value)) : preset.value != null ? String(preset.value) : '');
  const [currency, setCurrency] = useState<QuoteCurrency>(existing?.currency ?? preset.currency ?? 'USD');
  const [managerId, setManagerId] = useState(String(existing?.manager.id ?? me.id));
  const [quotationId, setQuotationId] = useState(String(existing ? existing.quotation?.id ?? '' : preset.quotationId ?? ''));
  const [ticked, setTicked] = useState<number[]>(existing ? existing.stakeholders.map((s) => s.id) : []);
  const [description, setDescription] = useState(existing?.description ?? '');

  const { data: options } = useProjectFormOptions(companyId, existing?.id);
  const current = options && options.company.id === companyId ? options : undefined;

  // A new project's defaults once the chosen client's options arrive: "<company> · " as the name (unless typed),
  // the client's currency (unless preset) and the default stakeholders.
  const initialised = useRef<number | undefined>(existing?.company.id);
  const autoName = useRef('');
  useEffect(() => {
    if (!current || initialised.current === current.company.id) return;
    initialised.current = current.company.id;
    const prefix = `${current.company.name} · `;
    setName((n) => (n === '' || n === autoName.current ? prefix : n));
    autoName.current = prefix;
    if (!preset.currency) setCurrency(current.company.defaultCurrency);
    const presetLead = current.company.id === preset.companyId && preset.leadId ? current.leads.find((l) => l.id === preset.leadId) : undefined;
    setTicked(primaryStakeholderIds(current.contacts, presetLead?.contactId));
  }, [current, preset.companyId, preset.leadId, preset.currency]);

  function chooseClient(id: number) {
    if (id === companyId) return;
    setCompanyId(id);
    setLeadId('');
    setQuotationId('');
    setTicked([]);
  }

  const contacts = current?.contacts ?? [];
  const users = current?.users ?? [];
  // Keep the current manager offered (an inactive one when editing; me, the default, when creating).
  const keep = existing ? existing.manager : { id: me.id, name: me.name };
  const managers = users.some((u) => u.id === keep.id) ? users : [keep, ...users];
  const pending = create.isPending || update.isPending;

  function onError(err: unknown) {
    const code = err instanceof ApiError ? err.code : 'unknown';
    toast(errorText(t, code), 'warn');
    // Stale: the dialog holds the old updatedAt, so every retry would fail; closing it means reopening loads the fresh row.
    if (code === 'stale' && editing) onClose();
  }

  function save() {
    if (companyId === undefined) return toast(t('Choose a client first'), 'warn');
    if (!name.trim()) return toast(t('Project name is required'), 'warn');
    const stakeholderIds = contacts.filter((c) => ticked.includes(c.id)).map((c) => c.id);
    const fields = {
      leadId: leadId ? Number(leadId) : null,
      quotationId: quotationId ? Number(quotationId) : null,
      name: name.trim(),
      status,
      startDate,
      value: value.trim() === '' ? null : Number(value),
      currency,
      managerId: Number(managerId),
      stakeholderIds,
      description: description.trim() ? description : null,
    };
    if (existing) {
      update.mutate(
        { id: existing.id, body: { ...fields, updatedAt: existing.updatedAt } },
        {
          onSuccess: () => {
            toast(t('Project updated'));
            onClose();
          },
          onError,
        },
      );
    } else {
      create.mutate(
        { companyId, ...fields },
        {
          onSuccess: (p) => {
            toast(t('{number} created · {n} stakeholders', { number: p.number, n: stakeholderIds.length }));
            onClose();
          },
          onError,
        },
      );
    }
  }

  const clientLabel = (n: string, isClient = true) => `${n} · ${isClient ? t('client|project') : t('not yet a client')}`;

  return (
    <Modal
      title={editing ? t('Edit project') : t('Create project')}
      onClose={onClose}
      focusDialog
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={pending} onClick={save}>
            {editing ? t('Save') : t('Create project')}
          </button>
        </>
      }
    >
      <div className="grid2">
        {existing ? (
          <FormField id="pj-company" label={t('Client')} required>
            <select id="pj-company" className="in pj-locked" disabled value={existing.company.id}>
              <option value={existing.company.id}>{clientLabel(clientName(existing.company))}</option>
            </select>
          </FormField>
        ) : (
          <CompanyPicker
            id="pj-company"
            label={t('Client')}
            required
            clientsOnly
            optionLabel={(c) => clientLabel(clientName(c))}
            placeholder={t('— choose client —')}
            value={companyId}
            selected={current ? { value: String(current.company.id), label: clientLabel(clientName(current.company), current.company.isClient) } : null}
            onChange={chooseClient}
          />
        )}
        <FormField id="pj-lead" label={t('From lead')}>
          <select id="pj-lead" className="in" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            <option value="">{t('— none —')}</option>
            {(current?.leads ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {[l.number, l.contactName || l.leadSource, leadStatusText(t, l.status)].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="pj-name" label={t('Project name')} required className="span2">
          <input id="pj-name" className="in" value={name} placeholder={t('e.g. Warehouse automation advisory')} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField id="pj-status" label={t('Status')}>
          <select id="pj-status" className="in" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {projectStatusText(t, s)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="pj-start" label={t('Start date')}>
          <input id="pj-start" type="date" className="in" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </FormField>
        <FormField id="pj-value" label={t('Value')}>
          <input id="pj-value" type="number" min="0" step="any" className="in" value={value} onChange={(e) => setValue(e.target.value)} />
        </FormField>
        <FormField id="pj-currency" label={t('Currency')}>
          <select id="pj-currency" className="in" value={currency} onChange={(e) => setCurrency(e.target.value as QuoteCurrency)}>
            {QUOTE_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="pj-manager" label={t('Project manager')}>
          <select id="pj-manager" className="in" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            {managers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="pj-quote" label={t('Linked quotation')}>
          <select id="pj-quote" className="in" value={quotationId} onChange={(e) => setQuotationId(e.target.value)}>
            <option value="">{t('— none —')}</option>
            {(current?.quotations ?? []).map((q) => (
              <option key={q.id} value={q.id}>
                {`${q.number} · ${quoteStatusText(t, q.status)}`}
              </option>
            ))}
          </select>
        </FormField>
        <div className="span2" role="group" aria-labelledby="pj-sh-lbl">
          <div id="pj-sh-lbl" className="lbl">
            {t('Primary stakeholders')} <span className="pj-hint">{t('(copied on every project email)')}</span>
          </div>
          <div className="pj-stakeholders">
            {contacts.length ? (
              contacts.map((c) => (
                <label key={c.id} className="sw">
                  <input
                    type="checkbox"
                    checked={ticked.includes(c.id)}
                    onChange={(e) => setTicked((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id)))}
                  />{' '}
                  {c.name} <span className="muted">· {c.designation || c.contactType} · {c.email || t('no email')}</span>
                </label>
              ))
            ) : (
              <span className="pj-none">{t('No contacts at this client yet. Add contacts on the company profile.')}</span>
            )}
          </div>
        </div>
        <FormField id="pj-description" label={t('Description')} className="span2">
          <textarea id="pj-description" className="in" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
