import { useState } from 'react';
import { CLOSED_STATUSES, type ClosedStatus } from '@dait-crm/shared';
import { useLeadAction, type LeadFull } from '../../api/leads';
import { useCurrentUser } from '../../api/useCurrentUser';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText, leadStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { ProjectModal } from '../projects/ProjectModal';
import { useActionError } from './staleToast';

/**
 * Close a lead as Won (confirm: the company becomes a client), Lost or Not Relevant (reason
 * required). Closing clears the follow-up and closes the lead's open tasks. `initialStatus` preselects the
 * status picked in the Follow-up tab's Status select. Won offers the prototype's "Mark Won" and "Mark Won and create
 * project": the latter marks the lead Won the same way, then opens Create project preset with this client and lead
 * (nothing opens when marking Won fails).
 */
export function CloseLeadModal({ lead, onClose, initialStatus }: { lead: LeadFull; onClose: () => void; initialStatus?: ClosedStatus }) {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const onFail = useActionError();
  const action = useLeadAction();
  const [status, setStatus] = useState<ClosedStatus | null>(initialStatus ?? null);
  const [reason, setReason] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [projectNext, setProjectNext] = useState(false);
  const needsReason = status === 'Lost' || status === 'Not Relevant';
  const canCreateProject = lead.companyId !== null && me.can('manage_quotes');

  const hint: Record<ClosedStatus, string> = {
    Won: lead.company
      ? t('{company} will be marked as a client.', { company: lead.company.name })
      : t('The deal is won.'),
    Lost: t('The opportunity went elsewhere or stalled.'),
    'Not Relevant': t('Not a fit for our services.'),
  };

  function submit(withProject = false) {
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
          if (withProject) setProjectNext(true);
          else onClose();
        },
        onError: (err) => {
          const code = onFail(err);
          if (code === 'reason_required') setReasonError(errorText(t, code));
          else setProblem(errorText(t, code));
        },
      },
    );
  }

  if (projectNext && lead.companyId !== null) {
    return <ProjectModal preset={{ companyId: lead.companyId, leadId: lead.id }} onClose={onClose} />;
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
          {status === 'Won' ? (
            <>
              <button type="button" className={canCreateProject ? 'btn' : 'btn primary'} disabled={action.isPending} onClick={() => submit()}>
                {t('Mark Won')}
              </button>
              {canCreateProject ? (
                <button type="button" className="btn primary" disabled={action.isPending} onClick={() => submit(true)}>
                  {t('Mark Won and create project')}
                </button>
              ) : null}
            </>
          ) : (
            <button type="button" className="btn danger" disabled={action.isPending} onClick={() => submit()}>
              {t('Close lead')}
            </button>
          )}
        </>
      }
    >
      <fieldset className="radio-group" aria-describedby={statusError ? 'cl-status-err' : undefined}>
        <legend className="lbl">
          {t('Outcome')}{' '}
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
      {status ? (
        <div className="note info">
          {t('The follow-up date is cleared and open tasks are closed.')}
          {status === 'Won' ? ` ${t('A client can have several projects, so the project is created as a separate step.')}` : null}
        </div>
      ) : null}
      {problem ? (
        <div className="note warn" role="alert">
          {problem}
        </div>
      ) : null}
    </Modal>
  );
}
