import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../../../api/client';
import { useCreateDraft, useDiscardDraft, useDraft, type DraftView } from '../../../api/drafts';
import { useLead, type LeadSummary } from '../../../api/leads';
import { useCompanyProjects } from '../../../api/projects';
import { useCurrentUser } from '../../../api/useCurrentUser';
import { Icons } from '../../../components/Icons';
import { useToast } from '../../../components/Toast';
import { errorText } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';
import { ComposeLeadSummary } from './ComposeLeadSummary';
import { DraftComposer, type ComposerControl } from './DraftComposer';
import { draftKindOf } from './InlineReply';
import { LeadPicker, type PickedLead } from './LeadPicker';

const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

/** What the New message page opens with: a draft to go on with, or a new one's lead, client, project and template. */
export type NewMessageStart = { draft?: number; company?: number; lead?: number; project?: number; template?: number };

/** The New message page's address (`/email/new?…`) for `s`. */
export function newMessageHref(s: NewMessageStart = {}): string {
  const q = new URLSearchParams();
  for (const k of ['draft', 'company', 'lead', 'project', 'template'] as const) {
    const v = s[k];
    if (v !== undefined) q.set(k, String(v));
  }
  const text = q.toString();
  return `/email/new${text ? `?${text}` : ''}`;
}

type Guard = MutableRefObject<(() => Promise<boolean>) | null>;

/**
 * The full-page New message (web-mail release 3, mockup state 3) at `/email/new`: the crumb `Email / New message` and
 * `← Back to Inbox`, the composer (From, To, Cc, Bcc, Subject, Lead, Project when relevant, the template bar, the mail
 * toolbar, the message with the signature, the files) and the chosen lead on the right. Without `?draft=` it makes a new
 * draft in the user's Outlook (with the link's lead and project) and the address becomes `?draft={id}`, so a reload and
 * Back work; `?draft=` opens a draft to go on with (Pop out, Continue editing, Undo). After a send the screen goes to
 * Sent (or Scheduled); Discard goes back. Links on the Email screen save the draft first (`guard`). A draft that
 * cannot be made (no mailbox connected, Outlook refused) is said on the page, under the screen's Connect note.
 */
export function NewMessagePage({ guard }: { guard: Guard }) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const draftId = num(params.get('draft'));
  const company = num(params.get('company'));
  const create = useCreateDraft();
  const discard = useDiscardDraft();
  /** The draft this page made (closing it untouched discards it), and what the link asked for it. */
  const [made, setMade] = useState<number | null>(null);
  /** Why the new draft could not be made (no mailbox connected, Outlook refused): said on the page. */
  const [failed, setFailed] = useState<string | null>(null);
  const asked = useRef({ lead: num(params.get('lead')), project: num(params.get('project')), template: num(params.get('template')) });
  const started = useRef(false);
  const mounted = useRef(true);
  const discardMutate = useRef(discard.mutate);
  discardMutate.current = discard.mutate;
  const { data: draft, isError } = useDraft(draftId ?? null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Back where the user came from (the Email screen when the page was opened directly). */
  const leave = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/email', { replace: true });
  };

  // No draft in the address: one is made (once; the development double mount keeps the ref) and the address names it.
  useEffect(() => {
    if (draftId !== undefined || started.current) return;
    started.current = true;
    const { lead, project } = asked.current;
    create.mutateAsync({ kind: 'new', ...(lead ? { leadId: lead } : {}), ...(lead && project ? { projectId: project } : {}) }).then(
      (v) => {
        // Gone before Outlook answered: the untouched draft goes too.
        setTimeout(() => {
          if (!mounted.current) {
            discardMutate.current(v.id);
            return;
          }
          setMade(v.id);
          navigate(newMessageHref({ draft: v.id, company }), { replace: true });
        }, 0);
      },
      (err: unknown) => {
        if (mounted.current) setFailed(err instanceof ApiError ? err.code : 'try_again');
      },
    );
    // Once per page.
  }, [draftId]);

  useEffect(() => {
    if (!isError) return;
    toast(t('This draft no longer exists. It may have been sent or deleted.'), 'warn');
    navigate('/email', { replace: true });
  }, [isError]);

  const created = draft !== undefined && draft.id === made;
  return (
    <section className="cpage" aria-label={t('New message')}>
      <div className="cp-top">
        <div className="crumb">
          <Link to="/email">{t('Email')}</Link> / {t('New message')}
        </div>
        <Link className="cp-back" to="/email">← {t('Back to Inbox')}</Link>
      </div>
      {draft && draft.id === draftId ? (
        <NewMessageForm
          key={draft.id}
          draft={draft}
          created={created}
          company={company}
          project={created ? asked.current.project : undefined}
          template={created ? asked.current.template : undefined}
          guard={guard}
          onSent={(scheduled) => navigate(scheduled ? '/email?folder=scheduled' : '/email?folder=sent', { replace: true })}
          onDiscarded={leave}
          onUndone={(d) => navigate(newMessageHref({ draft: d.id }))}
        />
      ) : (
        <div className="cp-grid">
          {failed ? (
            <div className="cp-main cp-loading" role="alert">{errorText(t, failed, {}, { context: 'draft' })}</div>
          ) : (
            <div className="cp-main cp-loading" role="status" aria-busy="true">{t('Loading…')}</div>
          )}
        </div>
      )}
    </section>
  );
}

type FormProps = {
  draft: DraftView;
  /** This page made the draft: closing it untouched discards it. */
  created: boolean;
  /** The link's client: the leads offered, and its projects while no lead is chosen. */
  company?: number;
  /** The link's project, kept for the lead to come when the link named no lead. */
  project?: number;
  template?: number;
  guard: Guard;
  onSent(scheduled: boolean): void;
  onDiscarded(): void;
  onUndone(d: DraftView): void;
};

/** The page's card and the chosen lead, for one draft. */
function NewMessageForm({ draft, created, company, project, template, guard, onSent, onDiscarded, onUndone }: FormProps) {
  const t = useT();
  const me = useCurrentUser();
  const control = useRef<ComposerControl | null>(null);
  const [leadId, setLeadId] = useState<number | null>(draft.leadId);
  const [picked, setPicked] = useState<LeadSummary | null>(null);
  const [projectId, setProjectId] = useState<number | null>(draft.projectId ?? project ?? null);
  const [applied, setApplied] = useState<{ name: string; lead: string | null } | null>(null);
  const { data: full } = useLead(leadId ?? NaN);
  const lead = full && full.id === leadId ? full : undefined;
  // The client whose projects are offered: the chosen lead's (once known), else the link's.
  const companyId = leadId !== null ? lead?.companyId ?? picked?.companyId ?? null : company ?? null;
  const { data: projectData } = useCompanyProjects(companyId ?? NaN, companyId !== null);
  const projects = projectData?.items ?? [];

  // Another lead chosen: the draft saved with it, then read again for that lead's panel and time zone.
  const otherLead = leadId !== null && leadId !== draft.leadId;
  const { data: reread } = useQuery({
    queryKey: ['mail-draft-lead', draft.id, leadId],
    queryFn: async () => {
      await control.current?.flush();
      return api<DraftView>(`/api/mail/drafts/${draft.id}`);
    },
    enabled: otherLead,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const view = leadId === draft.leadId ? draft : otherLead && reread?.leadId === leadId ? reread : null;

  // A new message from a link: To takes the lead's contact, Cc the project's stakeholders (not To), once each.
  const filled = useRef({ to: false, cc: false });
  useEffect(() => {
    if (!created || filled.current.to || leadId === null || leadId !== draft.leadId || !lead) return;
    filled.current.to = true;
    if (lead.contact?.email) control.current?.fillTo(lead.contact.email);
  }, [lead]);
  useEffect(() => {
    if (!created || filled.current.cc || projectId === null || !projectData || (leadId !== null && !lead)) return;
    filled.current.cc = true;
    const p = projects.find((x) => x.id === projectId);
    if (p) control.current?.fillCc(p.stakeholders.flatMap((s) => (s.email ? [s.email] : [])), lead?.contact?.email ? [lead.contact.email] : []);
  }, [projectData, lead]);

  function chooseLead(row: LeadSummary | null) {
    control.current?.touch();
    setPicked(row);
    setLeadId(row?.id ?? null);
    if (row?.contact?.email) control.current?.fillTo(row.contact.email);
    // A project stays only with a lead of its client.
    const p = projects.find((x) => x.id === projectId);
    if (projectId !== null && (!row || !p || p.company.id !== row.companyId)) setProjectId(null);
  }

  function chooseProject(id: number | null) {
    control.current?.touch();
    setProjectId(id);
    const p = projects.find((x) => x.id === id);
    if (p) control.current?.fillCc(p.stakeholders.flatMap((s) => (s.email ? [s.email] : [])));
  }

  const value: PickedLead | null = leadId === null
    ? null
    : lead
      ? { id: lead.id, number: lead.number, company: lead.companyName, status: lead.status }
      : picked && picked.id === leadId
        ? { id: picked.id, number: picked.number, company: picked.companyName, status: picked.status }
        : null;
  const showProject = projects.length > 0 || projectId !== null;

  return (
    <div className="cp-grid">
      <div className="cp-main">
        <DraftComposer
          draft={draft}
          variant="page"
          label={t('New message')}
          created={created}
          guard={guard}
          control={control}
          leadId={leadId}
          // A project is filed only with a lead (the server takes the client from the lead).
          projectId={leadId !== null ? projectId : null}
          recipientZone={view ? view.recipientZone : null}
          template={template}
          start={draft.replyToId !== null ? { kind: draftKindOf(draft), replyToId: draft.replyToId } : undefined}
          onTemplate={(tp, from) => setApplied({ name: tp.name, lead: from })}
          onClose={(reason, sent) => {
            if (reason === 'sent') onSent(sent ? sent.result.undoUntil === null : false);
            else onDiscarded();
          }}
          onUndone={onUndone}
          before={(
            <div className="fld">
              <label htmlFor={`nm-from-${draft.id}`}>{t('From')}</label>
              <div className="fv">
                <select id={`nm-from-${draft.id}`} className="from" value={draft.from} onChange={() => undefined}>
                  <option value={draft.from}>{`${me.name} <${draft.from}>`}</option>
                </select>
                <span className="hintr">{t('Your mailbox')}</span>
              </div>
            </div>
          )}
          header={(
            <>
              <div className="fld">
                <label>{t('Lead')}</label>
                <div className="fv">
                  <LeadPicker value={value} companyId={company} onChange={chooseLead} />
                  <span className="hintr">{t("Filed on the lead's timeline when sent")}</span>
                </div>
              </div>
              {showProject ? (
                <div className="fld">
                  <label htmlFor={`nm-project-${draft.id}`}>{t('Project')}</label>
                  <div className="fv">
                    <select
                      id={`nm-project-${draft.id}`}
                      className="from"
                      value={projectId ?? ''}
                      disabled={leadId === null}
                      onChange={(e) => chooseProject(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">{leadId === null ? t('choose a lead first') : t('— no project —')}</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{`${p.number} · ${p.name}`}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}
              {applied ? (
                <div className="tplbar">
                  <span className="ico" aria-hidden="true">{Icons.template}</span>
                  <span>
                    {t('Template:')} <b>{applied.name}</b>
                    {applied.lead ? ` · ${t('fields filled from {lead}', { lead: applied.lead })}` : ''}
                    {' · '}
                  </span>
                  <button type="button" className="lk" onClick={(e) => control.current?.openTemplates(e.currentTarget)}>{t('Change')}</button>
                </div>
              ) : null}
            </>
          )}
        />
      </div>
      <ComposeLeadSummary leadId={leadId} lead={lead} panel={view?.lead ?? null} />
    </div>
  );
}
