import { useState } from 'react';
import { contactName, useContacts } from '../../api/contacts';
import { useLeadAction, type LeadFull } from '../../api/leads';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { useActionError } from './staleToast';

/** Choose the lead's contact person among the company's contacts (or none). */
export function SwitchContactModal({ lead, onClose }: { lead: LeadFull; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const onFail = useActionError();
  const action = useLeadAction();
  const companyId = lead.companyId ?? undefined;
  const { data, isPending } = useContacts({ companyId, page: 1, pageSize: 100, sort: 'lastName', dir: 'asc' }, companyId !== undefined);
  const [value, setValue] = useState(lead.contactId ? String(lead.contactId) : '');
  const [problem, setProblem] = useState<string | null>(null);

  function submit() {
    setProblem(null);
    const contactId = value ? Number(value) : null;
    if (contactId === lead.contactId) {
      onClose();
      return;
    }
    action.mutate(
      { lead, action: 'contact', body: { contactId } },
      {
        onSuccess: () => {
          toast(t('Contact person updated'));
          onClose();
        },
        onError: (err) => setProblem(errorText(t, onFail(err))),
      },
    );
  }

  return (
    <Modal
      title={t('Switch contact')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={action.isPending || isPending} onClick={submit}>
            {t('Save')}
          </button>
        </>
      }
    >
      <FormField id="sc-contact" label={t('Contact person')}>
        <select id="sc-contact" className="in" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">{t('No contact')}</option>
          {(data?.items ?? []).map((c) => (
            <option key={c.id} value={String(c.id)}>
              {contactName(c)}
              {c.designation ? ` · ${c.designation}` : ''}
              {c.isPrimary ? ` (${t('Primary')})` : ''}
            </option>
          ))}
        </select>
      </FormField>
      {problem ? (
        <div className="note warn" role="alert">
          {problem}
        </div>
      ) : null}
    </Modal>
  );
}
