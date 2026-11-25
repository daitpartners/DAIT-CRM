import { useState } from 'react';
import type { LeadDeletePreview } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useDeleteLeads, useDeleteLeadsPreview } from '../../api/leads';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';

type Keep = LeadDeletePreview['keep'][number];

/** The word the Administrator types to confirm (the same in every language, as the server checks it). */
export const DELETE_WORD = 'delete';
/** Records listed by name; more than this reads "and {n} more". */
const LISTED = 8;

/** Why a record stays, in words. */
export function deleteReasonText(t: TFn, k: Pick<Keep, 'kind' | 'reason'>): string {
  switch (k.reason) {
    case 'quotations':
      return k.kind === 'lead' ? t('Has a sent quotation') : t('Has quotations');
    case 'projects':
      return t('Has projects');
    case 'other_leads':
      return k.kind === 'contact' ? t('Used by another lead') : t('Has other leads');
    case 'contact_in_use':
      return t('Has contacts used elsewhere');
    default:
      return t('Changed since this list was made');
  }
}

/** The counts the dialog shows ("1 lead", "3 companies"…). */
function removeCounts(t: TFn, r: LeadDeletePreview['remove']) {
  return {
    leads: r.leads.length === 1 ? t('1 lead') : t('{n} leads', { n: r.leads.length }),
    companies: r.companies.length === 1 ? t('1 company') : t('{n} companies', { n: r.companies.length }),
    contacts: r.contacts === 1 ? t('1 contact') : t('{n} contacts', { n: r.contacts }),
    drafts: r.draftQuotations === 0 ? ''
      : r.draftQuotations === 1 ? t('1 draft quotation goes too.') : t('{n} draft quotations go too.', { n: r.draftQuotations }),
  };
}

function Names({ items }: { items: string[] }) {
  const t = useT();
  if (items.length === 0) return null;
  const shown = items.slice(0, LISTED);
  return (
    <ul className="rules">
      {shown.map((label) => (
        <li key={label}>{label}</li>
      ))}
      {items.length > LISTED ? <li className="dim">{t('and {n} more', { n: items.length - LISTED })}</li> : null}
    </ul>
  );
}

/**
 * Delete leads, Administrators only (owner, 25 Nov 2026): the server's preview first, in the style of the Data manager's
 * Undo (what is removed, what is kept and why; emails and calendar events are only unlinked), then the Administrator
 * types "delete" and confirms. The server plans again and may remove less if something changed meanwhile.
 * `onArchiveInstead` offers Archive for a lead that cannot be deleted (the lead page).
 */
export function DeleteLeadsModal({ ids, onClose, onDeleted, onArchiveInstead }: {
  ids: number[];
  onClose: () => void;
  onDeleted: (done: LeadDeletePreview) => void;
  onArchiveInstead?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const preview = useDeleteLeadsPreview(ids);
  const del = useDeleteLeads();
  const [word, setWord] = useState('');
  const [error, setError] = useState<string | null>(null);
  const p = preview.data;
  const nothing = !!p && p.plan.leads.length === 0;
  const blocked = p?.keep.filter((k) => k.kind === 'lead') ?? [];
  const typed = word.trim() === DELETE_WORD;
  const counts = p ? removeCounts(t, p.remove) : null;
  const previewError = preview.error ? errorText(t, preview.error instanceof ApiError ? preview.error.code : 'unknown') : null;

  function confirm() {
    if (!p || !typed) return;
    setError(null);
    del.mutate(
      { ids, plan: p.plan },
      {
        onSuccess: (done) => {
          const n = done.remove.leads.length;
          toast(n === 1 ? t('Lead deleted') : t('{n} leads deleted', { n }));
          const less = n < p.plan.leads.length || done.remove.companies.length < p.plan.companies.length || done.remove.contacts < p.plan.contacts.length;
          if (less) toast(t('Some records changed since the preview and were kept.'), 'warn');
          onDeleted(done);
        },
        onError: (e) => {
          const code = e instanceof ApiError ? e.code : 'unknown';
          setError(code === 'try_again'
            ? t('Someone was changing these records at the same moment. Nothing was deleted. Try again.')
            : errorText(t, code));
          void preview.refetch();
        },
      },
    );
  }

  return (
    <Modal
      title={ids.length === 1 ? t('Delete lead?') : t('Delete {n} leads?', { n: ids.length })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          {onArchiveInstead && blocked.length > 0 ? (
            <button type="button" className="btn" onClick={onArchiveInstead}>
              {t('Archive instead')}
            </button>
          ) : null}
          <button type="button" className="btn danger" disabled={!p || nothing || !typed || del.isPending || preview.isFetching} onClick={confirm}>
            {t('Delete permanently')}
          </button>
        </>
      }
    >
      {preview.isPending ? <p className="muted-text">{t('Checking what would be removed…')}</p> : null}
      {p ? (
        <>
          {nothing ? (
            <p>{t('Nothing can be deleted.')}</p>
          ) : (
            <>
              <p>
                {t('Will be removed for good: {leads} with their notes, tasks and timeline, {companies}, {contacts}.', counts!)}
                {counts!.drafts ? ` ${counts!.drafts}` : null}
              </p>
              <Names items={[...p.remove.leads.map((l) => `${l.number} · ${l.companyName}`), ...p.remove.companies.map((c) => `${c.number} · ${c.name}`)]} />
            </>
          )}
          {p.keep.length > 0 ? (
            <>
              <p>{t('Kept:')}</p>
              <ul className="rules">
                {p.keep.slice(0, LISTED * 2).map((k) => (
                  <li key={`${k.kind}-${k.id}`}>
                    {k.label} — {deleteReasonText(t, k)}
                  </li>
                ))}
                {p.keep.length > LISTED * 2 ? <li className="dim">{t('and {n} more', { n: p.keep.length - LISTED * 2 })}</li> : null}
              </ul>
            </>
          ) : null}
          {blocked.length > 0 ? (
            <div className="note warn">{t('A lead with a sent quotation or a project cannot be deleted. Archive it instead.')}</div>
          ) : null}
          <p className="muted-text">{t('Emails and calendar events are not deleted: they stay in their owners’ mailboxes and calendars, no longer linked.')}</p>
          {!nothing ? (
            <FormField id="del-word" label={t('Type "delete" to confirm')}>
              <input
                id="del-word"
                className="in"
                autoComplete="off"
                spellCheck={false}
                value={word}
                onChange={(e) => setWord(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirm();
                }}
              />
            </FormField>
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
