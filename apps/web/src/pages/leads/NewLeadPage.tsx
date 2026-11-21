import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LEAD_TYPES, LeadCreate, type CompanyMatchHow, type LeadType } from '@dait-crm/shared';
import {
  useCompany, useCompanyPipeline, useDuplicateCheck, type DuplicateCandidate, type DuplicateResult,
} from '../../api/companies';
import { contactName, useContacts } from '../../api/contacts';
import { useSaveLead } from '../../api/leads';
import { useLookups, useUsers } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { AccessDenied } from '../../components/AccessDenied';
import type { ComboOption } from '../../components/Combobox';
import { CompanyPicker } from '../../components/CompanyPicker';
import { FormField } from '../../components/FormField';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { initials, leadStatusText, verificationBadge, verificationText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';
import { localDayPlus } from './FollowUpPanel';
import { leadSaveError, useLeadFormFields, type LeadFormValues } from './LeadFormFields';

/** `/leads/new`: the prototype's "Create lead or prospect" page (views-leads.js `V.leadForm`). */
export function NewLeadPage() {
  const t = useT();
  const me = useCurrentUser();
  if (!me.can('manage_leads')) {
    return (
      <>
        <Topbar title={t('Create lead or prospect')} crumb={<Crumb />} />
        <div className="page">
          <AccessDenied />
        </div>
      </>
    );
  }
  return <NewLeadForm />;
}

function Crumb() {
  const t = useT();
  return (
    <>
      <Link to="/leads">{t('Leads')}</Link> / {t('New|lead')}
    </>
  );
}

const candidateLabel = (c: Pick<DuplicateCandidate, 'number' | 'name'>) => `${c.number} · ${c.name}`;
/** Candidates the user may open carry their details; a hidden company is reported by number and name only. */
const canOpen = (c: DuplicateCandidate) => 'country' in c;

function howText(t: TFn, how: CompanyMatchHow): string {
  return how === 'domain' ? t('exact website domain') : how === 'legal_name' ? t('exact legal company name') : t('normalised name + country');
}
function confidenceText(t: TFn, how: CompanyMatchHow): string {
  return how === 'name_country' ? t('Medium|confidence') : t('High|confidence');
}

/** The matches of a duplicate check in rank order: the automatic (domain) match first, then those to review. */
function matchesOf(result: DuplicateResult): { candidate: DuplicateCandidate; how: CompanyMatchHow }[] {
  return [...(result.auto ? [{ candidate: result.auto, how: 'domain' as const }] : []), ...result.review];
}

function NewLeadForm() {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: lookups } = useLookups();
  const { data: users } = useUsers();
  const save = useSaveLead();
  const [formError, setFormError] = useState<string | null>(null);
  // The linked company's label, for a link made outside the picker's current search (preset, duplicate panel).
  const [linked, setLinked] = useState<ComboOption | null>(null);

  const sources = (lookups?.lead_source ?? []).filter((x) => x.isActive);
  const defaultSource = sources.find((x) => x.value === 'Manual Entry')?.value ?? sources[0]?.value ?? '';

  const resolver = useMemo<Resolver<LeadFormValues>>(() => {
    const zod = zodResolver(LeadCreate) as unknown as Resolver<LeadFormValues>;
    // Select values are strings in the form: ids become numbers, '' leaves the field out.
    return (values, ctx, opts) => {
      const out: Record<string, unknown> = {
        ...values,
        contactId: values.contactId ? Number(values.contactId) : undefined,
        assignedToId: values.assignedToId ? Number(values.assignedToId) : undefined,
        nextFollowUp: values.nextFollowUp || null,
      };
      return zod(out as unknown as LeadFormValues, ctx, opts);
    };
  }, []);

  const form = useForm<LeadFormValues>({
    resolver,
    defaultValues: {
      leadType: 'Lead',
      companyName: '',
      website: '',
      businessEmail: '',
      phone: '',
      // The prototype's lead form starts on India, where most leads come from.
      country: 'India',
      city: '',
      leadSource: defaultSource,
      sourceUrl: '',
      priority: 'Medium',
      nextFollowUp: localDayPlus(2),
      notes: '',
      status: 'New',
      linkCompanyId: undefined,
      contactId: '',
      // Release 1C role rule: the creator owns the lead unless they leave it to the allocation rules.
      assignedToId: String(me.id),
    },
  });
  const { register, handleSubmit, control, setValue, getValues } = form;
  const f = useLeadFormFields(form);

  // Lookups may arrive after the page opened: pick the default source then.
  useEffect(() => {
    if (defaultSource && !getValues('leadSource')) setValue('leadSource', defaultSource);
  }, [defaultSource]);

  const [leadType, companyName, website, businessEmail, country, linkCompanyId] = useWatch({
    control,
    name: ['leadType', 'companyName', 'website', 'businessEmail', 'country', 'linkCompanyId'],
  });

  // `?company=<id>` (company profile): start linked to that company with its details filled in.
  const raw = params.get('company');
  const preset = useCompany(raw ? Number(raw) : Number.NaN);
  const presetApplied = useRef(false);
  useEffect(() => {
    const c = preset.data;
    if (!c || presetApplied.current) return;
    presetApplied.current = true;
    link({ id: c.id, number: c.number, name: c.name });
    const fill = (k: 'companyName' | 'country' | 'website' | 'city', v: string | null) => {
      if (v && !getValues(k).trim()) setValue(k, v);
    };
    fill('companyName', c.name);
    fill('website', c.website);
    fill('city', c.city);
  }, [preset.data]);

  // The linked company's record, for the duplicate panel's "Linked to …" line (however it was chosen).
  const linkedCompany = useCompany(linkCompanyId ?? Number.NaN).data;
  const linkedLabel = linkedCompany && linkedCompany.id === linkCompanyId ? candidateLabel(linkedCompany) : undefined;
  // Country starts on the India default: each newly linked company replaces it with its own country, once per link.
  const countryFor = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!linkedCompany || linkedCompany.id !== linkCompanyId || countryFor.current === linkCompanyId) return;
    countryFor.current = linkCompanyId;
    if (linkedCompany.country) setValue('country', linkedCompany.country);
  }, [linkedCompany, linkCompanyId]);

  const hasKey = Boolean(companyName.trim() || website.trim() || businessEmail.trim());
  const dup = useDuplicateCheck({ name: companyName, website, businessEmail, country }, hasKey, 'leads');
  const duplicates = hasKey ? dup.data : undefined;

  // Contact person: the linked company's active contacts, the primary one chosen (and its email used) once per company.
  const contacts = useContacts({ companyId: linkCompanyId, page: 1, pageSize: 100, sort: 'lastName' }, linkCompanyId !== undefined);
  const contactsFor = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (linkCompanyId === undefined) {
      contactsFor.current = undefined;
      return;
    }
    const items = contacts.data?.items;
    if (!items || contacts.isPlaceholderData || contactsFor.current === linkCompanyId) return;
    contactsFor.current = linkCompanyId;
    const pick = items.find((c) => c.isPrimary) ?? items[0];
    setValue('contactId', pick ? String(pick.id) : '');
    if (pick?.businessEmail && !getValues('businessEmail').trim()) setValue('businessEmail', pick.businessEmail);
  }, [linkCompanyId, contacts.data, contacts.isPlaceholderData]);

  function link(c: Pick<DuplicateCandidate, 'id' | 'number' | 'name'>) {
    setLinked({ value: String(c.id), label: `${c.number} · ${c.name}` });
    setValue('linkCompanyId', c.id);
    setValue('contactId', '');
    if (!getValues('companyName').trim()) setValue('companyName', c.name);
  }

  function unlink() {
    setLinked(null);
    setValue('linkCompanyId', undefined);
    setValue('contactId', '');
  }

  function submit(v: LeadFormValues) {
    save.mutate(
      { body: v as unknown as LeadCreate },
      {
        onSuccess: (saved) => {
          toast(t('{number} created|lead', { number: saved.number }));
          navigate(`/leads/${saved.id}`);
        },
        onError: (err) => setFormError(leadSaveError(err, form, t)),
      },
    );
  }

  // Mirrors the API: Administrator / Manager may assign anyone active; everyone else only themselves.
  const assignees = me.can('view_all_leads')
    ? (users ?? []).filter((u) => u.isActive && u.id !== me.id).sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const typeHint: Record<LeadType, string> = {
    Lead: t("Has expressed interest in DAIT Partners' services (website form, referral, direct contact)."),
    Prospect: t('Identified through research, directories or Google Places. Contact details optional.'),
  };

  return (
    <>
      <Topbar title={t('Create lead or prospect')} crumb={<Crumb />}>
        <span className="nl-idnote">{t('Lead ID will be generated on save')}</span>
      </Topbar>
      <form
        className="page cols"
        noValidate
        aria-label={t('Create lead or prospect')}
        onSubmit={(e) => {
          setFormError(null);
          void handleSubmit(submit)(e);
        }}
      >
        <div className="col-main">
          <section className="card" aria-labelledby="nl-type-title">
            <div>
              <h2 id="nl-type-title">
                {t('Lead type')}
                <span className="req" aria-hidden="true">*</span>
              </h2>
              <div className="nl-sub">{t('Both types live in this module. A prospect can be saved with company name and country alone.')}</div>
            </div>
            <div className="grid2" role="radiogroup" aria-labelledby="nl-type-title">
              {LEAD_TYPES.map((x) => (
                <label key={x} className={leadType === x ? 'radio-card on' : 'radio-card'}>
                  <input type="radio" value={x} {...register('leadType')} />
                  <span>
                    <strong>{x === 'Lead' ? t('Lead') : t('Prospect')}</strong>
                    <small>{typeHint[x]}</small>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="card" aria-labelledby="nl-co-title">
            <div>
              <h2 id="nl-co-title">{t('Company')}</h2>
              <div className="nl-sub">{t('Link to an existing company record so leads never duplicate organisations.')}</div>
            </div>
            <div className="grid2">
              {f.input('companyName', t('Company name'), { required: true, span: true })}
              <div className="span2" aria-live="polite">
                <DuplicatePanel result={duplicates} linkedId={linkCompanyId} linkedLabel={linkedLabel} onUse={link} />
              </div>
              <CompanyPicker
                id="ld-linkCompanyId"
                label={t('Company (existing record)')}
                value={linkCompanyId}
                selected={linked}
                showNumber
                emptyLabel={t('Create new company on save')}
                onClear={unlink}
                onChange={(id) => {
                  setValue('linkCompanyId', id);
                  setValue('contactId', '');
                }}
              />
              <FormField id="ld-contactId" label={t('Contact person')} error={f.err('contactId')}>
                <select id="ld-contactId" className="in" disabled={linkCompanyId === undefined} {...f.aria('contactId')} {...register('contactId')}>
                  <option value="">{t('— none yet —')}</option>
                  {(contacts.data?.items ?? []).map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {contactName(c)} · {c.designation || c.contactType}
                    </option>
                  ))}
                </select>
              </FormField>
              {f.input('website', t('Company website'), { type: 'url', placeholder: 'https://' })}
              {f.input('businessEmail', t('Business email'), { type: 'email' })}
              {f.input('phone', t('Phone number'), { type: 'tel', placeholder: '+91 …' })}
              {f.country()}
              {f.input('city', t('City'))}
            </div>
          </section>

          <section className="card" aria-labelledby="nl-src-title">
            <div>
              <h2 id="nl-src-title">{t('Source')}</h2>
              <div className="nl-sub">{t('Values come from the shared dropdown configuration, not hard-coded in the form.')}</div>
            </div>
            <div className="grid2">
              {f.leadSource()}
              {f.input('sourceUrl', t('Source URL'), { type: 'url', placeholder: 'https://' })}
              <div className="span2 nl-sub">
                <span className="badge b-grey">{t('Import batch: —')}</span> {t('Set automatically for CSV and Google Places imports.')}
              </div>
            </div>
          </section>

          <section className="card" aria-labelledby="nl-as-title">
            <div>
              <h2 id="nl-as-title">{t('Assignment & follow-up')}</h2>
              <div className="nl-sub">
                {t('Assigning creates a task for the owner and sends them a notification. A follow-up date creates a dated task automatically.')}
              </div>
            </div>
            <div className="grid2">
              <FormField id="ld-assignedToId" label={t('Assigned to')} error={f.err('assignedToId')}>
                <select
                  id="ld-assignedToId"
                  className={f.err('assignedToId') ? 'in err' : 'in'}
                  {...f.aria('assignedToId')}
                  {...register('assignedToId')}
                >
                  <option value="">{t('Leave unassigned · allocation rules decide')}</option>
                  <option value={String(me.id)}>{t('{name} (me)', { name: me.name })}</option>
                  {assignees.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </FormField>
              {f.priority(t('Lead priority'), false)}
              <FormField id="ld-status" label={t('Lead status')}>
                {/* A new lead always starts as New; status changes happen on the lead page. */}
                <select id="ld-status" className="in" disabled {...register('status')}>
                  <option value="New">{leadStatusText(t, 'New')}</option>
                </select>
              </FormField>
              {f.input('nextFollowUp', t('Next follow-up date'), { type: 'date' })}
              {f.notes(t('Lead notes'), 4)}
            </div>
          </section>

          {formError ? (
            <div className="note warn" role="alert">
              {formError}
            </div>
          ) : null}
          <div className="nl-foot">
            <Link to="/leads" className="btn">
              {t('Cancel')}
            </Link>
            <div className="grow" />
            <button type="submit" className="btn primary" disabled={save.isPending}>
              {t('Create lead')}
            </button>
          </div>
        </div>

        <aside className="col-side">
          <section className="card" aria-labelledby="nl-save-title">
            <h2 id="nl-save-title">{t('What happens on save')}</h2>
            <ol className="nl-steps">
              <li>{t('Duplicate check runs on website domain, legal name and normalised name + country. Uncertain matches are shown for you to decide.')}</li>
              <li>{t('The lead is linked to the chosen company. No new company record is created when one exists.')}</li>
              <li>{t('The owner gets an in-app notification and a task to review the lead.')}</li>
              <li>{t('A follow-up task is created for the follow-up date.')}</li>
              <li className="nl-later">
                {t('AI enrichment')} <span className="badge b-grey">{t('Available in release 4')}</span>
              </li>
            </ol>
          </section>
          <LinkedCompanyPreview companyId={linkCompanyId} />
        </aside>
      </form>
    </>
  );
}

/** The inline duplicate check under Company name (prototype `#dupBox`). */
function DuplicatePanel({
  result, linkedId, linkedLabel, onUse,
}: {
  result: DuplicateResult | undefined;
  linkedId: number | undefined;
  linkedLabel: string | undefined;
  onUse: (c: DuplicateCandidate) => void;
}) {
  const t = useT();
  const matches = result ? matchesOf(result) : [];
  if (linkedId !== undefined) {
    const hit = matches.find((m) => m.candidate.id === linkedId);
    const label = hit ? candidateLabel(hit.candidate) : linkedLabel;
    if (!label) return null;
    return (
      <div className="note ok" role="status">
        {hit
          ? t('Linked to existing company {company} (matched on {how}).', { company: label, how: howText(t, hit.how) })
          : t('Linked to existing company {company}.', { company: label })}
      </div>
    );
  }
  if (!result) return null;
  if (matches.length === 0) {
    return (
      <div className="note ok" role="status">
        {t('No duplicate found for this name, website or email domain. A new company record will be created on save.')}
      </div>
    );
  }
  const first = matches[0]!;
  return (
    <div className="note warn nl-dup" role="status">
      <div className="grow nl-dup-body">
        <div className="nl-dup-title">
          {matches.length === 1
            ? t('Possible duplicate: 1 existing company matches')
            : t('Possible duplicate: {n} existing companies match', { n: matches.length })}
        </div>
        <ul className="nl-dup-list">
          {matches.map(({ candidate }) => (
            <li key={candidate.id}>{canOpen(candidate) ? <CandidateLine c={candidate} /> : `${candidate.number} ${candidate.name} · ${t('no access')}`}</li>
          ))}
        </ul>
        <div>
          {t('Matched on {how} · confidence {confidence}.', { how: howText(t, first.how), confidence: confidenceText(t, first.how) })}{' '}
          {result.auto ? t('The lead will be linked to it on save.') : t('Not auto-merged: please confirm.')}
        </div>
      </div>
      {canOpen(first.candidate) ? (
        <div className="nl-dup-actions">
          <a className="btn sm" href={`/companies/${first.candidate.id}`} target="_blank" rel="noreferrer">
            {t('View')}
          </a>
          <button type="button" className="btn sm primary" onClick={() => onUse(first.candidate)}>
            {t('Use existing company')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** name · domain · country · contacts · open leads of a candidate the user may open. */
function CandidateLine({ c }: { c: DuplicateCandidate }) {
  const t = useT();
  const { data: company } = useCompany(c.id);
  const { data: pipeline } = useCompanyPipeline(c.id);
  return (
    <>
      {c.legalName || c.name} · {c.domain || t('no website')} · {c.country || '—'} ·{' '}
      {t('{n} contacts', { n: company ? company.contactCount : '…' })} · {t('{n} open leads', { n: pipeline ? pipeline.open : '…' })}
    </>
  );
}

/** Side card: the company the lead will be linked to, or what happens without one. */
function LinkedCompanyPreview({ companyId }: { companyId: number | undefined }) {
  const t = useT();
  const { data: c } = useCompany(companyId ?? Number.NaN);
  const { data: pipeline } = useCompanyPipeline(companyId ?? Number.NaN);
  const show = companyId !== undefined && c && c.id === companyId;
  return (
    <section className="card" aria-labelledby="nl-prev-title">
      <h2 id="nl-prev-title">{t('Linked company preview')}</h2>
      {!show ? (
        <div className="nl-sub">{t('A new company record will be created on save, unless a duplicate is found above.')}</div>
      ) : (
        <>
          <div className="nl-co">
            <span className="logo" aria-hidden="true">
              {initials(c.name)}
            </span>
            <div style={{ minWidth: 0 }}>
              <Link to={`/companies/${c.id}`} className="nl-co-name">
                {c.legalName || c.name}
              </Link>
              <div className="nl-sub">
                {[c.industry || t('Industry unknown'), [c.city, c.country].filter(Boolean).join(', '), c.employeeRange ? t('{range} employees', { range: c.employeeRange }) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
          </div>
          <dl className="kv nl-kv">
            <dt>{t('Contacts')}</dt>
            <dd>{c.contactCount}</dd>
            <dt>{t('Open leads')}</dt>
            <dd>
              {pipeline
                ? [String(pipeline.open), pipeline.byStatus.map((s) => `${leadStatusText(t, s.status)} ${s.count}`).join(', ')].filter(Boolean).join(' · ')
                : '…'}
            </dd>
            <dt>{t('Verification')}</dt>
            <dd>
              <span className={verificationBadge(c.verificationStatus)}>{verificationText(t, c.verificationStatus)}</span>
            </dd>
          </dl>
        </>
      )}
    </section>
  );
}
