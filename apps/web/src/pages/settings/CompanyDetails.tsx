import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { useCompanySettings, useSaveCompanySettings, type CompanySettings } from '../../api/quotations';
import { useCurrentUser } from '../../api/useCurrentUser';
import { AccessDenied } from '../../components/AccessDenied';
import { FormField } from '../../components/FormField';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

type Form = { legalName: string; address: string; email: string; gstin: string; taxInr: string; taxUsd: string; taxCad: string; defaultNotes: string };

const formOf = (s: CompanySettings): Form => ({
  legalName: s.legalName, address: s.addressLines.join('\n'), email: s.email, gstin: s.gstin ?? '',
  taxInr: String(s.taxInr), taxUsd: String(s.taxUsd), taxCad: String(s.taxCad), defaultNotes: s.defaultNotes,
});

/**
 * Settings → Company details (release 3A, Administrators; no prototype screen, so the app's settings card style):
 * the issuer printed on every quotation PDF and the defaults for new quotations (GST % per currency, notes & terms).
 */
export function CompanyDetails() {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const allowed = me.can('view_admin_settings') && me.can('manage_users');
  const { data } = useCompanySettings(allowed);
  const save = useSaveCompanySettings();
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (data) setForm(formOf(data));
  }, [data]);

  if (!allowed) return <AccessDenied />;

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    save.mutate(
      {
        legalName: form.legalName.trim(),
        addressLines: form.address.split('\n').map((l) => l.trim()).filter(Boolean),
        email: form.email.trim(),
        gstin: form.gstin.trim() || null,
        taxInr: Number(form.taxInr) || 0,
        taxUsd: Number(form.taxUsd) || 0,
        taxCad: Number(form.taxCad) || 0,
        defaultNotes: form.defaultNotes,
      },
      {
        onSuccess: () => toast(t('Saved')),
        onError: (err) => {
          const issue = err instanceof ApiError ? err.issues?.[0]?.message : undefined;
          toast(issue === 'invalid_gstin' ? t('GSTIN must be 15 letters or digits') : errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn');
        },
      },
    );
  }

  return (
    <section className="card" aria-labelledby="company-details-title">
      <div className="card-title-row">
        <h2 id="company-details-title">{t('Company details')}</h2>
        <span className="muted card-sub">{t('Printed on every quotation PDF. The defaults apply to new quotations.')}</span>
      </div>
      {form ? (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="grid2">
            <FormField id="cdLegalName" label={t('Legal name')} required>
              <input id="cdLegalName" className="in" required maxLength={200} value={form.legalName} onChange={set('legalName')} />
            </FormField>
            <FormField id="cdEmail" label={t('Email')} required>
              <input id="cdEmail" className="in" type="email" required maxLength={255} value={form.email} onChange={set('email')} />
            </FormField>
            <FormField id="cdAddress" label={t('Address')}>
              <textarea id="cdAddress" className="in" rows={4} value={form.address} onChange={set('address')} />
            </FormField>
            <FormField id="cdGstin" label={t('GSTIN')}>
              <input id="cdGstin" className="in" maxLength={15} value={form.gstin} onChange={set('gstin')} />
              <div className="muted-text" style={{ fontSize: 12, marginTop: 4 }}>{t('Optional. Printed only on INR quotations.')}</div>
            </FormField>
          </div>
          <div className="grid3">
            {(['INR', 'USD', 'CAD'] as const).map((c) => {
              const k = c === 'INR' ? 'taxInr' : c === 'USD' ? 'taxUsd' : 'taxCad';
              return (
                <FormField key={c} id={`cd-${k}`} label={t('Default GST % · {currency}', { currency: c })}>
                  <input id={`cd-${k}`} className="in" type="number" min="0" max="100" step="0.01" value={form[k]} onChange={set(k)} />
                </FormField>
              );
            })}
          </div>
          <FormField id="cdNotes" label={t('Default notes & terms')}>
            <textarea id="cdNotes" className="in" rows={4} maxLength={10000} value={form.defaultNotes} onChange={set('defaultNotes')} />
          </FormField>
          <div>
            <button type="submit" className="btn primary" disabled={save.isPending}>
              {save.isPending ? t('Saving…') : t('Save')}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
