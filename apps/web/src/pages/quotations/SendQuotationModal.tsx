import { Fragment, useState, type ReactNode } from 'react';
import { defaultQuotationEmailBody, formatMoney } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useQuotationAction, type QuotationDetail } from '../../api/quotations';
import { useCurrentUser } from '../../api/useCurrentUser';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

/** A placeholder value that `withBold` turns into a bold part (pass `bold('status')` as the phrase's `{status}`). */
export const bold = (key: string) => `\u0000${key}\u0000`;

/**
 * A translated sentence with some placeholders shown in bold (the prototype's <strong> inside a sentence), so each
 * language keeps its own word order. `parts` gives the text of each bold placeholder.
 */
export function withBold(text: string, parts: Record<string, string>): ReactNode {
  return text.split('\u0000').map((part, i) => (i % 2 === 1 ? <strong key={i}>{parts[part]}</strong> : <Fragment key={i}>{part}</Fragment>));
}

/**
 * "Send by email" (prototype V.quoteEditor send dialog): the PDF of the revision being worked on goes to the
 * quotation's contact from the user's own mailbox. To is read-only; the message is prefilled with the default text
 * (spec) and editable. The revision is frozen, the status set and the lead moved when the send job succeeds.
 */
export function SendQuotationModal({ q, total, onClose }: { q: QuotationDetail; total: number; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const me = useCurrentUser();
  const send = useQuotationAction(q.id);
  const [message, setMessage] = useState(() => defaultQuotationEmailBody(q, me.language));

  function go() {
    send.mutate(
      { kind: 'send', body: message.trim() || undefined },
      {
        onSuccess: () => {
          onClose();
          toast(t('{number} is being sent from your mailbox', { number: q.number }));
        },
        onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
      },
    );
  }

  return (
    <Modal
      title={t('Send {number} by email', { number: q.number })}
      onClose={onClose}
      focusDialog
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={send.isPending} onClick={go}>
            {t('Send')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13, color: 'var(--body)' }}>
        {withBold(
          t('A PDF of revision {revision} ({total}) is attached and the revision is frozen. The lead moves to {status} if it is earlier in the pipeline.', {
            revision: q.revision, total: formatMoney(total, q.currency), status: bold('status'),
          }),
          { status: t('Proposal Sent|lead') },
        )}
      </p>
      <FormField id="sqTo" label={t('To')}>
        <input id="sqTo" className="in" value={q.contact?.email ?? ''} readOnly />
      </FormField>
      <FormField id="sqMessage" label={t('Message')}>
        <textarea id="sqMessage" className="in" rows={5} maxLength={20000} value={message} onChange={(e) => setMessage(e.target.value)} />
      </FormField>
    </Modal>
  );
}
