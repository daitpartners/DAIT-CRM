import { useState } from 'react';
import { useLeadAction, type LeadFull } from '../../api/leads';
import { useUsers } from '../../api/queries';
import { Combobox } from '../../components/Combobox';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText, roleText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { useActionError } from './staleToast';

/** Roles that work leads: a lead can be handed to an active user in one of them. */
const RECEIVER_ROLES = new Set(['Administrator', 'Manager', 'Sales Representative']);

/** Transfer a lead to another user (`transfer_leads`): who and why (the note is required). */
export function TransferModal({ lead, onClose }: { lead: LeadFull; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const onFail = useActionError();
  const action = useLeadAction();
  const { data: users } = useUsers();
  const [toUserId, setToUserId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [userError, setUserError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const options = (users ?? [])
    .filter((u) => u.isActive && RECEIVER_ROLES.has(u.role) && u.id !== lead.assignedTo?.id)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => ({ value: String(u.id), label: u.name, role: u.role }));

  // The list leaves out the current assignee: right after a transfer the chosen user is no longer in it.
  const chosen = options.find((o) => o.value === toUserId);

  function submit() {
    setProblem(null);
    const missingUser = !toUserId;
    const missingNote = !note.trim();
    setUserError(missingUser ? t('Choose who receives the lead') : null);
    setNoteError(missingNote ? t('Add a note for the person receiving the lead') : null);
    if (missingUser || missingNote) return;
    action.mutate(
      { lead, action: 'transfer', body: { toUserId: Number(toUserId), note: note.trim() } },
      {
        onSuccess: (saved) => {
          toast(t('{number} transferred to {name}', { number: saved.number, name: saved.assignedTo?.name ?? '' }));
          onClose();
        },
        onError: (err) => {
          const code = onFail(err);
          if (code === 'transfer_note_required') setNoteError(errorText(t, code));
          else if (code === 'unknown_user' || code === 'cannot_assign_hidden') setUserError(errorText(t, code));
          else setProblem(errorText(t, code));
        },
      },
    );
  }

  return (
    <Modal
      title={t('Transfer lead')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={action.isPending} onClick={submit}>
            {t('Transfer')}
          </button>
        </>
      }
    >
      <p>
        {lead.assignedTo
          ? t('{number} is with {name}.', { number: lead.number, name: lead.assignedTo.name })
          : t('{number} is unassigned.', { number: lead.number })}
      </p>
      <div>
        <Combobox
          id="tr-user"
          label={t('Transfer to')}
          required
          options={options.map((o) => ({ value: o.value, label: o.label }))}
          value={toUserId}
          placeholder={t('Choose a person')}
          onChange={(v) => {
            setToUserId(v);
            setUserError(null);
          }}
          errorId={userError ? 'tr-user-err' : undefined}
        />
        {userError ? (
          <div id="tr-user-err" className="err-msg" role="alert">
            {userError}
          </div>
        ) : chosen ? (
          <div className="hint-text">{roleText(t, chosen.role)}</div>
        ) : null}
      </div>
      <FormField id="tr-note" label={t('Note')} required error={noteError ?? undefined}>
        <textarea
          id="tr-note"
          className={noteError ? 'in err' : 'in'}
          rows={3}
          value={note}
          aria-invalid={Boolean(noteError)}
          aria-describedby={noteError ? 'tr-note-err' : 'tr-note-hint'}
          onChange={(e) => {
            setNote(e.target.value);
            setNoteError(null);
          }}
        />
        {!noteError ? (
          <div id="tr-note-hint" className="hint-text">
            {t('Say why the lead is moving; the receiver sees it in their notification.')}
          </div>
        ) : null}
      </FormField>
      {problem ? (
        <div className="note warn" role="alert">
          {problem}
        </div>
      ) : null}
    </Modal>
  );
}

/** Unassign (Administrator / Manager): the lead goes back to the pool; a note is required. */
export function UnassignModal({ lead, onClose }: { lead: LeadFull; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const onFail = useActionError();
  const action = useLeadAction();
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function submit() {
    setProblem(null);
    if (!note.trim()) {
      setNoteError(true);
      return;
    }
    action.mutate(
      { lead, action: 'unassign', body: { note: note.trim() } },
      {
        onSuccess: () => {
          toast(t('Lead unassigned'));
          onClose();
        },
        onError: (err) => setProblem(errorText(t, onFail(err))),
      },
    );
  }

  return (
    <Modal
      title={t('Unassign lead')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={action.isPending} onClick={submit}>
            {t('Unassign')}
          </button>
        </>
      }
    >
      <p>{t('{number} goes back to the unassigned pool, where a sales representative can claim it.', { number: lead.number })}</p>
      <FormField id="un-note" label={t('Note')} required error={noteError ? t('Enter a reason') : undefined}>
        <textarea
          id="un-note"
          className={noteError ? 'in err' : 'in'}
          rows={3}
          value={note}
          aria-invalid={noteError}
          aria-describedby={noteError ? 'un-note-err' : undefined}
          onChange={(e) => {
            setNote(e.target.value);
            setNoteError(false);
          }}
        />
      </FormField>
      {problem ? (
        <div className="note warn" role="alert">
          {problem}
        </div>
      ) : null}
    </Modal>
  );
}
