import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useSendLeadEmail } from '../../api/leadEmails';
import type { LeadFull } from '../../api/leads';
import { useMailboxes } from '../../api/mailboxes';
import { useContacts } from '../../api/contacts';
import { useUsers } from '../../api/queries';
import { useTemplates } from '../../api/templates';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { fillTemplate } from '../../lib/mergeFields';

/**
 * The prototype's intro email (TPL.intro) per outreach language. Not run through t(): it follows the lead's language,
 * not the screen language.
 */
const INTRO: Record<'en' | 'es', (first: string, company: string, me: string) => { subject: string; body: string }> = {
  en: (first, company, me) => ({
    subject: 'Intro call this week?',
    body: `Hi ${first},\n\nThanks for getting in touch with DAIT Partners. I'd love to hear more about what you're working on at ${company}. Would a 30-minute call this week suit you?\n\nBest regards,\n${me}`,
  }),
  es: (first, company, me) => ({
    subject: '¿Una llamada esta semana?',
    body: `Hola ${first}:\n\nGracias por ponerse en contacto con DAIT Partners. Me encantaría saber más sobre lo que están haciendo en ${company}. ¿Le vendría bien una llamada de 30 minutos esta semana?\n\nSaludos cordiales,\n${me}`,
  }),
};

/** Id of the Subject field: "Focus on email" and the topbar Email button put the cursor here. */
export const EMAIL_SUBJECT_ID = 'em-subject';

const FOLLOW_DAYS = [2, 3, 7] as const;
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/;

type Person = { email: string; name: string; sub: string };

/**
 * The prototype's Email panel (views-lead-detail.js `data-cpanel="email"`, laid out by views-leads2.js):
 * To | Cc stakeholders, Project | Template, Subject, Message, "Set follow-up in", Send email. Sending arrives in
 * release 2: Send keeps the draft and says so.
 */
export function EmailForm({ lead, disabled }: { lead: LeadFull; disabled?: boolean }) {
  const t = useT();
  const toast = useToast();
  const me = useCurrentUser();
  const company = lead.company?.name ?? lead.companyName;
  const first = lead.contact?.firstName || company;
  const [to, setTo] = useState(lead.contact?.email ?? '');
  // The intro is written in the lead's outreach language, whatever the user's screen language.
  const leadLang = lead.outreachLanguage ?? 'en';
  const opening = INTRO[leadLang](first, company, me.name);
  const [subject, setSubject] = useState(opening.subject);
  const [body, setBody] = useState(opening.body);
  const [follow, setFollow] = useState(true);
  const [cc, setCc] = useState<string[]>([]);
  const send = useSendLeadEmail(lead.id);
  const { data: mailboxes } = useMailboxes();
  // Release 2B-1: sending goes through your own connected mailbox.
  const noMailbox = mailboxes !== undefined && mailboxes.mine?.status !== 'connected';
  const { data: allTemplates } = useTemplates();
  // Templates in the lead's language first (stable otherwise: the API already orders by the user's language).
  const templates = useMemo(
    () => (allTemplates ? [...allTemplates].sort((a, b) => Number(b.language === leadLang) - Number(a.language === leadLang)) : undefined),
    [allTemplates, leadLang],
  );
  const [templateId, setTemplateId] = useState('');
  const intro = useMemo(() => ({ subject, body }), []);

  /** Picking a template fills Subject and Message with the merge fields applied; "— blank —" restores the intro. */
  function pickTemplate(id: string) {
    setTemplateId(id);
    const tpl = templates?.find((x) => String(x.id) === id);
    if (!tpl) {
      setSubject(intro.subject);
      setBody(intro.body);
      return;
    }
    const ctx = { firstName: first, company, me: me.name, leadNumber: lead.number };
    setSubject(fillTemplate(tpl.subject, ctx));
    setBody(fillTemplate(tpl.body, ctx));
  }
  const [days, setDays] = useState<number>(3);

  return (
    <form
      className="email-form"
      aria-label={t('Email')}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (noMailbox || send.isPending) return;
        if (!to.trim()) return toast(t('Enter who the email goes to'), 'warn');
        send.mutate(
          { to: to.trim(), cc, subject, body, followUpDays: follow ? (days as 2 | 3 | 7) : null, updatedAt: lead.updatedAt },
          {
            onSuccess: (sent) => {
              toast(t('Email queued — it is sent from {address}', { address: sent.fromAddress }));
              // Back to an empty draft: no recipient, the intro text again.
              setTo('');
              setCc([]);
              setTemplateId('');
              setSubject(intro.subject);
              setBody(intro.body);
            },
            onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
          },
        );
      }}
    >
      <div className="grid2">
        <div>
          <label className="lbl" htmlFor="em-to">
            {t('To')}
          </label>
          <input
            id="em-to"
            className="in"
            type="email"
            value={to}
            disabled={disabled}
            placeholder={lead.contact?.email ? '' : t('No email on file – add a contact')}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <CcField lead={lead} to={to} disabled={disabled} picked={cc} setPicked={setCc} />
        <div>
          <label className="lbl" htmlFor="em-project">
            {t('Project')}
          </label>
          <select id="em-project" className="in" disabled>
            <option>{t('available once the lead is Won')}</option>
          </select>
        </div>
        <div>
          <label className="lbl" htmlFor="em-tpl">
            {t('Template')}
          </label>
          <select id="em-tpl" className="in" disabled={disabled} value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
            <option value="">{t('— blank —')}</option>
            {(templates ?? []).map((x) => (
              <option key={x.id} value={String(x.id)}>
                {x.name}
                {x.sourceType === 'oft' ? ' · .oft' : ''}
                {x.language !== leadLang ? ` (${x.language.toUpperCase()})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="span2">
          <label className="lbl" htmlFor={EMAIL_SUBJECT_ID}>
            {t('Subject')}
          </label>
          <input id={EMAIL_SUBJECT_ID} className="in" value={subject} disabled={disabled} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="span2">
          <label className="lbl" htmlFor="em-body">
            {t('Message')}
          </label>
          <textarea id="em-body" className="in" rows={7} value={body} disabled={disabled} onChange={(e) => setBody(e.target.value)} />
        </div>
      </div>
      {noMailbox ? (
        <div className="note warn">
          {t('Connect your Microsoft 365 mailbox in Settings to send email from the CRM.')}{' '}
          <Link to="/settings/connections">{t('Open Settings')}</Link>
        </div>
      ) : null}
      <div className="email-foot">
        <label className="sw">
          <input type="checkbox" checked={follow} disabled={disabled} onChange={(e) => setFollow(e.target.checked)} />
          {t('Set follow-up in')}
        </label>
        <select className="in email-days" aria-label={t('Follow-up in')} value={days} disabled={disabled || !follow} onChange={(e) => setDays(Number(e.target.value))}>
          {FOLLOW_DAYS.map((d) => (
            <option key={d} value={d}>
              {d === 2 ? t('2 days') : d === 3 ? t('3 days') : t('1 week')}
            </option>
          ))}
        </select>
        <div className="grow" />
        <button type="submit" className="btn primary" disabled={disabled || noMailbox || send.isPending}>
          {Icons.send}
          {t('Send email')}
        </button>
      </div>
    </form>
  );
}

/**
 * Cc stakeholders (prototype `.ccbox`): a pick-list of the company's contacts with an email and the DAIT users,
 * plus any typed full address; chosen addresses show as removable chips.
 */
function CcField({ lead, to, disabled, picked, setPicked }: {
  lead: LeadFull; to: string; disabled?: boolean; picked: string[]; setPicked: (v: string[]) => void;
}) {
  const t = useT();
  const toast = useToast();
  const me = useCurrentUser();
  const listId = useId();
  const contacts = useContacts({ companyId: lead.companyId ?? undefined, page: 1, pageSize: 100, sort: 'lastName' }, lead.companyId !== null);
  const { data: users } = useUsers();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);

  const people = useMemo<Person[]>(
    () => [
      ...(contacts.data?.items ?? [])
        .filter((c) => c.businessEmail)
        .map((c) => ({ email: c.businessEmail!, name: `${c.firstName} ${c.lastName}`.trim(), sub: c.designation ?? '' })),
      ...(users ?? [])
        .filter((u) => u.isActive && u.id !== me.id)
        .map((u) => ({ email: u.email, name: u.name, sub: '' })),
    ],
    [contacts.data, users, me.id],
  );
  const has = (e: string) => picked.some((x) => x.toLowerCase() === e.toLowerCase());
  const q = text.trim().toLowerCase();
  const shown = people.filter(
    (p) => !has(p.email) && p.email.toLowerCase() !== to.trim().toLowerCase() && (!q || `${p.name} ${p.email} ${p.sub}`.toLowerCase().includes(q)),
  );
  const nameOf = (e: string) => people.find((p) => p.email.toLowerCase() === e.toLowerCase())?.name ?? e;

  function add(e: string) {
    if (!e || has(e)) return;
    setPicked([...picked, e]);
    setText('');
    setActive(0);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // A closed list opens on the first person; an open one moves down.
      if (!open) {
        setOpen(true);
        setActive(0);
      } else setActive((a) => Math.max(0, Math.min(shown.length - 1, a + 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      const v = text.trim();
      if (e.key !== 'Enter' && !v) return;
      e.preventDefault();
      if (EMAIL_RE.test(v)) add(v);
      else if (open && shown[active]) add(shown[active]!.email);
      else if (v) toast(t('Enter a full email address, e.g. name@company.com'), 'warn');
    } else if (e.key === 'Backspace' && !text && picked.length) {
      setPicked(picked.slice(0, -1));
    } else if (e.key === 'Escape') setOpen(false);
  }

  return (
    <div>
      <label className="lbl" htmlFor="em-cc">
        {t('Cc stakeholders')}
      </label>
      <div className="ccbox">
        <div className="ccfield">
          {picked.map((e) => (
            <span key={e} className="cchip" title={e}>
              {nameOf(e)}
              <button type="button" aria-label={t('Remove {name}', { name: nameOf(e) })} disabled={disabled} onClick={() => setPicked(picked.filter((x) => x !== e))}>
                ✕
              </button>
            </span>
          ))}
          <input
            id="em-cc"
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={listId}
            autoComplete="off"
            disabled={disabled}
            value={text}
            placeholder={picked.length ? t('Add another…') : t('Choose people or type an email…')}
            onFocus={() => setOpen(true)}
            aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
            onBlur={() => {
              blurTimer.current = setTimeout(() => setOpen(false), 140);
            }}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul className="combo-list" id={listId} role="listbox" hidden={!open || shown.length === 0}>
          {shown.map((p, i) => (
            <li
              key={p.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                add(p.email);
              }}
            >
              {p.name} <span className="dim">· {p.sub ? `${p.sub} · ` : ''}{p.email}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
