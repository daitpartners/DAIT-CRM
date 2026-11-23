import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { LAWFUL_BASES, MAILER_INTERVALS, fillTemplate } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useCreateCampaign, useMailerCheck, type MailerCheckResult } from '../../api/mailer';
import { MAILBOXES_KEY } from '../../api/mailboxes';
import { useUsers } from '../../api/queries';
import { useTemplates } from '../../api/templates';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';
import { zoneSourceText, zoneText } from './zones';

const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/;
const list = (v: string) => v.split(/[,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const STEPS = ['Template', 'Cc / Bcc', 'Timing', 'Review & send'] as const;

const emails = (t: TFn, n: number) => (n === 1 ? t('1 email') : t('{n} emails', { n }));
const minutes = (t: TFn, n: number) => (n === 1 ? t('1 minute') : t('{n} minutes', { n }));

/** The prototype shows the merge fields in <code>: wrap them wherever the translated sentence puts them. */
const MERGE_FIELD = /(\{first_name\}|\{company\}|\{me\}|\{lead_id\})/;
const withCode = (text: string) => text.split(MERGE_FIELD).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

/** Local "YYYY-MM-DDTHH:00" one hour from now (prototype default start). */
function nextHour(): string {
  const d = new Date(Date.now() + 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

/** The Mailer's limit for one run (MailerCheck / campaign create accept at most 500 leads). */
const MAX_LEADS = 500;

/**
 * Leads bulk bar "Send via mailer" (prototype V.mailerWizard guard): checks the ticked leads first and only opens
 * the wizard when at least one can be emailed; otherwise it says why, as the prototype does. A mailbox disconnected
 * since the page loaded is refused here, not at Queue. The wizard keeps its own copy of the leads: render `wizard`
 * where it survives the ticks clearing (a Leads list refresh).
 */
export function useSendViaMailer(leadIds: number[], onQueued: () => void) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const check = useMailerCheck();
  const [open, setOpen] = useState<{ leadIds: number[]; check: MailerCheckResult } | null>(null);

  function start() {
    if (leadIds.length > MAX_LEADS) return toast(t('You can send to at most 500 leads in one run.'), 'warn');
    const ids = [...leadIds];
    check.mutate(ids, {
      onSuccess: (data) => {
        if (!data.mailbox) {
          // The bulk bar's hint and disabled button follow once the mailbox state is fetched again.
          void qc.invalidateQueries({ queryKey: MAILBOXES_KEY });
          return toast(errorText(t, 'no_mailbox'), 'warn');
        }
        const rows = data.rows;
        if (!rows.some((r) => !r.block)) {
          const reason = rows.length ? t(rows[0]!.block ?? '').toLowerCase() + (rows.length > 1 ? ', …' : '') : '';
          return toast(reason ? t('None of the selected leads can be emailed ({reason}).', { reason }) : t('None of the selected leads can be emailed.'), 'warn');
        }
        setOpen({ leadIds: ids, check: data });
      },
      onError: (err) => toast(err instanceof ApiError ? errorText(t, err.code) : t('Something went wrong. Try again.'), 'warn'),
    });
  }

  const wizard = open ? <MailerWizard leadIds={open.leadIds} check={open.check} onClose={() => setOpen(null)} onQueued={onQueued} /> : null;
  return { start, pending: check.isPending, wizard };
}

export function SendViaMailerButton({ leadIds, disabled, title, onQueued }: { leadIds: number[]; disabled?: boolean; title?: string; onQueued: () => void }) {
  const mailer = useSendViaMailer(leadIds, onQueued);
  return (
    <>
      <MailerButton disabled={disabled || mailer.pending} title={title} onClick={mailer.start} />
      {mailer.wizard}
    </>
  );
}

/** The bulk bar's primary "Send via mailer" button. */
export function MailerButton({ disabled, title, onClick }: { disabled?: boolean; title?: string; onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" className="btn sm primary" disabled={disabled} title={title} onClick={onClick}>
      {Icons.send}
      {t('Send via mailer')}
    </button>
  );
}

type Props = { leadIds: number[]; check: MailerCheckResult; onClose: () => void; onQueued: () => void };

/**
 * Send via mailer (release 2C; prototype views-mailer.js V.mailerWizard): Template → Cc / Bcc → Timing → Review & send.
 * "Working hours" are the client's: Monday–Friday 09:00–18:00 in each recipient's time zone (owner, 22 Nov 2026).
 */
export function MailerWizard({ leadIds, check, onClose, onQueued }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const me = useCurrentUser();
  const { date: fmtDate } = useFormatDate();
  const create = useCreateCampaign();
  const { data: templates } = useTemplates();
  const { data: users } = useUsers();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lawMissing, setLawMissing] = useState(false);
  const [st, setSt] = useState({
    name: '', templateId: 0, cc: '', bcc: '', when: 'now' as 'now' | 'later', startAt: nextHour(), intervalMinutes: 3,
    // The lawful basis starts empty, as the prototype: it is the rep's active choice (a GDPR record).
    workingHoursOnly: false, unsubscribeLine: true, lawfulBasis: '',
  });
  const ccRef = useRef<HTMLInputElement>(null);
  // The prototype focuses the first field of each step; the dialog itself focuses step 1's on opening.
  useEffect(() => {
    if (step === 1) ccRef.current?.focus();
  }, [step]);
  const set = (patch: Partial<typeof st>) => setSt((s) => ({ ...s, ...patch }));

  const rows = check.rows;
  const okRows = rows.filter((r) => !r.block);
  const sorted = useMemo(
    () => [...(templates ?? [])].sort((a, b) => Number(b.language === me.language) - Number(a.language === me.language)),
    [templates, me.language],
  );
  const tpl = sorted.find((x) => x.id === st.templateId) ?? sorted[0] ?? null;
  useEffect(() => {
    if (!st.name && okRows.length) set({ name: t('Mailer · {date} · {n}', { date: fmtDate(new Date().toISOString()), n: okRows.length === 1 ? t('1 lead') : t('{n} leads', { n: okRows.length }) }) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [okRows.length]);

  const first = okRows[0];
  const sample = first ? { firstName: first.name.split(' ')[0] || 'there', company: first.company, me: me.name, leadNumber: first.leadNumber ?? '' } : null;
  // Quick-add in user order (prototype db().users), not the API's alphabetical list.
  const staff = (users ?? []).filter((u) => u.isActive && u.id !== me.id && u.email).sort((a, b) => a.id - b.id);
  const addQuick = (field: 'cc' | 'bcc', email: string) => {
    const cur = list(st[field]);
    if (!cur.includes(email.toLowerCase())) cur.push(email.toLowerCase());
    set({ [field]: cur.join(', ') } as Partial<typeof st>);
  };

  function next() {
    setError(null);
    if (step === 0 && !tpl) return setError(t('Choose a template'));
    if (step === 1) {
      const bad = [...list(st.cc), ...list(st.bcc)].find((a) => !EMAIL_RE.test(a));
      if (bad) return setError(t('“{value}” is not a full email address', { value: bad }));
    }
    if (step === 2 && st.when === 'later' && !st.startAt) return setError(t('Choose a start date and time'));
    if (step < 3) return setStep(step + 1);
    if (!st.lawfulBasis) {
      setLawMissing(true);
      return document.getElementById('mw-law')?.focus();
    }
    create.mutate(
      {
        leadIds, name: st.name.trim(), templateId: tpl!.id, cc: list(st.cc), bcc: list(st.bcc),
        startAt: st.when === 'later' ? new Date(st.startAt).toISOString() : null, intervalMinutes: st.intervalMinutes,
        workingHoursOnly: st.workingHoursOnly, unsubscribeLine: st.unsubscribeLine, lawfulBasis: st.lawfulBasis,
      },
      {
        onSuccess: (c) => {
          toast(c.status === 'Scheduled' ? t('{id} scheduled', { id: c.number }) : t('{id} is sending', { id: c.number }));
          onQueued();
          onClose();
          navigate(`/mailer/${c.id}`);
        },
        onError: (err) => setError(err instanceof ApiError ? errorText(t, err.code) : t('Something went wrong. Try again.')),
      },
    );
  }

  const n = okRows.length;
  const total = Math.max(0, (n - 1) * st.intervalMinutes);
  const skipped = rows.filter((r) => r.block);

  return (
    <Modal
      title={t('Send via mailer')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>{t('Cancel')}</button>
          <span className="grow" />
          {step ? <button type="button" className="btn" onClick={() => { setError(null); setStep(step - 1); }}>{t('Back')}</button> : null}
          <button type="button" className="btn primary" disabled={create.isPending || n === 0} onClick={next}>
            {step === 3 ? <>{Icons.send}{n === 1 ? t('Queue 1 email') : t('Queue {n} emails', { n })}</> : t('Next')}
          </button>
        </>
      }
    >
      <div className="wiz">
        <ol className="wsteps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'on' : i < step ? 'done' : undefined} aria-current={i === step ? 'step' : undefined}>
              <span>{i + 1}</span>
              {t(s)}
            </li>
          ))}
        </ol>
        {n === 0 ? (
          <div className="note warn">{t('None of the selected leads can be emailed ({reason}).', { reason: t(rows[0]?.block ?? '') })}</div>
        ) : null}

        {step === 0 ? (
          <>
            <div className="grid2">
              <div>
                <label className="lbl" htmlFor="mw-name">{t('Campaign name')}</label>
                <input id="mw-name" className="in" value={st.name} maxLength={160} onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div>
                <label className="lbl" htmlFor="mw-tpl">{t('Template')}</label>
                <select id="mw-tpl" className="in" value={tpl?.id ?? ''} onChange={(e) => set({ templateId: Number(e.target.value) })}>
                  {sorted.map((x) => (
                    <option key={x.id} value={x.id}>{`${x.name}${x.sourceType === 'oft' ? ' · .oft' : ''} (${x.language.toUpperCase()})`}</option>
                  ))}
                </select>
              </div>
            </div>
            {tpl && sample && first ? (
              <div className="mprev">
                <div className="lbl">{t('Preview for {who} · {to}', { who: first.name || first.company, to: first.to })}</div>
                <div className="msub">{fillTemplate(tpl.subject, sample)}</div>
                <pre>{fillTemplate(tpl.body, sample)}</pre>
              </div>
            ) : !tpl ? (
              <div className="note warn">{t('No templates yet. Add one under Settings → Email templates.')}</div>
            ) : null}
            <div className="dim mw-help">
              {withCode(t('Each email is filled in per lead: {first_name}, {company}, {me}, {lead_id}. From: {address}.', { address: check.mailbox?.address ?? '—' }))}
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            {(['cc', 'bcc'] as const).map((f) => (
              <div key={f} role="group" aria-label={f === 'cc' ? t('Cc') : t('Bcc')}>
                <label className="lbl" htmlFor={`mw-${f}`}>
                  {f === 'cc' ? t('Cc') : t('Bcc')}{' '}
                  <span className="dim">{f === 'cc' ? t('· on every email, visible to the recipient') : t('· on every email, hidden from the recipient')}</span>
                </label>
                <input
                  id={`mw-${f}`}
                  ref={f === 'cc' ? ccRef : undefined}
                  className="in"
                  value={st[f]}
                  placeholder={f === 'cc' ? 'name@company.com, another@company.com' : 'name@company.com'}
                  onChange={(e) => set({ [f]: e.target.value } as Partial<typeof st>)}
                />
                <div className="mquick">
                  {staff.map((u) => (
                    <button key={u.id} type="button" className="btn xs" onClick={() => addQuick(f, u.email)}>{`+ ${u.name}`}</button>
                  ))}
                </div>
              </div>
            ))}
            <div className="dim mw-help">
              {t('Both are optional. Separate addresses with commas. Cc and Bcc receive one copy per lead, so {n} each.', { n: emails(t, n) })}
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <div className="grid2">
              <div>
                <div className="lbl">{t('When to start')}</div>
                <label className="mradio">
                  <input type="radio" name="mw-when" checked={st.when === 'now'} onChange={() => set({ when: 'now' })} /> {t('Send now')}
                </label>
                <label className="mradio">
                  <input type="radio" name="mw-when" checked={st.when === 'later'} onChange={() => set({ when: 'later' })} /> {t('Start at')}
                  <input className="in mw-start" type="datetime-local" aria-label={t('Start date and time')} value={st.startAt} onChange={(e) => set({ startAt: e.target.value, when: 'later' })} />
                </label>
              </div>
              <div>
                <label className="lbl" htmlFor="mw-int">{t('Delay between emails')}</label>
                <select id="mw-int" className="in" value={st.intervalMinutes} onChange={(e) => set({ intervalMinutes: Number(e.target.value) })}>
                  {MAILER_INTERVALS.map((m) => (
                    <option key={m} value={m}>{t('One every {minutes}', { minutes: minutes(t, m) })}</option>
                  ))}
                </select>
                <label className="sw mw-hours">
                  <input type="checkbox" checked={st.workingHoursOnly} onChange={(e) => set({ workingHoursOnly: e.target.checked })} />{' '}
                  {t("Only send in the client's working hours (Monday–Friday, 09:00–18:00 their time)")}
                </label>
              </div>
            </div>
            <div className="note info">
              {t('{emails}, one every {minutes}: the last one goes out about {total} after the start.', {
                emails: emails(t, n), minutes: minutes(t, st.intervalMinutes),
                total: total < 60 ? minutes(t, total) : t('{h} hours', { h: Math.round(total / 6) / 10 }),
              })}{' '}
              {t("That is far inside Microsoft 365's limits (about 30 a minute, 10,000 recipients a day).")}{' '}
              {t('Your mailbox sends at most 200 mailer emails a day; the rest continue the next day.')}
              {st.workingHoursOnly ? ` ${t('Each lead waits for working hours in their own time zone (shown on the next step).')}` : ''}
              {n > 200 ? <> <strong>{t('More than 200 in one run')}</strong> {t('starts to look like bulk mail from a personal mailbox; consider splitting it across days.')}</> : null}
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <dl className="kv mw-kv">
              <dt>{t('Template')}</dt><dd>{tpl?.name ?? '—'}</dd>
              <dt>{t('From')}</dt><dd>{`${me.name} · ${check.mailbox?.address ?? '—'}`}</dd>
              <dt>{t('Cc')}</dt><dd>{list(st.cc).join(', ') || <span className="dim">—</span>}</dd>
              <dt>{t('Bcc')}</dt><dd>{list(st.bcc).join(', ') || <span className="dim">—</span>}</dd>
              <dt>{t('Timing')}</dt>
              <dd>
                {st.when === 'now' ? t('Starts now') : t('Starts {when}', { when: new Date(st.startAt).toLocaleString(me.language) })}
                {' · '}{t('one every {minutes}', { minutes: minutes(t, st.intervalMinutes) })}
                {st.workingHoursOnly ? ` · ${t("client's working hours only")}` : ''}
              </dd>
            </dl>
            <div className="tbl mrec">
              <table>
                <thead>
                  <tr><th>{t('Lead')}</th><th>{t('Name')}</th><th>{t('To')}</th><th>{t('Local time')}</th><th>{t('Result')}</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.leadId}>
                      <td>{r.leadNumber ?? '—'}</td>
                      <td>{r.name || r.company || '—'}</td>
                      <td>{r.to || <span className="dim">—</span>}</td>
                      <td className="wrap" title={zoneSourceText(t, r.source)}>{zoneText(t, r.zones)}</td>
                      <td className="wrap">
                        {r.block ? (
                          <><span className="badge b-grey">{t('Skipped')}</span> <span className="dim">{t(r.block)}</span></>
                        ) : (
                          <span className="badge b-ok">{t('Will send')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid2">
              <div>
                <label className="lbl" htmlFor="mw-law">{t('Lawful basis for contacting these leads')} <span className="req">*</span></label>
                <select
                  id="mw-law"
                  className={lawMissing ? 'in err' : 'in'}
                  value={st.lawfulBasis}
                  aria-invalid={lawMissing || undefined}
                  aria-describedby={lawMissing ? 'mw-law-err' : undefined}
                  onChange={(e) => {
                    set({ lawfulBasis: e.target.value });
                    setLawMissing(false);
                  }}
                >
                  <option value="">{t('— choose —')}</option>
                  {LAWFUL_BASES.map((x) => (
                    <option key={x} value={x}>{t(x)}</option>
                  ))}
                </select>
                {lawMissing ? <div id="mw-law-err" className="err-msg" role="alert">{t('Choose the lawful basis before sending')}</div> : null}
              </div>
              <div>
                <div className="lbl">{t('Opt-out')}</div>
                <label className="sw mw-hours">
                  <input type="checkbox" checked={st.unsubscribeLine} onChange={(e) => set({ unsubscribeLine: e.target.checked })} /> {t('Add an unsubscribe line to every email')}
                </label>
              </div>
            </div>
            {/* Review #21: no green "will be queued" while the lawful basis is still missing. */}
            {lawMissing ? null : (
              <div className={skipped.length ? 'note warn' : 'note ok'}>
                <strong>{n === 1 ? t('1 email will be queued.') : t('{n} emails will be queued.', { n })}</strong>
                {skipped.length ? ` ${skipped.length === 1 ? t('1 lead skipped (see the table).') : t('{n} leads skipped (see the table).', { n: skipped.length })}` : ''}{' '}
                {t('Leads that reply, unsubscribe or close before their turn are skipped automatically.')}
              </div>
            )}
          </>
        ) : null}
        {error ? <div className="note warn" role="alert">{error}</div> : null}
      </div>
    </Modal>
  );
}
