import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import { useCreateDraft, useDiscardDraft, useDraft, type DraftView } from '../../../api/drafts';
import { Icons } from '../../../components/Icons';
import type { SendFlowLead } from '../../../components/send/useSendFlow';
import { useToast } from '../../../components/Toast';
import { errorText } from '../../../i18n/labels';
import { useT, type TFn } from '../../../i18n/useT';
import { DraftComposer, type ComposerGuard, type SentInfo } from './DraftComposer';

export type ReplyKind = 'reply' | 'replyAll' | 'forward';

/**
 * What a draft reply opened again answers as (the CRM keeps no kind on the row): a forward by its forward prefix (`Fw:` from the
 * shared replySubject, `Fwd:`, or Outlook's Spanish `RV:` and French `TR:`), a reply all when it goes to more than one person, else a reply.
 */
export function draftKindOf(d: Pick<DraftView, 'subject' | 'to' | 'cc'>): ReplyKind {
  if (/^\s*(fwd?|rv|tr)\s*:/i.test(d.subject)) return 'forward';
  return d.to.length + d.cc.length > 1 ? 'replyAll' : 'reply';
}

/** The note left in the slot after a send (`followUp`: a follow-up task was asked; `lead`: the lead's number). */
function sentText(t: TFn, kind: ReplyKind, name: string, lead: string | undefined, followUp: boolean): string {
  if (kind === 'forward') {
    if (!lead) return t('Forwarded to {name} · it will appear here.', { name });
    return followUp
      ? t("Forwarded to {name} · follow-up task added · it will appear here and on {lead}'s timeline.", { name, lead })
      : t("Forwarded to {name} · it will appear here and on {lead}'s timeline.", { name, lead });
  }
  if (!lead) return t('Reply sent to {name} · it will appear here.', { name });
  return followUp
    ? t("Reply sent to {name} · follow-up task added · it will appear here and on {lead}'s timeline.", { name, lead })
    : t("Reply sent to {name} · it will appear here and on {lead}'s timeline.", { name, lead });
}

type Props = {
  /** The message answered (or forwarded). */
  originalId: number;
  /** How a new draft answers it; a draft opened again answers as it was written (draftKindOf). */
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
  /** The open composer's guarded close, for the screen to call before replacing it (see DraftComposer). */
  guard?: MutableRefObject<ComposerGuard | null>;
};

/**
 * Inline Reply / Reply all / Forward at the top of the conversation (mockup state 2): the reply draft is created in the
 * user's Outlook (recipients, subject and quote by the server), or the draft given is opened, then edited in the shared
 * DraftComposer. After a send the slot shows the `.sent-note`; Undo opens the editor again on the draft handed back;
 * Pop out continues on the full page (`/email/new?draft=<id>`).
 */
export function InlineReply({ originalId, kind, draftId, lead, onClose, onDraft, onSent, guard }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateDraft();
  const discard = useDiscardDraft();
  /** The draft edited (created, given, handed back by Undo, or made by `Save as a new draft`). */
  const [id, setId] = useState<number | null>(draftId ?? null);
  /** Opened again (Undo): a new composer, even for the same id. Save as a new draft keeps the composer. */
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
  /** How this editor answers: the kind asked for, or for a draft opened again the kind it was written as. */
  const opened = useRef<ReplyKind | null>(null);
  if (draftId === undefined) opened.current = kind;
  else if (opened.current === null && draft && draft.id === draftId) opened.current = draftKindOf(draft);
  const asKind = opened.current ?? kind;
  const answers = draft?.replyToId ?? originalId;

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
    latest.current.onDraft?.(sent ? null : id);
  }, [id, sent]);

  useEffect(() => {
    if (!isError) return;
    toast(t('This draft no longer exists. It may have been sent or deleted.'), 'warn');
    latest.current.onClose();
  }, [isError]);

  if (sent) {
    return (
      <div className="sent-note" role="status">
        <span className="ico" aria-hidden="true">{Icons.send}</span>
        {sentText(t, asKind, sent.to, lead?.number, sent.result.followUp !== null)}
      </div>
    );
  }

  if (!draft || draft.id !== id || (draftId !== undefined && opened.current === null)) {
    return (
      <div className="reply loading" role="status" aria-busy="true">
        {t('Loading…')}
      </div>
    );
  }

  const label = { reply: t('Reply'), replyAll: t('Reply all'), forward: t('Forward') }[asKind];
  return (
    <DraftComposer
      key={round}
      draft={draft}
      variant="inline"
      label={label}
      lead={lead}
      created={created}
      start={{ kind: asKind, replyToId: answers }}
      guard={guard}
      // The new draft is cached when made: the composer goes on with what it holds.
      onDraftId={(next) => setId(next)}
      onClose={(reason, info) => {
        if (reason === 'sent' && info) {
          setSent(info);
          latest.current.onSent?.(true);
          return;
        }
        if (reason === 'popout') navigate(`/email/new?draft=${id ?? draft.id}`);
        latest.current.onClose();
      }}
      onUndone={(d: DraftView) => {
        setCreated(false);
        setSent(null);
        setId(d.id);
        setRound((r) => r + 1);
        latest.current.onSent?.(false);
      }}
    />
  );
}
