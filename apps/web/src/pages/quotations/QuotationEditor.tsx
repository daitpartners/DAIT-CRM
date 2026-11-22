import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { QUOTE_CURRENCIES, defaultTaxRate, formatMoney, quoteTotals, type QuotationUpdate, type QuoteCurrency } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useContacts } from '../../api/contacts';
import { useLeads } from '../../api/leads';
import { keys } from '../../api/queries';
import {
  invalidateAfterQuotationWrite, patchQuotation, useQuotation, useQuotationAction, type QuotationDetail,
} from '../../api/quotations';
import { useCurrentUser } from '../../api/useCurrentUser';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { Topbar } from '../../components/Topbar';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText, leadStatusText, quoteStatusBadge, quoteStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { LinesTable, amount, blankLine, newLineKey, num, type DraftLine } from './LinesTable';
import { PdfPreviewModal } from './PdfPreviewModal';
import { SendQuotationModal, bold, withBold } from './SendQuotationModal';

/** Save refusals after which the server copy replaces the draft (someone else changed it, it locked, or a send began). */
const RELOAD_ON = new Set(['stale', 'locked', 'sending']);

/** Autosave waits this long after the last keystroke. */
const SAVE_DEBOUNCE_MS = 600;
/** Contacts / leads offered for the company: the API's largest page. */
const PICK_PAGE = 100;

/** The editable fields as the form holds them (numbers as typed). */
type Draft = {
  quotationDate: string;
  validUntil: string;
  currency: QuoteCurrency;
  contactId: string;
  leadId: string;
  subject: string;
  notes: string;
  taxRate: string;
  overallDiscount: string;
  lines: DraftLine[];
};

/** The server's quotation as a draft; line keys are kept from `keep` (same count) so rows keep focus across saves. */
function draftOf(q: QuotationDetail, keep?: DraftLine[]): Draft {
  return {
    quotationDate: q.quotationDate,
    validUntil: q.validUntil ?? '',
    currency: q.currency,
    contactId: q.contact ? String(q.contact.id) : '',
    leadId: q.lead ? String(q.lead.id) : '',
    subject: q.subject,
    notes: q.notes,
    taxRate: String(q.taxRate),
    overallDiscount: String(q.overallDiscount),
    lines: q.lines.map((l, i) => ({
      key: keep && keep.length === q.lines.length ? keep[i]!.key : newLineKey(),
      item: l.item, description: l.description ?? '', qty: String(l.qty), unit: l.unit, unitPrice: String(l.unitPrice), discount: String(l.discount),
    })),
  };
}

type Body = Required<Omit<QuotationUpdate, 'updatedAt'>>;

/** The draft as the API body (every field). */
function bodyOf(d: Draft): Body {
  return {
    quotationDate: d.quotationDate,
    validUntil: d.validUntil || null,
    currency: d.currency,
    contactId: d.contactId ? Number(d.contactId) : null,
    leadId: d.leadId ? Number(d.leadId) : null,
    subject: d.subject.trim(),
    notes: d.notes,
    taxRate: num(d.taxRate),
    overallDiscount: num(d.overallDiscount),
    lines: d.lines.map((l) => ({
      item: l.item.trim(), description: l.description.trim() || null, qty: num(l.qty), unit: l.unit.trim(), unitPrice: num(l.unitPrice), discount: num(l.discount),
    })),
  };
}

/** The fields of `next` that differ from `base`. */
function changed(next: Body, base: Body): Partial<Body> {
  const out: Partial<Body> = {};
  for (const k of Object.keys(next) as (keyof Body)[]) {
    if (JSON.stringify(next[k]) !== JSON.stringify(base[k])) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}

/** The API refuses these (blank subject, line without an item, no date); autosave waits until they are filled in. */
const savable = (b: Partial<Body>) => b.subject !== '' && b.quotationDate !== '' && !(b.lines ?? []).some((l) => l.item === '');

/** Live totals of the draft (shared quoteTotals, as the API computes them). */
const totalsOf = (d: Draft) =>
  quoteTotals({ lines: d.lines.map((l) => ({ qty: num(l.qty), price: num(l.unitPrice), discount: num(l.discount) })), overallDiscount: num(d.overallDiscount), taxRate: num(d.taxRate) });

/**
 * `/quotations/:id`: the quotation editor (prototype V.quoteEditor). Every change is saved on its own after a short
 * pause (409 stale → toast and reload, as other forms); the first edit to a sent quotation opens the next revision.
 * Locked (Accepted / Rejected / Expired), sending, or without edit rights: read-only.
 */
export function QuotationEditor() {
  const t = useT();
  const id = Number(useParams().id);
  const { data: q, error, refetch } = useQuotation(id);
  const code = !Number.isInteger(id) ? 'not_found' : error instanceof ApiError ? error.code : error ? 'unknown' : null;
  const crumb = (
    <>
      <Link to="/quotations">{t('Quotations')}</Link>
      {q ? ` / ${q.number}` : null}
    </>
  );
  if (!q) return <Topbar title={code ? errorText(t, code) : t('Loading…')} crumb={crumb} />;
  return <Editor key={q.id} q={q} crumb={crumb} refetch={refetch} />;
}

function Editor({ q, crumb, refetch }: { q: QuotationDetail; crumb: React.ReactNode; refetch: () => Promise<{ data?: QuotationDetail }> }) {
  const t = useT();
  const me = useCurrentUser();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { date, relative } = useFormatDate();
  const action = useQuotationAction(q.id);
  const [draft, setDraftState] = useState<Draft>(() => draftOf(q));
  const [dialog, setDialog] = useState<'send' | 'pdf' | null>(null);

  // Autosave bookkeeping, in refs so the debounced save always sees the latest values.
  const draftRef = useRef(draft);
  const base = useRef(q);
  const edits = useRef(0);
  const settled = useRef(0);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<number | undefined>(undefined);
  /** A currency change leaves GST to the server's default for that currency (Company details) until GST is edited. */
  const taxAuto = useRef(false);
  const gone = useRef(false);

  const setDraft = (d: Draft) => {
    draftRef.current = d;
    setDraftState(d);
  };

  // A fresh server copy (another save, a status change, the sending poll): taken over unless edits are waiting.
  useEffect(() => {
    // An older copy (a fetch that started before the last save) never replaces a newer one.
    if (q.updatedAt < base.current.updatedAt) return;
    base.current = q;
    if (edits.current === settled.current) {
      const fresh = draftOf(q, draftRef.current.lines);
      if (JSON.stringify(bodyOf(fresh)) !== JSON.stringify(bodyOf(draftRef.current))) setDraft(fresh);
    }
  }, [q]);

  const reload = useCallback(async () => {
    const { data } = await refetch();
    if (data) {
      base.current = data;
      taxAuto.current = false;
      setDraft(draftOf(data, draftRef.current.lines));
    }
  }, [refetch]);

  /** Saves what changed since the server copy; true when nothing is left unsaved. */
  const saveNow = useCallback(async (): Promise<boolean> => {
    if (gone.current) return false;
    const seq = edits.current;
    const patch = changed(bodyOf(draftRef.current), bodyOf(draftOf(base.current)));
    if (taxAuto.current) delete patch.taxRate;
    if (Object.keys(patch).length === 0) {
      settled.current = seq;
      return true;
    }
    if (!savable(patch)) return false;
    try {
      const before = base.current;
      const res = await patchQuotation(before.id, { ...patch, updatedAt: before.updatedAt });
      // GST still left to the server for this currency (not edited, no other currency picked meanwhile): its value.
      const takeTax = patch.currency !== undefined && taxAuto.current && draftRef.current.currency === res.currency;
      if (patch.currency) taxAuto.current = false;
      base.current = res;
      qc.setQueryData(keys.quotation(res.id), res);
      settled.current = seq;
      // Take over what the server stored (GST default, 2-dp rounding) unless the user typed on meanwhile.
      if (edits.current === seq) {
        const fresh = draftOf(res, draftRef.current.lines);
        if (JSON.stringify(bodyOf(fresh)) !== JSON.stringify(bodyOf(draftRef.current))) setDraft(fresh);
      } else if (takeTax && draftRef.current.taxRate !== String(res.taxRate)) {
        setDraft({ ...draftRef.current, taxRate: String(res.taxRate) });
      }
      if (res.revision > before.revision && res.editingNewRevision) toast(t('Revision {n} opened · previous version kept', { n: res.revision }));
      void invalidateAfterQuotationWrite(qc, res.id);
      return edits.current === seq;
    } catch (err) {
      // A total over what the money columns hold (GST included) is a validation issue with its own message.
      const tooLarge = err instanceof ApiError && !!err.issues?.some((i) => i.message === 'total_too_large');
      const errCode = tooLarge ? 'total_too_large' : err instanceof ApiError ? err.code : 'unknown';
      if (!RELOAD_ON.has(errCode) && !(err instanceof ApiError && err.status === 404)) {
        // Anything else (network, validation, server error): the user's typing stays on screen, still unsaved, and is
        // tried again with the next edit or on leaving.
        toast(errorText(t, errCode), 'warn');
        return false;
      }
      settled.current = edits.current;
      if (err instanceof ApiError && err.status === 404) {
        // Clearing the lead can leave the quotation outside what this user may see: it was saved.
        gone.current = true;
        toast(t('Saved · without its lead you can no longer see this quotation'));
        void invalidateAfterQuotationWrite(qc);
        navigate('/quotations');
        return false;
      }
      toast(errorText(t, errCode), 'warn');
      await reload();
      return false;
    }
  }, [qc, t, toast, navigate, reload]);

  /** Runs any waiting save now (before Send, Preview, Duplicate or a status change); true when all is saved. */
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    chain.current = chain.current.then(saveNow, saveNow);
    return chain.current;
  }, [saveNow]);

  // Leaving the page with a save still waiting: save it now rather than drop it; a blank subject or item cannot be
  // saved, so say the edits were not kept.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const warnRef = useRef(() => {});
  warnRef.current = () => toast(t('Not saved: the subject and the item on every line must be filled in'), 'warn');
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (edits.current === settled.current || gone.current) return;
      if (savable(changed(bodyOf(draftRef.current), bodyOf(draftOf(base.current))))) void flushRef.current();
      else warnRef.current();
    },
    [],
  );

  // A queued send settled (the 5 s poll saw it): the list, dashboard and lead moved too.
  const wasSending = useRef(q.sending);
  useEffect(() => {
    if (wasSending.current && !q.sending) void invalidateAfterQuotationWrite(qc, q.id);
    wasSending.current = q.sending;
  }, [q.sending, qc]);

  /** Before Send, Preview, Duplicate or a status change: everything saved (a blank subject or item is pointed out). */
  async function ready(): Promise<boolean> {
    if (!q.canEdit) return true;
    if (await flush()) return true;
    if (!gone.current && !savable(bodyOf(draftRef.current))) toast(errorText(t, 'validation'), 'warn');
    return false;
  }

  function edit(next: Partial<Draft>) {
    edits.current += 1;
    setDraft({ ...draftRef.current, ...next });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }

  function changeCurrency(currency: QuoteCurrency) {
    // Builder's call: a new currency resets GST to its default (INR 18, USD 0, CAD 0; the server applies Company details).
    taxAuto.current = true;
    edit({ currency, taxRate: String(q.taxDefaults?.[currency] ?? defaultTaxRate(currency)) });
  }

  const { data: contactPage } = useContacts({ companyId: q.company.id, page: 1, pageSize: PICK_PAGE });
  const { data: leadPage } = useLeads({ companyId: q.company.id, page: 1, pageSize: PICK_PAGE });
  const contacts = (contactPage?.items ?? []).map((c) => ({ id: c.id, label: `${c.firstName} ${c.lastName} · ${c.designation || c.contactType}`, name: `${c.firstName} ${c.lastName}` }));
  if (q.contact && !contacts.some((c) => c.id === q.contact!.id)) contacts.unshift({ id: q.contact.id, label: q.contact.name, name: q.contact.name });
  const leads = (leadPage?.items ?? []).map((l) => ({ id: l.id, label: `${l.number} · ${leadStatusText(t, l.status)}` }));
  if (q.lead && !leads.some((l) => l.id === q.lead!.id)) leads.unshift({ id: q.lead.id, label: `${q.lead.number} · ${leadStatusText(t, q.lead.status)}` });

  const editable = q.canEdit;
  const totals = totalsOf(draft);
  const cur = draft.currency;
  const company = q.company.legalName || q.company.name;
  const contactName = contacts.find((c) => String(c.id) === draft.contactId)?.name ?? (draft.contactId ? q.contact?.name : null);

  async function decide(kind: 'accept' | 'reject') {
    if (!(await ready())) return;
    const now = base.current;
    const label = kind === 'accept' ? t('Mark accepted') : t('Mark rejected');
    let discardUnsent = false;
    if (now.editingNewRevision) {
      const ok = await confirm({
        title: label, body: t('Revision {n} has unsent changes — they will be discarded', { n: now.revision }), confirmLabel: label, danger: kind === 'reject',
      });
      if (!ok) return;
      discardUnsent = true;
    }
    run({ kind, discardUnsent });
  }

  async function negotiate() {
    if (!(await ready())) return;
    run({ kind: 'negotiate' });
  }

  function run(a: Parameters<typeof action.mutate>[0]) {
    action.mutate(a, {
      onSuccess: (res) => {
        if (a.kind === 'duplicate') {
          toast(t('Duplicated as {number}', { number: res.number }));
          navigate(`/quotations/${res.id}`);
        } else {
          toast(t('{number} marked {status}', { number: res.number, status: quoteStatusText(t, res.status) }));
        }
      },
      onError: (err) => {
        toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn');
        void reload();
      },
    });
  }

  async function openSend() {
    if (!(await ready())) return;
    if (!base.current.contact?.email) return toast(t('Choose a contact with an email address before sending'), 'warn');
    setDialog('send');
  }

  async function openPdf() {
    if (!(await ready())) return;
    setDialog('pdf');
  }

  async function duplicate() {
    if (!(await ready())) return;
    run({ kind: 'duplicate' });
  }

  const steps = ['Draft', 'Sent', 'Negotiating', 'Accepted'] as const;
  const idx = ({ Draft: 0, Sent: 1, Negotiating: 2, Accepted: 3, Rejected: -1, Expired: -1 } as Record<string, number>)[q.status] ?? -1;
  const lastFor = (s: string) => q.history.filter((h) => h.text.startsWith(s)).at(-1);
  const editingRev = q.editingNewRevision || q.status === 'Draft';
  const sentRevisions = q.revisions.slice().reverse().filter((r) => !(r.revisionNo === q.revision && !q.editingNewRevision));
  const ro = { background: '#F9F7FD' };

  return (
    <>
      <Topbar
        title={`${q.number} · ${company}`}
        crumb={crumb}
        badges={
          <>
            <span className={quoteStatusBadge(q.status)}>{quoteStatusText(t, q.status)}</span>
            <span className="badge b-grey">{q.editingNewRevision ? t('Revision {n} · editing', { n: q.revision }) : t('Revision {n}', { n: q.revision })}</span>
          </>
        }
        sub={
          <>
            {t('Lead')} {q.lead ? <Link to={`/leads/${q.lead.id}`}>{q.lead.number}</Link> : '—'} · {t('Contact')} {contactName || '—'} · {t('Company')}{' '}
            <Link to={`/companies/${q.company.id}`}>{q.company.number}</Link> · {t('Owner')} {q.owner.name}
          </>
        }
      >
        <button type="button" className="btn" onClick={() => void openPdf()}>
          {t('Preview PDF')}
        </button>
        {me.can('manage_quotes') ? (
          <button type="button" className="btn" disabled={action.isPending} onClick={() => void duplicate()}>
            {t('Duplicate')}
          </button>
        ) : null}
        {q.locked || !me.can('use_email') ? null : q.sending ? (
          <button type="button" className="btn primary" disabled>
            {t('Sending…')}
          </button>
        ) : editable ? (
          <button type="button" className="btn primary" onClick={() => void openSend()}>
            {t('Send by email')}
          </button>
        ) : null}
      </Topbar>
      <div className="page cols">
        <div className="col-main">
          <section className="card">
            <h2>{t('Quotation details')}</h2>
            <div className="grid4">
              <div>
                <label className="lbl" htmlFor="qNumber">{t('Quotation number')}</label>
                <input id="qNumber" className="in" value={q.number} readOnly style={ro} />
              </div>
              <div>
                <label className="lbl" htmlFor="qDate">{t('Quotation date')}</label>
                <input id="qDate" className="in" type="date" required value={draft.quotationDate} disabled={!editable} onChange={(e) => edit({ quotationDate: e.target.value })} />
              </div>
              <div>
                <label className="lbl" htmlFor="qValid">{t('Valid until')}</label>
                <input id="qValid" className="in" type="date" value={draft.validUntil} disabled={!editable} onChange={(e) => edit({ validUntil: e.target.value })} />
              </div>
              <div>
                <label className="lbl" htmlFor="qCurrency">{t('Currency')}</label>
                <select id="qCurrency" className="in" value={draft.currency} disabled={!editable} onChange={(e) => changeCurrency(e.target.value as QuoteCurrency)}>
                  {QUOTE_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="span2">
                <label className="lbl" htmlFor="qCompany">{t('Company')}</label>
                <input id="qCompany" className="in" value={`${company} · ${q.company.number}`} readOnly style={ro} />
              </div>
              <div>
                <label className="lbl" htmlFor="qContact">{t('Contact')}</label>
                <select id="qContact" className="in" value={draft.contactId} disabled={!editable} onChange={(e) => edit({ contactId: e.target.value })}>
                  <option value="">{t('— none —')}</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="lbl" htmlFor="qLead">{t('Lead')}</label>
                <select id="qLead" className="in" value={draft.leadId} disabled={!editable} onChange={(e) => edit({ leadId: e.target.value })}>
                  <option value="">{t('— none —')}</option>
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="span4">
                <label className="lbl" htmlFor="qSubject">{t('Subject')}</label>
                <input
                  id="qSubject"
                  className="in"
                  maxLength={300}
                  aria-invalid={draft.subject.trim() === '' || undefined}
                  value={draft.subject}
                  disabled={!editable}
                  onChange={(e) => edit({ subject: e.target.value })}
                />
              </div>
            </div>
          </section>

          <section className="card flush">
            <div className="head">
              <h2>{t('Products & services')}</h2>
              <span className="q-hint">{t('Prices can be overridden per quotation. Totals update as you type.')}</span>
              <div className="grow" />
              {editable ? (
                <button type="button" className="btn sm" onClick={() => edit({ lines: [...draft.lines, blankLine(t('New line'), t('unit'))] })}>
                  {t('+ Add line')}
                </button>
              ) : null}
            </div>
            <LinesTable lines={draft.lines} currency={cur} editable={editable} onChange={(lines) => edit({ lines })} />
            <div className="q-foot">
              <div className="q-notes">
                <label className="lbl" htmlFor="qNotes">{t('Notes & terms shown on the PDF')}</label>
                <textarea id="qNotes" className="in" rows={5} value={draft.notes} disabled={!editable} onChange={(e) => edit({ notes: e.target.value })} />
              </div>
              <div className="totals" style={{ flex: '0 1 300px' }}>
                <span className="q-m">{t('Subtotal')}</span>
                <span className="num">{amount(totals.sub, cur)}</span>
                <span className="q-m">{t('Line discounts')}</span>
                <span className="num">− {amount(totals.disc, cur)}</span>
                <span className="q-m">
                  {t('Overall discount')}{' '}
                  <input
                    className="cell num q-pct"
                    aria-label={t('Overall discount %')}
                    type="number"
                    min="0"
                    max="100"
                    value={draft.overallDiscount}
                    disabled={!editable}
                    onChange={(e) => edit({ overallDiscount: e.target.value })}
                  />{' '}
                  %
                </span>
                <span className="num">− {amount(totals.overall, cur)}</span>
                <span className="q-m">{t('Net')}</span>
                <span className="num">{amount(totals.net, cur)}</span>
                <span className="q-m">
                  {t('GST')}{' '}
                  <input
                    className="cell num q-pct"
                    aria-label={t('GST %')}
                    type="number"
                    min="0"
                    max="100"
                    value={draft.taxRate}
                    disabled={!editable}
                    onChange={(e) => {
                      taxAuto.current = false;
                      edit({ taxRate: e.target.value });
                    }}
                  />{' '}
                  %
                </span>
                <span className="num">{amount(totals.tax, cur)}</span>
                <span className="big">
                  {t('Total')} <span>{cur}</span>
                </span>
                <span className="num big">{amount(totals.total, cur)}</span>
              </div>
            </div>
          </section>
        </div>

        <aside className="col-side">
          <section className="card">
            <h2>{t('Status')}</h2>
            <div className="q-steps">
              {steps.map((s, i) => {
                const h = lastFor(s);
                return (
                  <div key={s} className="step">
                    <span className={idx >= i ? 'd on' : 'd'} />
                    <span className={idx >= i ? undefined : 'q-m'}>
                      <strong>{quoteStatusText(t, s)}</strong>
                      {h ? ` · ${relative(h.at)} · ${h.text.replace(`${s} · `, '')}` : null}
                    </span>
                  </div>
                );
              })}
              <div className="step">
                <span className={idx === -1 ? 'd on q-bad' : 'd'} />
                <span className="q-m">
                  {t('Rejected / Expired|quote')}
                  {idx === -1 ? ` · ${quoteStatusText(t, q.status)}` : null}
                </span>
              </div>
            </div>
            <div className="q-btns">
              {q.locked ? (
                q.status === 'Accepted' && !q.projectId ? (
                  <button type="button" className="btn sm primary" disabled title={t('Available in release 3B')}>
                    {t('Convert to project')}
                  </button>
                ) : null
              ) : (
                <>
                  <button type="button" className="btn sm" disabled={!editable || action.isPending} onClick={() => void decide('accept')}>
                    {t('Mark accepted')}
                  </button>
                  <button type="button" className="btn sm" disabled={!editable || action.isPending} onClick={() => void decide('reject')}>
                    {t('Mark rejected')}
                  </button>
                  {q.status === 'Sent' ? (
                    <button type="button" className="btn sm" disabled={!editable || action.isPending} onClick={() => void negotiate()}>
                      {t('Negotiating|action')}
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </section>

          <section className="card">
            <h2>{t('Revisions')}</h2>
            <div className="q-revs">
              <div className="q-rev on">
                <strong>{editingRev ? t('Rev {n} · editing', { n: q.revision }) : t('Rev {n} · current', { n: q.revision })}</strong>
                <div className="m">{t('{n} lines · {total}', { n: draft.lines.length, total: formatMoney(totals.total, cur) })}</div>
              </div>
              {sentRevisions.map((r) => (
                <div key={r.revisionNo} className="q-rev">
                  <strong>{t('Rev {n} · sent {date}', { n: r.revisionNo, date: date(r.sentAt) })}</strong>
                  <div className="m">
                    {formatMoney(r.grandTotal, r.currency)} · {r.note ?? ''}
                  </div>
                </div>
              ))}
            </div>
            <div className="q-small">{t('Every send creates a frozen revision. Edits after sending always open a new revision.')}</div>
          </section>

          <section className="card">
            <h2>{t('History')}</h2>
            <div className="q-hist">
              {q.history.slice().reverse().map((h, i) => (
                <div key={i}>
                  {relative(h.at)} · {h.text}
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <h2>{t('On accept')}</h2>
            <div className="q-accept">
              {withBold(
                t('Lead moves to {won}, the company gets a {client} flag, and "Convert to project" creates a project with these line items as the scope. No new company or contact record is created.', {
                  won: bold('won'), client: bold('client'),
                }),
                { won: t('Won|lead'), client: t('Client') },
              )}
            </div>
          </section>
        </aside>
      </div>
      {dialog === 'send' ? <SendQuotationModal q={base.current} total={base.current.totals.total} onClose={() => setDialog(null)} /> : null}
      {dialog === 'pdf' ? <PdfPreviewModal q={base.current} onClose={() => setDialog(null)} /> : null}
    </>
  );
}
