import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useLeads } from '../../api/leads';
import { useCreateQuotation } from '../../api/quotations';
import { CompanyPicker } from '../../components/CompanyPicker';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

/** Leads offered for one company: the API's maximum page, newest first. */
const LEAD_PAGE = 100;

/**
 * "New quotation" from the Quotations list (spec, builder's call): choose the company and, optionally, one of its
 * leads the user can see; the quotation is created with the defaults and the editor opens.
 */
export function NewQuotationModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateQuotation();
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [leadId, setLeadId] = useState('');
  const { data: leads } = useLeads({ companyId, page: 1, pageSize: LEAD_PAGE }, companyId !== undefined);

  function go() {
    if (companyId === undefined) return toast(t('Choose a company'), 'warn');
    create.mutate(
      { companyId, ...(leadId ? { leadId: Number(leadId) } : {}) },
      {
        onSuccess: (q) => {
          onClose();
          navigate(`/quotations/${q.id}`);
        },
        onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
      },
    );
  }

  return (
    <Modal
      title={t('New quotation')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={create.isPending} onClick={go}>
            {t('Create quotation')}
          </button>
        </>
      }
    >
      <div className="grid2">
        <CompanyPicker
          id="nqCompany"
          className="span2"
          label={t('Company')}
          required
          showNumber
          value={companyId}
          onChange={(id) => {
            setCompanyId(id);
            setLeadId('');
          }}
        />
        <div className="span2">
          <label className="lbl" htmlFor="nqLead">
            {t('Lead')}
          </label>
          <select id="nqLead" className="in" value={leadId} disabled={companyId === undefined} onChange={(e) => setLeadId(e.target.value)}>
            <option value="">{t('— no lead —')}</option>
            {/* The previous company's page stays shown while the next loads: only this company's leads are offered. */}
            {(leads?.items ?? []).filter((l) => l.companyId === companyId).map((l) => (
              <option key={l.id} value={l.id}>
                {[l.number, l.contact?.name].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}
