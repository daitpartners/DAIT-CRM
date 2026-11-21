import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { contactName, useMoveContact, type ContactSummary } from '../../api/contacts';
import { keys } from '../../api/queries';
import { CompanyPicker } from '../../components/CompanyPicker';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

/**
 * Move a contact to another (not Closed) company. Leads of other companies that named the contact
 * lose it; the contact stays primary nowhere it was, and becomes primary at the new company only if
 * that company has none.
 */
export function MoveContactModal({ contact, onClose }: { contact: ContactSummary; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const move = useMoveContact();
  const [companyId, setCompanyId] = useState<number | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = contactName(contact);

  function submit() {
    setProblem(null);
    if (companyId === undefined || companyId === contact.companyId) {
      setMissing(true);
      return;
    }
    move.mutate(
      { id: contact.id, companyId, updatedAt: contact.updatedAt },
      {
        onSuccess: (saved) => {
          toast(t('{name} moved to {company}', { name, company: saved.company.name }));
          onClose();
        },
        onError: (err) => {
          const code = err instanceof ApiError ? err.code : 'unknown';
          if (code === 'stale') void qc.invalidateQueries({ queryKey: keys.contactsAll });
          setProblem(errorText(t, code));
        },
      },
    );
  }

  return (
    <Modal
      title={t('Move contact')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={move.isPending} onClick={submit}>
            {t('Move')}
          </button>
        </>
      }
    >
      <p>{t('Move {name} from {company} to another company.', { name, company: contact.company.name })}</p>
      <CompanyPicker
        id="mc-company"
        label={t('New company')}
        required
        value={companyId}
        onChange={(id) => {
          setCompanyId(id);
          setMissing(false);
        }}
        invalid={missing}
        errorText={t('Choose a different company')}
      />
      <div className="note" style={{ marginTop: 12 }}>
        {t('Leads at other companies will no longer name this contact.')}
      </div>
      {problem ? (
        <div className="note warn" role="alert">
          {problem}
        </div>
      ) : null}
    </Modal>
  );
}
