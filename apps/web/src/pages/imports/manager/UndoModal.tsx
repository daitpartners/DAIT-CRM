import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { undoReasonText } from '@dait-crm/shared';
import { ApiError } from '../../../api/client';
import { importKeys, useUndo, useUndoPreview } from '../../../api/imports';
import { Modal } from '../../../components/Modal';
import { useToast } from '../../../components/Toast';
import { useLang, useT, type TFn } from '../../../i18n/useT';
import { importErrorText } from '../labels';

/** "2 leads", "1 contact", "3 companies". */
export function undoCounts(t: TFn, r: { leads: number; contacts: number; companies: number }) {
  return {
    leads: r.leads === 1 ? t('1 lead') : t('{n} leads', { n: r.leads }),
    contacts: r.contacts === 1 ? t('1 contact') : t('{n} contacts', { n: r.contacts }),
    companies: r.companies === 1 ? t('1 company') : t('{n} companies', { n: r.companies }),
  };
}

/** Undo refusals: the batch moved on (`batch_locked`), or a concurrent edit (`try_again`, nothing changed). */
function undoErrorText(t: TFn, code: string): string {
  if (code === 'batch_locked') return t('This import can no longer be undone. Reload to see its status.');
  return importErrorText(t, code);
}

/**
 * Undo, Administrators only (mockup copy): the server's preview first (what is removed, what is kept and why, which
 * existing companies get their values back), then "Undo import" removes it. Escape, Cancel or the backdrop close it.
 */
export function UndoModal({ batch, onClose }: { batch: { id: number; number: string }; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const toast = useToast();
  const qc = useQueryClient();
  const preview = useUndoPreview(batch.id);
  const undo = useUndo(batch.id);
  const [error, setError] = useState<string | null>(null);
  const p = preview.data;
  const previewError = preview.error ? undoErrorText(t, preview.error instanceof ApiError ? preview.error.code : '') : null;

  function confirm() {
    setError(null);
    undo.mutate(undefined, {
      onSuccess: () => {
        toast(t('Import undone'));
        onClose();
      },
      onError: (e) => {
        const code = e instanceof ApiError ? e.code : '';
        setError(undoErrorText(t, code));
        // A concurrent edit: show what Undo would do now. The batch moved on: refresh it (its Undo button goes).
        if (code === 'try_again') void preview.refetch();
        if (code === 'batch_locked') void qc.invalidateQueries({ queryKey: importKeys.batch(batch.id) });
      },
    });
  }

  const counts = p ? undoCounts(t, { leads: p.remove.leads.length, contacts: p.remove.contacts, companies: p.remove.companies }) : null;
  return (
    <Modal
      title={t('Undo {number}?', { number: batch.number })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn danger" disabled={!p || undo.isPending} onClick={confirm}>
            {t('Undo import')}
          </button>
        </>
      }
    >
      {preview.isPending ? <p className="muted-text">{t('Checking what Undo would remove…')}</p> : null}
      {p && counts ? (
        <>
          <p>{t('Will be removed: {leads}, {contacts}, {companies}.', counts)}</p>
          {p.keep.length > 0 ? (
            <>
              <p>{t('Kept because someone worked on them:')}</p>
              <ul className="rules">
                {p.keep.map((k) => (
                  <li key={`${k.kind}-${k.id}`}>
                    {k.label} — {undoReasonText(k.reason, lang)}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted-text">{t('Nobody has worked on these records yet, so nothing is kept.')}</p>
          )}
          {p.reverted?.length ? (
            <>
              <p>{t('Research values the import accepted go back on these companies that were already in the CRM:')}</p>
              <ul className="rules">
                {p.reverted.map((c) => (
                  <li key={c.id}>{c.label}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
      {previewError || error ? (
        <div className="note danger" role="alert">
          {error ?? previewError}
        </div>
      ) : null}
    </Modal>
  );
}
