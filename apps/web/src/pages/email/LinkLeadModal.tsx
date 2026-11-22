import { useState } from 'react';
import { ApiError } from '../../api/client';
import { useLeads, type LeadSummary } from '../../api/leads';
import { useMailAction, type MailDetail } from '../../api/mail';
import { Combobox } from '../../components/Combobox';
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

/**
 * Prototype "Link email to a lead": one "Existing lead" select, searchable in place (prototype UI.enhanceSelects),
 * whose blank choice creates a new lead from the email. Typing searches all visible leads on the server.
 */
export function LinkLeadModal({ message, onClose, onLinked, onCreated }: Props) {
  const t = useT();
  const toast = useToast();
  const action = useMailAction();
  const [q, setQ] = useState('');
  // The chosen lead is kept as is: a later search that no longer finds it does not drop the choice.
  const [chosen, setChosen] = useState<LeadSummary | null>(null);
  const debounced = useDebounce(q.trim(), 250);
  const { data } = useLeads({ q: debounced || undefined, pageSize: 25, tab: 'all' });
  const found = (data?.items ?? []).filter((l) => !l.archivedAt);
  // While typing only the matches are offered (as the prototype filters); closed, the chosen lead stays listed for its label.
  const leads = !q.trim() && chosen && !found.some((l) => l.id === chosen.id) ? [chosen, ...found] : found;
  const options = [
    ...(q.trim() ? [] : [{ value: '', label: t('— create a new lead from this email —') }]),
    ...leads.map((l) => ({ value: String(l.id), label: `${l.number} · ${l.companyName}` })),
  ];

  function go() {
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
      focusDialog
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="btn primary" disabled={action.isPending} onClick={go}>{t('Link')}</button>
        </>
      }
    >
      <Combobox
        id="link-lead"
        label={t('Existing lead')}
        searchable
        options={options}
        value={chosen ? String(chosen.id) : null}
        placeholder={t('— create a new lead from this email —')}
        onQuery={setQ}
        onChange={(v) => setChosen(leads.find((l) => String(l.id) === v) ?? null)}
      />
      <div className="note info">
        {t("Creating a lead runs the same duplicate check as the lead form: the sender's email domain is matched against existing companies first.")}
      </div>
    </Modal>
  );
}
