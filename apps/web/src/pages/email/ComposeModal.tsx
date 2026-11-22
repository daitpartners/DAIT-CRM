import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useContacts } from '../../api/contacts';
import { useLeads } from '../../api/leads';
import { useComposeMail, useReplyMail } from '../../api/mail';
import { useLookupText } from '../../api/queries';
import { useTemplates } from '../../api/templates';
import { useCurrentUser } from '../../api/useCurrentUser';
import { CompanyPicker } from '../../components/CompanyPicker';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText, leadStatusText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { fillTemplate } from '../../lib/mergeFields';

/** What Compose opens with: a client / lead context, a filled template, or a reply to one of your messages. */
export type ComposeStart = {
  companyId?: number;
  /** The client's name, so the Client picker shows it at once (before, or without, a companies search). */
  companyName?: string;
  leadId?: number;
  subject?: string;
  body?: string;
  /** Reply mode: the message answered (To and Subject are fixed, Graph keeps the conversation). */
  replyTo?: number;
  to?: string;
};

const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/;
const splitList = (v: string) => v.split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

type Props = { start: ComposeStart; connected: boolean; from: string | null; onClose: () => void };

/**
 * The prototype's Compose email dialog (views-projects.js V.compose): Client, Lead, Project (release 3), To, Cc,
 * Keep in the loop, Template, Context saved on, Subject, Message. Sent through the user's own mailbox.
 */
export function ComposeModal({ start, connected, from, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const me = useCurrentUser();
  const lookup = useLookupText(useLang());
  const reply = start.replyTo !== undefined;
  const [companyId, setCompanyId] = useState<number | undefined>(start.companyId);
  const [leadId, setLeadId] = useState<number | undefined>(start.leadId);
  const [to, setTo] = useState(start.to ?? '');
  const [toTouched, setToTouched] = useState(!!start.to);
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(start.subject ?? '');
  const [body, setBody] = useState(start.body ?? `${t('Hi,')}\n\n\n\n${t('Best regards,')}\n${me.name}`);
  const [error, setError] = useState<string | null>(null);
  const compose = useComposeMail();
  const answer = useReplyMail();
  const { data: templates } = useTemplates();
  const { data: leadPage } = useLeads({ companyId, pageSize: 100, tab: 'all' }, !reply && companyId !== undefined);
  const { data: contactPage } = useContacts({ companyId, pageSize: 100 }, !reply && companyId !== undefined);
  const leads = (leadPage?.items ?? []).filter((l) => !l.archivedAt);
  const contacts = (contactPage?.items ?? []).filter((c) => c.businessEmail && c.isActive);
  const lead = leads.find((l) => l.id === leadId);
  const primary = contacts.find((c) => c.isPrimary) ?? contacts[0];
  // To follows the lead's contact (else the client's primary contact) until the user types their own.
  const suggestedTo = lead?.contact?.email ?? primary?.businessEmail ?? '';
  const toValue = toTouched ? to : suggestedTo;
  const ccList = splitList(cc);
  const companyLabel = lead?.company?.name ?? contacts[0]?.company.name ?? null;
  const sortedTemplates = useMemo(
    () => [...(templates ?? [])].sort((a, b) => Number(b.language === me.language) - Number(a.language === me.language)),
    [templates, me.language],
  );

  function toggleLoop(email: string, on: boolean) {
    const next = on ? [...new Set([...ccList, email])] : ccList.filter((x) => x !== email);
    setCc(next.join(', '));
  }

  function applyTemplate(id: string) {
    const tp = templates?.find((x) => String(x.id) === id);
    if (!tp) return;
    const contactFirst = contacts.find((c) => c.businessEmail === toValue)?.firstName ?? '';
    const ctx = { firstName: contactFirst, company: companyLabel ?? '', me: me.name, leadNumber: lead?.number ?? '' };
    setSubject(fillTemplate(tp.subject, ctx));
    setBody(fillTemplate(tp.body, ctx));
  }

  function send() {
    setError(null);
    const target = toValue.trim().toLowerCase();
    if (!reply && !EMAIL_RE.test(target)) return setError(t('Enter a valid To address.'));
    const badCc = ccList.find((x) => !EMAIL_RE.test(x));
    if (badCc) return setError(t('“{value}” is not an email address.', { value: badCc }));
    if (!subject.trim() || !body.trim()) return setError(t('Subject and message are required.'));
    const done = () => {
      toast(t('Email queued — it is sent from {address}', { address: from ?? '' }));
      onClose();
    };
    const fail = (err: unknown) => setError(err instanceof ApiError ? errorText(t, err.code) : t('Something went wrong. Try again.'));
    if (reply) {
      answer.mutate({ id: start.replyTo!, cc: ccList, body: body.trim() }, { onSuccess: done, onError: fail });
    } else {
      compose.mutate(
        { to: target, cc: ccList, subject: subject.trim(), body: body.trim(), leadId: leadId ?? null, companyId: companyId ?? null },
        { onSuccess: done, onError: fail },
      );
    }
  }

  const pending = compose.isPending || answer.isPending;
  return (
    <Modal
      title={reply ? t('Reply') : t('Compose email')}
      onClose={onClose}
      focusDialog
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>{t('Discard')}</button>
          <button type="button" className="btn primary" disabled={!connected || pending} onClick={send}>{t('Send')}</button>
        </>
      }
    >
      {!connected ? (
        <div className="note warn">
          {t('Connect your Microsoft 365 mailbox in Settings to send email from the CRM.')}{' '}
          <Link to="/settings/connections">{t('Open Settings')}</Link>
        </div>
      ) : null}
      {reply ? null : (
        <div className="grid3">
          <CompanyPicker
            id="cm-company"
            label={t('Client')}
            value={companyId}
            selected={companyId === start.companyId && start.companyName ? { value: String(start.companyId), label: start.companyName } : null}
            onChange={(id) => {
              setCompanyId(id);
              setLeadId(undefined);
              setToTouched(false);
            }}
            emptyLabel={t('— choose client / company —')}
            onClear={() => {
              setCompanyId(undefined);
              setLeadId(undefined);
              setToTouched(false);
            }}
          />
          <div>
            <label className="lbl" htmlFor="cm-lead">{t('Lead')}</label>
            <select
              id="cm-lead"
              className="in"
              value={leadId ?? ''}
              disabled={companyId === undefined}
              onChange={(e) => {
                setLeadId(e.target.value ? Number(e.target.value) : undefined);
                setToTouched(false);
              }}
            >
              <option value="">{companyId === undefined ? t('choose client first') : t('— no lead —')}</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>{`${l.number} · ${l.contact?.name ?? lookup('lead_source', l.leadSource)} · ${leadStatusText(t, l.status)}`}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="lbl" htmlFor="cm-project">{t('Project')}</label>
            <select id="cm-project" className="in" disabled title={t('Projects arrive in release 3')}>
              <option>{t('Projects arrive in release 3')}</option>
            </select>
          </div>
        </div>
      )}
      <div className="grid2">
        <div>
          <label className="lbl" htmlFor="cm-to">{t('To')}</label>
          <input
            id="cm-to"
            className="in"
            value={toValue}
            readOnly={reply}
            placeholder={companyId ? t('no email on the lead contact') : t('choose a client or type an address')}
            onChange={(e) => {
              setToTouched(true);
              setTo(e.target.value);
            }}
          />
        </div>
        <div>
          <label className="lbl" htmlFor="cm-cc">
            {t('Cc')} <span className="lbl-note">{t('(stakeholders)')}</span>
          </label>
          <input id="cm-cc" className="in" value={cc} onChange={(e) => setCc(e.target.value)} />
        </div>
      </div>
      {!reply && contacts.length ? (
        <div>
          <div className="lbl">{t('Keep in the loop')}</div>
          <div className="mail-loop">
            {contacts.map((c) => {
              const email = c.businessEmail!.toLowerCase();
              const isTo = email === toValue.toLowerCase();
              return (
                <label key={c.id} className="sw">
                  <input type="checkbox" checked={isTo || ccList.includes(email)} disabled={isTo} onChange={(e) => toggleLoop(email, e.target.checked)} />{' '}
                  {`${c.firstName} ${c.lastName}`.trim()} <span className="dim">· {c.designation || lookup('contact_type', c.contactType)}{c.isPrimary ? ` · ${t('primary')}` : ''}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="grid2">
        {reply ? null : (
          <div>
            <label className="lbl" htmlFor="cm-tpl">{t('Template')}</label>
            <select id="cm-tpl" className="in" defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">{t('— blank —')}</option>
              {sortedTemplates.map((tp) => (
                <option key={tp.id} value={tp.id}>{tp.name}{tp.sourceType === 'oft' ? ' · .oft' : ''}</option>
              ))}
            </select>
          </div>
        )}
        {reply ? null : (
          <div>
            <div className="lbl">{t('Context saved on')}</div>
            <div className="mail-context">{companyLabel ?? <span className="dim">—</span>}{lead ? ` · ${lead.number}` : ''}</div>
          </div>
        )}
        <div className="span2">
          <label className="lbl" htmlFor="cm-subject">{t('Subject')}</label>
          <input id="cm-subject" className="in" value={subject} readOnly={reply} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="span2">
          <label className="lbl" htmlFor="cm-body">{t('Message')}</label>
          <textarea id="cm-body" className="in" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
      </div>
      {error ? <div className="note warn" role="alert">{error}</div> : null}
    </Modal>
  );
}
