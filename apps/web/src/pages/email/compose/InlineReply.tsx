import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import { useCreateDraft, useDiscardDraft, useDraft, type DraftView } from '../../../api/drafts';
import { Icons } from '../../../components/Icons';
import type { SendFlowLead } from '../../../components/send/useSendFlow';
import { useToast } from '../../../components/Toast';
import { errorText } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';
import { DraftComposer, type SentInfo } from './DraftComposer';

export type ReplyKind = 'reply' | 'replyAll' | 'forward';

type Props = {
  /** The message answered (or forwarded). */
  originalId: number;
  kind: ReplyKind;
  /** A draft reply of the conversation opened again (Continue editing); none: a new draft is created. */
  draftId?: number;
  /** The conversation's lead as the reading pane knows it (null: none, or not visible). */
  lead: SendFlowLead | null;
  /** The editor closed (discarded, or popped out): the slot empties. */
  onClose(): void;
  /** The draft now edited (for the conversation to leave out its own row), null when none. */
  onDraft?(id: number | null): void;
  /** The slot shows the sent note (true) or the editor (false). */
  onSent?(sent: boolean): void;
};

/**
 * Inline Reply / Reply all / Forward at the top of the conversation (mockup state 2): the reply draft is created in the
 * user's Outlook (recipients, subject and quote by the server), or the draft given is opened, then edited in the shared
 * DraftComposer. After a send the slot shows the `.sent-note`; Undo opens the editor again on the draft handed back;
 * Pop out continues on the full page (`/email/new?draft=<id>`).
 */
export function InlineReply({ originalId, kind, draftId, lead, onClose, onDraft, onSent }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateDraft();
  const discard = useDiscardDraft();
  /** The draft the editor opens (created, given, or handed back by Undo). */
  const [id, setId] = useState<number | null>(draftId ?? null);
  /** The draft the editor now edits (another after `Save as a new draft`). */
  const [current, setCurrent] = useState<number | null>(draftId ?? null);
  /** Opened again (Undo): a new composer, even for the same id. */
  const [round, setRound] = useState(0);
  const [created, setCreated] = useState(false);
  const [sent, setSent] = useState<SentInfo | null>(null);
  const { data: draft, isError } = useDraft(sent ? null : id);
  const started = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({ onClose, onDraft, onSent });
  latest.current = { onClose, onDraft, onSent };
  const discardMutate = useRef(discard.mutate);
  discardMutate.current = discard.mutate;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A new reply: the draft is made once (the development double mount keeps the ref).
  useEffect(() => {
    if (draftId !== undefined || started.current) return;
    started.current = true;
    create.mutateAsync({ kind, replyToId: originalId }).then(
      (v) => {
        // Gone before Outlook answered: the untouched draft goes too.
        setTimeout(() => {
          if (!mounted.current) {
            discardMutate.current(v.id);
            return;
          }
          setCreated(true);
          setId(v.id);
          setCurrent(v.id);
        }, 0);
      },
      (err: unknown) => {
        toast(errorText(t, err instanceof ApiError ? err.code : 'try_again', {}, { context: 'draft' }), 'warn');
        if (mounted.current) latest.current.onClose();
      },
    );
    // Once per editor.
  }, []);

  useEffect(() => {
    latest.current.onDraft?.(sent ? null : current);
  }, [current, sent]);

  useEffect(() => {
    if (!isError) return;
    toast(t('This draft no longer exists. It may have been sent or deleted.'), 'warn');
    latest.current.onClose();
  }, [isError]);

  if (sent) {
    const leadNumber = lead?.number;
    const followUp = sent.result.followUp !== null;
    const text = leadNumber
      ? followUp
        ? t("Reply sent to {name} · follow-up task added · it will appear here and on {lead}'s timeline.", { name: sent.to, lead: leadNumber })
        : t("Reply sent to {name} · it will appear here and on {lead}'s timeline.", { name: sent.to, lead: leadNumber })
      : t('Reply sent to {name} · it will appear here.', { name: sent.to });
    return (
      <div className="sent-note" role="status">
        <span className="ico" aria-hidden="true">{Icons.send}</span>
        {text}
      </div>
    );
  }

  const label = { reply: t('Reply'), replyAll: t('Reply all'), forward: t('Forward') }[kind];
  if (!draft || draft.id !== id) {
    return (
      <div className="reply loading" role="status" aria-busy="true">
        {t('Loading…')}
      </div>
    );
  }

  return (
    <DraftComposer
      key={`${draft.id}-${round}`}
      draft={draft}
      variant="inline"
      label={label}
      lead={lead}
      created={created}
      start={{ kind, replyToId: originalId }}
      onDraftId={(next) => setCurrent(next)}
      onClose={(reason, info) => {
        if (reason === 'sent' && info) {
          setSent(info);
          latest.current.onSent?.(true);
          return;
        }
        if (reason === 'popout') navigate(`/email/new?draft=${current ?? draft.id}`);
        latest.current.onClose();
      }}
      onUndone={(d: DraftView) => {
        setCreated(false);
        setSent(null);
        setId(d.id);
        setCurrent(d.id);
        setRound((r) => r + 1);
        latest.current.onSent?.(false);
      }}
    />
  );
}
