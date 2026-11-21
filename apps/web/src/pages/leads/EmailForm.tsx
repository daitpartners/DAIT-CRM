import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { LeadFull } from '../../api/leads';
import { useContacts } from '../../api/contacts';
import { useUsers } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/useT';

/** Id of the Subject field: "Focus on email" and the topbar Email button put the cursor here. */
export const EMAIL_SUBJECT_ID = 'em-subject';

const FOLLOW_DAYS = [2, 3, 7] as const;
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/;

type Person = { email: string; name: string; sub: string; group: string };

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
  const [subject, setSubject] = useState(t('Intro call this week?'));
  // The prototype's intro template (TPL.intro), one translatable phrase per paragraph.
  const [body, setBody] = useState(
    [
      t('Hi {first},', { first }),
      t("Thanks for getting in touch with DAIT Partners. I'd love to hear more about what you're working on at {company}. Would a 30-minute call this week suit you?", { company }),
      `${t('Best regards,')}\n${me.name}`,
    ].join('\n\n'),
  );
  const [follow, setFollow] = useState(true);
  const [days, setDays] = useState<number>(3);

  return (
    <form
      className="email-form"
      aria-label={t('Email')}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        toast(t('Sending email arrives in release 2'), 'warn');
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
        <CcField lead={lead} to={to} disabled={disabled} />
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
          <select id="em-tpl" className="in" disabled={disabled}>
            <option value="">{t('— blank —')}</option>
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
        <button type="submit" className="btn primary" disabled={disabled}>
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
function CcField({ lead, to, disabled }: { lead: LeadFull; to: string; disabled?: boolean }) {
  const t = useT();
  const toast = useToast();
  const me = useCurrentUser();
  const listId = useId();
  const contacts = useContacts({ companyId: lead.companyId ?? undefined, page: 1, pageSize: 100, sort: 'lastName' }, lead.companyId !== null);
  const { data: users } = useUsers();
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const people = useMemo<Person[]>(
    () => [
      ...(contacts.data?.items ?? [])
        .filter((c) => c.businessEmail)
        .map((c) => ({ email: c.businessEmail!, name: `${c.firstName} ${c.lastName}`.trim(), sub: c.designation ?? '', group: lead.companyName })),
      ...(users ?? [])
        .filter((u) => u.isActive && u.id !== me.id)
        .map((u) => ({ email: u.email, name: u.name, sub: '', group: t('DAIT Partners') })),
    ],
    [contacts.data, users, me.id, lead.companyName, t],
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
      setOpen(true);
      setActive((a) => Math.min(shown.length - 1, a + 1));
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
            onBlur={() => setTimeout(() => setOpen(false), 140)}
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
