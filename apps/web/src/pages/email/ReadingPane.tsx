import { useState, type MutableRefObject, type ReactNode } from 'react';
import { isClosedStatus } from '@dait-crm/shared';
import { useMailMessage, type MailDetail } from '../../api/mail';
import { Icons } from '../../components/Icons';
import { useFormatDate } from '../../hooks/useFormatDate';
import { firstName, initials, leadStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { InlineReply, type ReplyKind } from './compose/InlineReply';
import { ConversationMessage } from './ConversationMessage';
import type { CommandId, MailTarget, useMailCommands } from './useMailCommands';

type Commands = ReturnType<typeof useMailCommands>;
type ThreadEntry = MailDetail['thread'][number];

type Props = {
  id: number;
  /** Shown automatically (first message on arrival), not opened by the user: it stays unread. */
  peek?: boolean;
  /** Mail of: Everyone or one user (team view): the head names the mailbox. */
  teamView?: boolean;
  commands: Commands;
  /** The inline Reply / Reply all / Forward open at the top of the conversation (state 2), or none. */
  composing?: Composing | null;
  /** Opens (a draft reply: Continue editing) or closes the inline editor. */
  onCompose?: (c: Composing | null) => void;
  /** The slot now shows the sent note (true) or the editor again (false, after Undo). */
  onSent?: (sent: boolean) => void;
  /** The open composer's guarded close (see DraftComposer), set while it is open. */
  guard?: MutableRefObject<(() => Promise<boolean>) | null>;
};

/**
 * The inline editor of the reading pane: what it answers, how, the draft reply opened again (Continue editing), a
 * number telling one request from the next (a Reply after a send opens a fresh editor), and whether the slot shows the
 * sent note.
 */
export type Composing = { originalId: number; kind: ReplyKind; draftId?: number; seq: number; sent?: boolean };

/** The opened message as a conversation entry, when the answer carries no thread (a message on its own). */
const selfEntry = (m: MailDetail): ThreadEntry => ({
  id: m.id, occurredAt: m.occurredAt, direction: m.status === 'received' ? 'in' : 'out', who: '', subject: m.subject, kind: 'received', by: null,
  unmatched: false, fromName: m.fromName, fromAddress: m.fromAddress, toAddresses: m.toAddresses, ccAddresses: m.ccAddresses, preview: m.preview,
  hasAttachments: m.attachmentNames.length > 0, folder: m.folder, isRead: m.isRead,
});

/**
 * The reading pane (web-mail release 2, mockup "Reading pane", states 1 and 5). The head: the subject, the lead chip
 * `LD-xxxx · {stage}` (or "another owner's lead"), the company, `{n} messages`, and in team view whose mailbox it is.
 * Then release 1's view-only banner, and the conversation newest on top: the opened message expanded, the others
 * collapsed rows (avatar, sender, preview, date) that expand on a click, each read when expanded, and fold back on a
 * click on their sender. Under the opened message: Reply, Reply all, Forward, or in another user's mailbox the
 * view-only pill with Log as activity and Create task. A draft shows "Drafts are edited in Outlook." instead.
 */
export function ReadingPane({ id, peek = false, teamView = false, commands, composing = null, onCompose, onSent, guard }: Props) {
  const t = useT();
  const { dateTime } = useFormatDate();
  const { data: m, isError } = useMailMessage(id, peek);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  /** The draft the inline editor edits (its own row is left out of the conversation), and whether it shows the sent note. */
  const [editing, setEditing] = useState<number | null>(null);
  const sentNote = composing?.sent === true;
  const label = t('Reading pane');

  if (isError) return <section className="rpane empty" aria-label={label}>{t('This message is not available.')}</section>;
  if (!m) return <section className="rpane empty" aria-label={label}>{t('Loading…')}</section>;

  const viewOnly = m.viewOnly;
  const ownerFirst = firstName(m.owner.name);
  const thread = m.thread.some((e) => e.id === m.id) ? m.thread : [selfEntry(m), ...m.thread];
  const n = thread.length;
  const company = m.company?.name ?? m.leadPanel?.company?.name ?? m.restrictedLead?.companyName ?? null;
  const toggle = (entry: number, on: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (on) next.add(entry);
      else next.delete(entry);
      return next;
    });

  const target: MailTarget = { ids: [m.id], item: m };
  const button = (cmd: CommandId, icon: ReactNode, text: string) => {
    const s = commands.state(cmd, target);
    return (
      <button type="button" className="btn" disabled={!s.enabled} title={s.title} onClick={() => commands.run(cmd, target)}>
        <span className="ico" aria-hidden="true">{icon}</span>
        {text}
      </button>
    );
  };
  const footer = composing && !sentNote ? null : (
    <div className="msg-foot">
      {m.status === 'draft' ? (
        <span className="msg-note">{t('Drafts are edited in Outlook.')}</span>
      ) : viewOnly ? (
        <>
          <span className="vo-pill">
            {Icons.lock}
            {t("View only — {name}'s mailbox", { name: ownerFirst })}
          </span>
          {button('log', Icons.activity, t('Log as activity'))}
          {button('task', Icons.task, t('Create task'))}
        </>
      ) : (
        <>
          {button('reply', Icons.reply, t('Reply'))}
          {button('replyAll', Icons.replyall, t('Reply all'))}
          {button('forward', Icons.forward, t('Forward'))}
        </>
      )}
    </div>
  );

  return (
    <section className="rpane" aria-label={label}>
      <div className="rp-head">
        <h2>{m.subject || t('(no subject)')}</h2>
        <div className="rp-meta">
          {m.restrictedLead ? (
            <span className="lchip">{t("{lead} · another owner's lead", { lead: m.restrictedLead.number })}</span>
          ) : m.lead ? (
            <span className={`lchip st-${m.lead.status.replace(/\s+/g, '-')}`}>
              <i aria-hidden="true" />
              {`${m.lead.number} · ${leadStatusText(t, m.lead.status)}`}
            </span>
          ) : null}
          {company ? <span>{company}</span> : null}
          {company || m.lead || m.restrictedLead ? <span aria-hidden="true">·</span> : null}
          <span>{n === 1 ? t('1 message') : t('{n} messages', { n })}</span>
          {teamView ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{viewOnly ? t("{name}'s mailbox", { name: ownerFirst }) : t('Your mailbox')}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="rp-scroll">
        {viewOnly ? (
          <div className="viewonly">
            {Icons.lock}
            <span>
              <strong>{t("View only — {name}'s mailbox.", { name: ownerFirst })}</strong>{' '}
              {t('You can read, log and create tasks; only {name} can reply from this mailbox.', { name: ownerFirst })}
            </span>
          </div>
        ) : null}
        {composing && !viewOnly ? (
          <InlineReply
            key={composing.seq}
            originalId={composing.originalId}
            kind={composing.kind}
            draftId={composing.draftId}
            lead={m.lead ? { id: m.lead.id, number: m.lead.number, company: company ?? '', status: m.lead.status, open: !isClosedStatus(m.lead.status) } : null}
            onClose={() => {
              setEditing(null);
              onCompose?.(null);
            }}
            onDraft={setEditing}
            onSent={(v) => onSent?.(v)}
            guard={guard}
          />
        ) : null}
        {thread.map((e) => {
          if (e.id === m.id) return <ConversationMessage key={e.id} m={m} viewOnly={viewOnly} commands={commands} footer={footer} />;
          if (e.kind === 'draft' && e.id !== m.id) {
            if (e.id === editing || viewOnly) return null;
            return (
              <div key={e.id} className="msg col draft-row">
                <span className="av" aria-hidden="true"><span className="ico">{Icons.draft}</span></span>
                <span className="cprev">{t('Draft · {preview}', { preview: e.preview || t('(no text)') })}</span>
                <button type="button" className="btn sm" onClick={() => onCompose?.({ originalId: m.id, kind: 'reply', draftId: e.id, seq: 0 })}>
                  {t('Continue editing')}
                </button>
              </div>
            );
          }
          if (expanded.has(e.id)) return <OtherMessage key={e.id} entry={e} viewOnly={viewOnly} commands={commands} onCollapse={() => toggle(e.id, false)} />;
          const sender = e.fromName || e.fromAddress;
          return (
            <button key={e.id} type="button" className="msg col" aria-expanded="false" onClick={() => toggle(e.id, true)}>
              <span className="av" aria-hidden="true">{initials(sender)}</span>
              <span className="cfrom">{sender}</span>
              <span className="cprev">{e.preview}</span>
              <span className="cdate">{dateTime(e.occurredAt)}</span>
              <span className="ico" aria-hidden="true">{Icons.down}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** An older message of the conversation, expanded: read in full (and marked read, as opening it would) when expanded. */
function OtherMessage({ entry, viewOnly, commands, onCollapse }: { entry: ThreadEntry; viewOnly: boolean; commands: Commands; onCollapse: () => void }) {
  const t = useT();
  const { data: m, isError } = useMailMessage(entry.id);
  if (m) return <ConversationMessage m={m} viewOnly={viewOnly} commands={commands} onCollapse={onCollapse} />;
  return (
    <button type="button" className="msg col" aria-expanded="true" aria-busy={!isError} onClick={onCollapse}>
      <span className="av" aria-hidden="true">{initials(entry.fromName || entry.fromAddress)}</span>
      <span className="cfrom">{entry.fromName || entry.fromAddress}</span>
      <span className="cprev">{isError ? t('This message is not available.') : t('Loading…')}</span>
    </button>
  );
}
