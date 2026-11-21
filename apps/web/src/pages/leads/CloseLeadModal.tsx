import { useState } from 'react';
import { CLOSED_STATUSES, type ClosedStatus } from '@dait-crm/shared';
import { useLeadAction, type LeadFull } from '../../api/leads';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText, leadStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { useActionError } from './staleToast';

/**
 * Close a lead as Won (confirm: the company becomes a client), Lost or Not Relevant (reason
 * required). Closing clears the follow-up and closes the lead's open tasks.
 */
export function CloseLeadModal({ lead, onClose }: { lead: LeadFull; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const onFail = useActionError();
  const action = useLeadAction();
  const [status, setStatus] = useState<ClosedStatus | null>(null);
  const [reason, setReason] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const needsReason = status === 'Lost' || status === 'Not Relevant';

  const hint: Record<ClosedStatus, string> = {
    Won: lead.company
      ? t('{company} will be marked as a client.', { company: lead.company.name })
      : t('The deal is won.'),
    Lost: t('The opportunity went elsewhere or stalled.'),
    'Not Relevant': t('Not a fit for our services.'),
  };

  function submit() {
    setProblem(null);
    if (!status) {
      setStatusError(true);
      return;
    }
    if (needsReason && !reason.trim()) {
      setReasonError(t('Enter a reason'));
      return;
    }
    action.mutate(
      { lead, action: 'status', body: { status, ...(needsReason ? { reason: reason.trim() } : {}) } },
      {
        onSuccess: () => {
          toast(t('Lead closed as {status}', { status: leadStatusText(t, status) }));
          onClose();
        },
        onError: (err) => {
          const code = onFail(err);
          if (code === 'reason_required') setReasonError(errorText(t, code));
          else setProblem(errorText(t, code));
        },
      },
    );
  }

  return (
    <Modal
      title={t('Close lead')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className={status === 'Won' ? 'btn primary' : 'btn danger'} disabled={action.isPending} onClick={submit}>
            {t('Close lead')}
          </button>
        </>
      }
    >
      <fieldset className="radio-group" aria-describedby={statusError ? 'cl-status-err' : undefined}>
        <legend className="lbl">
          {t('Outcome')}
          <span className="req" aria-hidden="true">
            *
          </span>
        </legend>
        {CLOSED_STATUSES.map((s) => (
          <label key={s} className={status === s ? 'radio-card on' : 'radio-card'}>
            <input
              type="radio"
              name="close-status"
              value={s}
              checked={status === s}
              onChange={() => {
                setStatus(s);
                setStatusError(false);
                setReasonError(null);
              }}
            />
            <span>
              <strong>{leadStatusText(t, s)}</strong>
              <small>{hint[s]}</small>
            </span>
          </label>
        ))}
        {statusError ? (
          <div id="cl-status-err" className="err-msg" role="alert">
            {t('Choose how the lead ends')}
          </div>
        ) : null}
      </fieldset>
      {needsReason ? (
        <FormField id="cl-reason" label={t('Reason')} required error={reasonError ?? undefined}>
          <textarea
            id="cl-reason"
            className={reasonError ? 'in err' : 'in'}
            rows={3}
            maxLength={500}
            value={reason}
            aria-invalid={Boolean(reasonError)}
            aria-describedby={reasonError ? 'cl-reason-err' : undefined}
            onChange={(e) => {
              setReason(e.target.value);
              setReasonError(null);
            }}
          />
        </FormField>
      ) : null}
      {status ? <div className="note info">{t('The follow-up date is cleared and open tasks are closed.')}</div> : null}
      {problem ? (
        <div className="note warn" role="alert">
          {problem}
        </div>
      ) : null}
    </Modal>
  );
}
