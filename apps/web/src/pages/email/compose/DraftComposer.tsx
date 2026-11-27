import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { isClosedStatus, localNow } from '@dait-crm/shared';
import { ApiError, api } from '../../../api/client';
import {
  useApplyTemplateFiles, useAutoSave, useCreateDraft, useDiscardDraft, useDraftFile,
  type DraftFields, type DraftFileView, type DraftStart, type DraftView, type SendResult,
} from '../../../api/drafts';
import { useLead } from '../../../api/leads';
import { useSignature } from '../../../api/signature';
import { useTemplates, type EmailTemplate } from '../../../api/templates';
import { useCurrentUser } from '../../../api/useCurrentUser';
import { Icons } from '../../../components/Icons';
import { MessageEditor, type MessageValue } from '../../../components/MessageEditor';
import { SendButton } from '../../../components/send/SendButton';
import { useSendFlow, type SendFlowLead } from '../../../components/send/useSendFlow';
import { useToast } from '../../../components/Toast';
import { errorText, firstName } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';
import { fillTemplate, fillTemplateHtml } from '../../../lib/mergeFields';
import { textToEditorHtml, toEditorHtml, toSendHtml } from '../../../lib/richText';
import { Menu, type MenuEntry } from '../menus';
import { FileChips } from './FileChips';
import { QuotedText } from './QuotedText';
import { RecipientField } from './RecipientField';

/** What a send left for the screen: the queued send, and who it went to (the first To recipient's name). */
export type SentInfo = { result: SendResult; to: string };

type Props = {
  draft: DraftView;
  variant: 'inline' | 'page';
  /** The form's name (Reply, Reply all, Forward, New message). */
  label: string;
  onClose(reason: 'sent' | 'discarded' | 'popout', sent?: SentInfo): void;
  /** Undo gave the draft back after a send: the screen opens it again. */
  onUndone?(d: DraftView): void;
  /** The page's own rows, after Bcc (and Subject). */
  header?: ReactNode;
  /** The draft's lead as the screen knows it (null: none, or not visible); read from the draft's lead when not given. */
  lead?: SendFlowLead | null;
  /** The screen has just created this draft: closing it untouched discards it (plan decision 11). */
  created?: boolean;
  /** How `Save as a new draft` starts one (a reply again, for a reply); a new message with the draft's lead otherwise. */
  start?: DraftStart;
  /** The draft id now edited (it changes after `Save as a new draft`). */
  onDraftId?(id: number): void;
  /**
   * Set while the composer is open: the screen calls it before replacing the editor (another message, another reply,
   * Continue editing). It saves what the editor holds and answers true, or shows why the save failed and answers false
   * (the screen then keeps the editor where it is).
   */
  guard?: MutableRefObject<(() => Promise<boolean>) | null>;
};

/** Codes saying the draft itself is gone: discarding then just closes. */
const GONE = new Set(['draft_gone', 'not_found', 'not_draft']);
const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : 'try_again');
const referenced = (html: string, cid: string) => html.includes(`cid:${cid}`) || html.includes(`data-cid="${cid}"`);

/** The user's own signature block in `html` (the first `.dait-sig`), as HTML; '' for none. */
function signatureOf(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content.querySelector('.dait-sig')?.outerHTML ?? '';
}

/**
 * The shared writing body of web mail (inline Reply / Reply all / Forward, mockup state 2; the full page, state 3): the
 * `.rtop` row (Send ▾, Discard, `Draft saved hh:mm` or `Saving…`, inline the Pop out button), To with the Cc and Bcc
 * links, Cc and Bcc (shown when not empty), the page's rows, the mail toolbar and message (signature button from the
 * user's signature), the folded quote, and the file chips. It auto-saves the draft to the user's Outlook, uploads
 * pictures and files straight onto the draft (a picture deleted from the message is taken off it too), fills a template
 * (subject when empty, the message from the draft's lead, then the template's files) and sends through the one send flow.
 * Closing (Discard, Pop out) saves first and stays open when that fails. A draft the screen just created and the user
 * never touched is discarded when the composer goes; a touched one is saved once more and stays in Drafts.
 */
export function DraftComposer({ draft, variant, label, onClose, onUndone, header, lead, created = false, start, onDraftId, guard }: Props) {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const { data: signature } = useSignature();
  const { data: templates } = useTemplates();
  const create = useCreateDraft();
  const discardDraft = useDiscardDraft();
  const [id, setId] = useState(draft.id);
  const fileApi = useDraftFile(id);
  const applyFiles = useApplyTemplateFiles(id);
  const known = useMemo(() => [...draft.to, ...draft.cc, ...draft.bcc], [draft]);
  const [to, setTo] = useState(() => draft.to.map((r) => r.address));
  const [cc, setCc] = useState(() => draft.cc.map((r) => r.address));
  const [bcc, setBcc] = useState(() => draft.bcc.map((r) => r.address));
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState<MessageValue>(() => ({ text: '', html: toEditorHtml(draft.bodyHtml, draft.files) }));
  const [files, setFiles] = useState<DraftFileView[]>(draft.files);
  const [rows, setRows] = useState<{ cc: boolean; bcc: boolean; focus: 'cc' | 'bcc' | null }>({ cc: draft.cc.length > 0, bcc: draft.bcc.length > 0, focus: null });
  const [problem, setProblem] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [templatesAt, setTemplatesAt] = useState<{ x: number; y: number } | null>(null);

  const sendHtml = useMemo(() => toSendHtml(body.html ?? ''), [body.html]);
  const fields: DraftFields = { to, cc, bcc, subject, bodyHtml: sendHtml, leadId: draft.leadId, projectId: draft.projectId };
  const auto = useAutoSave(id, fields, { enabled: true });

  // What the timers and the unmount read: the latest of everything.
  const latest = useRef({ id, fields, files });
  latest.current = { id, fields, files };
  const touched = useRef(false);
  /** Sent, discarded or popped out: nothing more happens when the composer goes. */
  const closed = useRef(false);
  const removing = useRef(new Set<string>());
  /** The files the last template put on the draft (the next template replaces them). */
  const templateFiles = useRef(new Set<string>());
  const touch = () => {
    touched.current = true;
  };

  // Leaving. The screen's own switches go through `guard` first (saved, or kept open). What is left here: a
  // just-created draft never touched is discarded; a change still unsaved when the composer goes some other way (the
  // route changed) gets a last-resort save, and its failure is said. Deferred a tick, so the development double mount
  // does not count as leaving.
  const mounted = useRef(true);
  const discardMutate = useRef(discardDraft.mutate);
  discardMutate.current = discardDraft.mutate;
  const pending = useRef(auto.pending);
  pending.current = auto.pending;
  const say = useRef((code: string) => toast(errorText(t, code, {}, { context: 'draft' }), 'warn'));
  say.current = (code: string) => toast(errorText(t, code, {}, { context: 'draft' }), 'warn');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (mounted.current || closed.current) return;
        const { id: draftId, fields: last } = latest.current;
        if (!touched.current) {
          if (created) discardMutate.current(draftId);
        } else if (pending.current()) {
          void api(`/api/mail/drafts/${draftId}`, { method: 'PATCH', body: last }).catch((err: unknown) => say.current(codeOf(err)));
        }
      }, 0);
    };
    // Once, for the composer's life.
  }, []);

  // The lead for the follow-up box: the screen's, else read from the draft's (visible) lead.
  const readLead = lead === undefined && draft.lead !== null && draft.leadId !== null;
  const { data: full } = useLead(readLead ? draft.leadId! : NaN);
  const flowLead: SendFlowLead | null = lead !== undefined
    ? lead
    : readLead && full
      ? { id: full.id, number: full.number, company: full.companyName, status: full.status, open: !full.archivedAt && !isClosedStatus(full.status) }
      : null;
  const nameOf = (address: string | undefined) => (address ? known.find((r) => r.address.toLowerCase() === address.toLowerCase())?.name || address : '');
  const who = draft.lead?.contact?.name || nameOf(to[0]);

  const flow = useSendFlow({
    draftId: async () => latest.current.id,
    fields: () => latest.current.fields,
    flush: auto.flush,
    lead: flowLead,
    who,
    subject,
    onSent: (result) => {
      closed.current = true;
      onClose('sent', { result, to: nameOf(latest.current.fields.to[0]) });
    },
    onUndone: (d) => onUndone?.(d),
  });

  const fileFailed = (err: unknown) => toast(errorText(t, codeOf(err), {}, { context: 'draft' }), 'warn');

  async function onPicture(file: File): Promise<{ contentId: string; dataUrl: string } | null> {
    try {
      const f = await fileApi.add(file, true);
      touch();
      setFiles((fs) => [...fs, f]);
      return f.contentId && f.dataUrl ? { contentId: f.contentId, dataUrl: f.dataUrl } : null;
    } catch (err) {
      fileFailed(err);
      return null;
    }
  }

  async function onAttach(list: File[]) {
    for (const file of list) {
      try {
        const f = await fileApi.add(file, false);
        touch();
        setFiles((fs) => [...fs, f]);
      } catch (err) {
        fileFailed(err);
      }
    }
  }

  function removeFile(fileId: string) {
    touch();
    fileApi.remove(fileId).then(() => setFiles((fs) => fs.filter((f) => f.id !== fileId))).catch(fileFailed);
  }

  /** A change in the message; an inline picture no longer in it (nor in the quote) is taken off the draft. */
  function onBody(v: MessageValue) {
    touch();
    setBody(v);
    const html = `${v.html ?? ''}${draft.quotedHtml ?? ''}`;
    for (const f of latest.current.files) {
      if (!f.inline || !f.contentId || referenced(html, f.contentId) || removing.current.has(f.id)) continue;
      removing.current.add(f.id);
      fileApi.remove(f.id)
        .then(() => setFiles((fs) => fs.filter((x) => x.id !== f.id)))
        .catch(() => removing.current.delete(f.id));
    }
  }

  async function applyTemplate(tp: EmailTemplate) {
    touch();
    const ctx = {
      firstName: firstName(draft.lead?.contact?.name || nameOf(to[0]) || ''),
      company: draft.lead?.company?.name ?? flowLead?.company ?? '',
      me: me.name,
      leadNumber: flowLead?.number ?? '',
    };
    if (!subject.trim()) setSubject(fillTemplate(tp.subject, ctx));
    const filled = tp.bodyHtml ? fillTemplateHtml(tp.bodyHtml, ctx) : textToEditorHtml(fillTemplate(tp.body, ctx));
    const sig = signatureOf(body.html ?? '');
    let added: DraftFileView[] = [];
    try {
      added = await applyFiles.mutateAsync({ templateId: tp.id, attachmentIds: tp.attachments.filter((a) => !a.inline).map((a) => a.id) });
      const before = templateFiles.current;
      templateFiles.current = new Set(added.map((f) => f.id));
      setFiles((fs) => [...fs.filter((f) => !before.has(f.id)), ...added]);
    } catch (err) {
      fileFailed(err);
    }
    setBody({ text: '', html: `${toEditorHtml(filled, added)}${sig ? `<p><br></p>${sig}` : ''}` });
  }

  /** Closing for `reason` once everything is saved; a failed save keeps the editor open and says why. */
  async function closeAfterSave(reason: 'discarded' | 'popout') {
    if (closing) return;
    setClosing(true);
    setProblem(null);
    const saved = await auto.flush();
    if (!saved.ok && !(reason === 'discarded' && GONE.has(saved.code))) {
      setProblem(saved.code);
      setClosing(false);
      return;
    }
    if (reason === 'discarded') {
      try {
        await discardDraft.mutateAsync(latest.current.id);
      } catch (err) {
        const code = codeOf(err);
        if (!GONE.has(code)) {
          setProblem(code);
          setClosing(false);
          return;
        }
      }
    }
    closed.current = true;
    onClose(reason);
  }

  /** Before the screen replaces the editor: everything saved (true), or the failure shown and the editor kept (false). */
  async function release(): Promise<boolean> {
    if (closing) return false;
    setProblem(null);
    const saved = await auto.flush();
    if (saved.ok) return true;
    setProblem(saved.code);
    return false;
  }
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    if (!guard) return;
    const fn = () => releaseRef.current();
    guard.current = fn;
    return () => {
      if (guard.current === fn) guard.current = null;
    };
  }, [guard]);

  /** The draft was removed in Outlook: a new one with what the editor holds (a reply again, for a reply). */
  async function saveAsNew() {
    const s: DraftStart = start ?? { kind: 'new', ...(draft.leadId ? { leadId: draft.leadId } : {}), ...(draft.projectId ? { projectId: draft.projectId } : {}) };
    setClosing(true);
    try {
      const v = await create.mutateAsync(s);
      await api(`/api/mail/drafts/${v.id}`, { method: 'PATCH', body: latest.current.fields });
      templateFiles.current = new Set();
      removing.current = new Set();
      setFiles(v.files);
      setProblem(null);
      setId(v.id);
      onDraftId?.(v.id);
    } catch (err) {
      toast(errorText(t, codeOf(err), {}, { context: 'draft' }), 'warn');
    } finally {
      setClosing(false);
    }
  }

  const error = problem ?? auto.error;
  const savedAt = auto.savedAt ?? draft.savedAt;
  const savedTime = localNow(me.timezone, new Date(savedAt)).time;
  const busy = closing || flow.busy;
  const sorted = [...(templates ?? [])].sort((a, b) => Number(b.language === me.language) - Number(a.language === me.language));
  const templateItems: MenuEntry[] = sorted.length
    ? sorted.map((tp) => ({
      key: `tp${tp.id}`, label: tp.name, icon: Icons.template, title: tp.subject, hint: tp.sourceType === 'oft' ? '.oft' : undefined,
      onSelect: () => void applyTemplate(tp),
    }))
    : [{ kind: 'note', key: 'none', label: t('No templates yet.') }];

  return (
    <form className={variant === 'inline' ? 'reply' : 'reply page'} aria-label={label} onSubmit={(e) => e.preventDefault()}>
      <div className="rtop">
        <SendButton
          onSend={flow.send}
          onSchedule={flow.schedule}
          options={variant === 'inline' ? 'menu' : 'popover'}
          disabled={busy}
          recipientZone={draft.recipientZone}
        />
        <button type="button" className="btn sm" disabled={busy} onClick={() => void closeAfterSave('discarded')}>
          <span className="ico" aria-hidden="true">{Icons.trash}</span>
          {t('Discard')}
        </button>
        <span className="draft" role="status">
          {auto.saving ? t('Saving…') : (
            <>
              <span className="ico" aria-hidden="true">{Icons.check}</span>
              {t('Draft saved {time}', { time: savedTime })}
            </>
          )}
        </span>
        {variant === 'inline' ? (
          <button type="button" className="icon-btn" aria-label={t('Pop out')} title={t('Pop out')} disabled={busy} onClick={() => void closeAfterSave('popout')}>
            <span className="ico" aria-hidden="true">{Icons.popout}</span>
          </button>
        ) : null}
      </div>
      {error === 'draft_gone' ? (
        <div className="note warn rnote" role="alert">
          <span>{t('This draft was removed in Outlook.')}</span>
          <button type="button" className="btn sm" disabled={closing} onClick={() => void saveAsNew()}>{t('Save as a new draft')}</button>
        </div>
      ) : error ? (
        <div className="note warn rnote" role="alert">{errorText(t, error, {}, { context: 'draft' })}</div>
      ) : null}
      <RecipientField
        label="To"
        value={to}
        known={known}
        onChange={(v) => {
          touch();
          setTo(v);
        }}
        extra={(
          <>
            <button type="button" className="lk" onClick={() => setRows((r) => ({ ...r, cc: true, focus: 'cc' }))}>{t('Cc')}</button>
            <button type="button" className="lk" onClick={() => setRows((r) => ({ ...r, bcc: true, focus: 'bcc' }))}>{t('Bcc')}</button>
          </>
        )}
      />
      {rows.cc || cc.length ? (
        <RecipientField label="Cc" value={cc} known={known} autoFocus={rows.focus === 'cc'} onChange={(v) => {
          touch();
          setCc(v);
        }} />
      ) : null}
      {rows.bcc || bcc.length ? (
        <RecipientField label="Bcc" value={bcc} known={known} autoFocus={rows.focus === 'bcc'} onChange={(v) => {
          touch();
          setBcc(v);
        }} />
      ) : null}
      {variant === 'page' ? (
        <div className="fld">
          <label htmlFor={`dc-subject-${draft.id}`}>{t('Subject')}</label>
          <div className="fv">
            <input id={`dc-subject-${draft.id}`} value={subject} onChange={(e) => {
              touch();
              setSubject(e.target.value);
            }} />
          </div>
        </div>
      ) : null}
      {header}
      <MessageEditor
        id={`dc-body-${draft.id}`}
        label={t('Message')}
        toolbar="mail"
        autoGrow={variant === 'inline'}
        value={body}
        onChange={onBody}
        onPicture={onPicture}
        onAttach={(list) => void onAttach(list)}
        onTemplate={(el) => {
          const r = el.getBoundingClientRect();
          setTemplatesAt(templatesAt ? null : { x: r.left, y: r.bottom + 4 });
        }}
        signatureHtml={signature?.html ?? null}
      />
      {draft.quotedHtml ? <QuotedText html={draft.quotedHtml} /> : null}
      <FileChips files={files} onRemove={removeFile} disabled={busy} />
      {templatesAt ? <Menu at={templatesAt} label={t('Insert template')} items={templateItems} onClose={() => setTemplatesAt(null)} /> : null}
      {flow.dialog}
    </form>
  );
}
