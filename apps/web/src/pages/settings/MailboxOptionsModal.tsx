import { useState } from 'react';
import { ApiError } from '../../api/client';
import { useSaveMailboxOptions, type Mailbox } from '../../api/mailboxes';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

/** Prototype "Mailbox options · {address}": sync mail, sync calendar, shared mailboxes to include. */
export function MailboxOptionsModal({ mailbox, onClose }: { mailbox: Mailbox; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const save = useSaveMailboxOptions();
  const [syncMail, setSyncMail] = useState(mailbox.syncMail);
  const [syncCalendar, setSyncCalendar] = useState(mailbox.syncCalendar);
  const [shared, setShared] = useState(mailbox.sharedMailboxes.join(', '));
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const list = shared.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (list.some((s) => !EMAIL_RE.test(s))) return setError(t('Enter full email addresses, separated by commas'));
    if (list.length > 10) return setError(t('At most 10 shared mailboxes'));
    save.mutate(
      { id: mailbox.id, body: { syncMail, syncCalendar, sharedMailboxes: list } },
      {
        onSuccess: () => {
          toast(t('Mailbox options saved'));
          onClose();
        },
        onError: (err) => setError(errorText(t, err instanceof ApiError ? err.code : 'unknown')),
      },
    );
  }

  return (
    <Modal
      title={t('Mailbox options · {address}', { address: mailbox.address })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={submit}>
            {t('Save')}
          </button>
        </>
      }
    >
      <label className="sw">
        <input type="checkbox" checked={syncMail} onChange={(e) => setSyncMail(e.target.checked)} />
        {t('Sync mail (the CRM keeps lead mail only: mail with your leads and contacts, from the last 12 months, then continuous)')}
      </label>
      <label className="sw">
        <input type="checkbox" checked={syncCalendar} onChange={(e) => setSyncCalendar(e.target.checked)} />
        {t('Sync calendar two-way (CRM meetings appear in Outlook, Outlook events appear here)')}
      </label>
      <div>
        <label className="lbl" htmlFor="mb-shared">
          {t('Shared mailboxes to include')}
        </label>
        <input id="mb-shared" className="in" value={shared} placeholder="hello@daitpartners.com, sales@daitpartners.com" onChange={(e) => setShared(e.target.value)} />
      </div>
      <div className="note info">
        {t('Only messages from known contacts or company domains are linked to records automatically; everything else stays in Unlinked for you to review.')}
      </div>
      {error ? (
        <div className="note warn" role="alert">
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
