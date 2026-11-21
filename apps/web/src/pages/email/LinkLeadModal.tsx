import { useState } from 'react';
import { ApiError } from '../../api/client';
import { useLeads } from '../../api/leads';
import { useMailAction, type MailDetail } from '../../api/mail';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useDebounce } from '../../hooks/useDebounce';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

type Props = {
  message: MailDetail;
  onClose: () => void;
  onLinked: (leadNumber: string) => void;
  onCreated: (leadId: number) => void;
};

/** Prototype "Link email to a lead": an existing lead, or a new lead created from the email. */
export function LinkLeadModal({ message, onClose, onLinked, onCreated }: Props) {
  const t = useT();
  const toast = useToast();
  const action = useMailAction();
  const [q, setQ] = useState('');
  const [leadId, setLeadId] = useState('');
  const debounced = useDebounce(q, 250);
  const { data } = useLeads({ q: debounced || undefined, pageSize: 25, tab: 'all' });
  const leads = (data?.items ?? []).filter((l) => !l.archivedAt);

  function go() {
    const chosen = leads.find((l) => String(l.id) === leadId);
    const onError = (err: unknown) => toast(err instanceof ApiError ? errorText(t, err.code) : t('Something went wrong. Try again.'), 'warn');
    if (chosen) {
      action.mutate({ id: message.id, action: 'link', body: { leadId: chosen.id } }, { onSuccess: () => { onLinked(chosen.number); onClose(); }, onError });
      return;
    }
    action.mutate({ id: message.id, action: 'create-lead' }, {
      onSuccess: (r) => {
        onClose();
        if (r.leadId) onCreated(r.leadId);
      },
      onError,
    });
  }

  return (
    <Modal
      title={t('Link email to a lead')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="btn primary" disabled={action.isPending} onClick={go}>{t('Link')}</button>
        </>
      }
    >
      <div>
        <label className="lbl" htmlFor="link-q">{t('Find a lead')}</label>
        <input id="link-q" className="in" type="search" value={q} placeholder={t('Lead number, company or contact')} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div>
        <label className="lbl" htmlFor="link-lead">{t('Existing lead')}</label>
        <select id="link-lead" className="in" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
          <option value="">{t('— create a new lead from this email —')}</option>
          {leads.map((l) => (
            <option key={l.id} value={l.id}>{`${l.number} · ${l.companyName}`}</option>
          ))}
        </select>
      </div>
      <div className="note info">
        {t("Creating a lead runs the same duplicate check as the lead form: the sender's email domain is matched against existing companies first.")}
      </div>
    </Modal>
  );
}
