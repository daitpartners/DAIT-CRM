import { useState } from 'react';
import { useLeadAction, type LeadFull } from '../../api/leads';
import { CompanyPicker } from '../../components/CompanyPicker';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/useT';
import { useActionError } from './staleToast';

/** A lead saved or imported without a company (unresolved duplicate): link one or create it from the lead. */
export function ChooseCompany({ lead }: { lead: LeadFull }) {
  const t = useT();
  const toast = useToast();
  const onFail = useActionError();
  const action = useLeadAction();
  const [companyId, setCompanyId] = useState<number | undefined>(undefined);
  const [missing, setMissing] = useState(false);

  function resolve(target: number | 'create') {
    action.mutate(
      { lead, action: 'resolve-company', body: { companyId: target } },
      {
        onSuccess: (saved) => toast(t('Lead linked to {company}', { company: saved.company?.name ?? '' })),
        onError: (err) => onFail(err, true),
      },
    );
  }

  return (
    <section className="card" aria-labelledby="lead-choose-co">
      <h2 id="lead-choose-co" className="card-title">
        {t('Choose company')}
      </h2>
      <p className="muted-text">
        {t('This lead has no company because it may match one that already exists. Link it, or create a new company from the lead.')}
      </p>
      <div className="inline-bar">
        <CompanyPicker
          id="lead-resolve-company"
          label={t('Existing company')}
          value={companyId}
          invalid={missing}
          errorText={t('Choose a company')}
          onChange={(v) => {
            setCompanyId(v);
            setMissing(false);
          }}
          className="grow"
        />
        <button
          type="button"
          className="btn primary"
          disabled={action.isPending}
          onClick={() => (companyId === undefined ? setMissing(true) : resolve(companyId))}
        >
          {t('Link company')}
        </button>
        <button type="button" className="btn" disabled={action.isPending} onClick={() => resolve('create')}>
          {t('Create new company')}
        </button>
      </div>
    </section>
  );
}
