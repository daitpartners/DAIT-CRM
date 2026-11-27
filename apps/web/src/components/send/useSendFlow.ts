import { createElement, useRef, useState, type ReactNode } from 'react';
import { localNow, type SendFollowUp } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useSendDraft, type DraftFields, type DraftView, type FlushResult, type SendResult } from '../../api/drafts';
import { useCurrentUser } from '../../api/useCurrentUser';
import { errorText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { whenShort } from '../../pages/email/sendDates';
import { useToast } from '../Toast';
import { FollowUpDialog } from './FollowUpDialog';
import { useUndoSend } from './UndoSend';

export type SendFlowLead = { id: number; number: string; company: string; status: string; open: boolean };

export type SendFlowOptions = {
  /** The draft's id (an editor may create the draft first). */
  draftId: () => Promise<number>;
  /** The draft as the editor holds it, read at the moment of sending. */
  fields: () => DraftFields;
  /** The editor's auto-save flush (useAutoSave): awaited first, a failure stops the send and is said. */
  flush?: () => Promise<FlushResult>;
  /** The draft's lead: open and visible to the sender → the follow-up box first (decision 5); else a plain send. */
  lead: SendFlowLead | null;
  /** Who the follow-up is with (the box's question). */
  who: string;
  subject: string;
  onSent(r: SendResult): void;
  /** Undo gave the draft back: the screen opens it again. */
  onUndone(d: DraftView): void;
};

/**
 * Refusals after which the follow-up box cannot help (the draft is gone, sent, someone else's, the mailbox is gone or
 * the session ended): the box closes and a toast says why. Any other refusal (a follow-up time, a field, a passing
 * failure) keeps the box open with what was entered and the reason inside it, to send again.
 */
const ENDS_THE_BOX = new Set([
  'draft_gone', 'already_sent', 'not_draft', 'mailbox_changed', 'view_only', 'not_found', 'forbidden', 'no_mailbox',
  'mailbox_not_connected', 'mailbox_needs_reconnect', 'unauthenticated',
]);

/** The code of a failed request (a network failure reads as try_again). */
const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : 'try_again');

/**
 * The one send flow for every screen (web-mail release 3): `send()` sends now, `schedule(at)` at `at`. The editor's
 * unsaved changes are saved first; with an open lead the "Set the next follow-up" box (`dialog`, to be rendered) comes
 * next, its presets counted from today or, for a scheduled send, from the scheduled day (decision 4); then the draft is
 * sent. A send now shows the Undo toast; a scheduled one the toast `Scheduled for {when}`. Failures are toasts in the
 * editor's words. `busy` while a send is being made.
 */
export function useSendFlow(opts: SendFlowOptions): { send(): void; schedule(at: Date): void; dialog: ReactNode; busy: boolean } {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const toast = useToast();
  const undo = useUndoSend();
  const sendDraft = useSendDraft();
  const latest = useRef(opts);
  latest.current = opts;
  const [box, setBox] = useState<{ at: Date | null; baseDay: string; error: string | null } | null>(null);
  const [working, setWorking] = useState(false);
  const busy = working || sendDraft.isPending;
  /** Set from the first click to the end of that step: a second click before the screen catches up does nothing. */
  const inFlight = useRef(false);

  const fail = (code: string) => toast(errorText(t, code, {}, { context: 'draft' }), 'warn');

  async function post(at: Date | null, followUp: SendFollowUp | null) {
    if (inFlight.current) return;
    inFlight.current = true;
    const o = latest.current;
    setWorking(true);
    setBox((b) => (b ? { ...b, error: null } : b));
    try {
      const id = await o.draftId();
      const r = await sendDraft.mutateAsync({ id, fields: o.fields(), at: at ? at.toISOString() : null, followUp });
      setBox(null);
      o.onSent(r);
      if (r.undoUntil) {
        undo.show({ messageId: r.id, until: r.undoUntil, followUp: r.followUp, onUndone: (d) => latest.current.onUndone(d) });
      } else {
        const local = localNow(me.timezone, new Date(r.sendAt));
        toast(t('Scheduled for {when}', { when: whenShort(local.day, local.time, me.timezone, lang) }));
      }
    } catch (err) {
      const code = codeOf(err);
      if (box && !ENDS_THE_BOX.has(code)) {
        setBox((b) => (b ? { ...b, error: errorText(t, code, {}, { context: 'draft' }) } : b));
      } else {
        setBox(null);
        fail(code);
      }
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }

  async function start(at: Date | null) {
    if (inFlight.current || box) return;
    const o = latest.current;
    if (o.flush) {
      inFlight.current = true;
      setWorking(true);
      const saved = await o.flush();
      inFlight.current = false;
      setWorking(false);
      if (!saved.ok) {
        fail(saved.code);
        return;
      }
    }
    if (o.lead?.open) setBox({ at, baseDay: localNow(me.timezone, at ?? new Date()).day, error: null });
    else await post(at, null);
  }

  const lead = opts.lead;
  const dialog = box && lead
    ? createElement(FollowUpDialog, {
      lead: { number: lead.number, company: lead.company, status: lead.status },
      who: opts.who,
      subject: opts.subject,
      baseDay: box.baseDay,
      sendAt: box.at ?? undefined,
      busy,
      error: box.error,
      onSend: (followUp: SendFollowUp | null) => void post(box.at, followUp),
      onCancel: () => setBox(null),
    })
    : null;

  return { send: () => void start(null), schedule: (at: Date) => void start(at), dialog, busy };
}
