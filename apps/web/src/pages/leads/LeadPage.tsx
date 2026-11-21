import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isClosedStatus } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useLeadAction, useLead, useSaveLead, type LeadFull } from '../../api/leads';
import { useLookups } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { CompanyPicker } from '../../components/CompanyPicker';
import { useConfirm } from '../../components/ConfirmDialog';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { errorText, leadStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { CloseLeadModal } from './CloseLeadModal';
import { LeadModal } from './LeadModal';
import { LogCallModal } from './LogCallModal';
import { MoreMenu, type MenuItem } from './MoreMenu';
import { ProfileBox } from './ProfileBox';
import { StatusStepper } from './StatusStepper';
import { SwitchContactModal } from './SwitchContactModal';
import { Timeline } from './Timeline';
import { TransferModal, UnassignModal } from './TransferModal';
import { useActionError } from './staleToast';

type Dialog = 'log-call' | 'transfer' | 'close' | 'contact' | 'edit' | 'unassign' | null;

/** `/leads/:id`: header actions, profile on the left, status stepper and timeline on the right. */
export function LeadPage() {
  const t = useT();
  const id = Number(useParams().id);
  const { data: lead, error, isPending } = useLead(id);
  const crumb = <Link to="/leads">{t('Leads')}</Link>;

  if (!Number.isInteger(id) || error || isPending || !lead) {
    const code = !Number.isInteger(id) ? 'not_found' : error instanceof ApiError ? error.code : error ? 'unknown' : null;
    return (
      <>
        <Topbar title={code ? errorText(t, code) : t('Loading…')} crumb={crumb} />
        <div className="page">
          {code ? (
            <div className="card empty" role="alert">
              {code === 'not_found' ? t('This lead does not exist or you do not have access to it.') : errorText(t, code)}{' '}
              <Link to="/leads">{t('Back to leads')}</Link>
            </div>
          ) : null}
        </div>
      </>
    );
  }
  return <LeadView lead={lead} crumb={crumb} />;
}

function LeadView({ lead, crumb }: { lead: LeadFull; crumb: ReactNode }) {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const confirm = useConfirm();
  const onFail = useActionError();
  const action = useLeadAction();
  const { data: lookups } = useLookups();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [followUp, setFollowUp] = useState<string | null>(null);

  const canManage = me.can('manage_leads');
  const archived = lead.archivedAt !== null;
  const closed = isClosedStatus(lead.status);
  const live = canManage && !archived;
  const statuses = lookups?.lead_status ?? [];

  function run(input: Parameters<typeof action.mutate>[0], done: string) {
    action.mutate(input, { onSuccess: () => toast(done), onError: (err) => onFail(err, true) });
  }

  async function archive() {
    const ok = await confirm({
      title: t('Archive lead?'),
      body: t('{number} will no longer appear in lists, tasks or counts. An administrator or manager can restore it.', { number: lead.number }),
      confirmLabel: t('Archive'),
      danger: true,
    });
    if (ok) run({ lead, action: 'archive', body: {} }, t('Lead archived'));
  }

  const more: MenuItem[] = live
    ? [
        { id: 'edit', label: t('Edit details'), onSelect: () => setDialog('edit') },
        ...(lead.companyId !== null ? [{ id: 'contact', label: t('Switch contact'), onSelect: () => setDialog('contact') }] : []),
        ...(me.can('view_all_leads') && lead.assignedTo
          ? [{ id: 'unassign', label: t('Unassign'), onSelect: () => setDialog('unassign') }]
          : []),
        { id: 'archive', label: t('Archive'), danger: true, onSelect: () => void archive() },
      ]
    : [];

  const sub = [lead.number, leadStatusText(t, lead.status), lead.assignedTo?.name ?? t('Unassigned')].join(' · ');

  return (
    <>
      <Topbar
        title={lead.companyName}
        sub={sub}
        crumb={crumb}
        badges={archived ? <span className="badge b-grey">{t('Archived|lead')}</span> : undefined}
      >
        {live ? (
          <div className="actions-row">
            {me.can('claim_leads') && lead.assignedTo === null ? (
              <button
                type="button"
                className="btn primary"
                disabled={action.isPending}
                onClick={() => run({ lead, action: 'claim', body: {} }, t('{number} is now yours', { number: lead.number }))}
              >
                {t('Claim')}
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => setDialog('log-call')}>
              {t('Log call')}
            </button>
            <button
              type="button"
              className="btn"
              aria-expanded={followUp !== null}
              disabled={closed}
              title={closed ? t('A closed lead has no follow-up') : undefined}
              onClick={() => setFollowUp(followUp === null ? (lead.nextFollowUp ?? '') : null)}
            >
              {t('Set follow-up')}
            </button>
            {me.can('transfer_leads') ? (
              <button type="button" className="btn" onClick={() => setDialog('transfer')}>
                {t('Transfer')}
              </button>
            ) : null}
            {!closed ? (
              <button type="button" className="btn" onClick={() => setDialog('close')}>
                {t('Close lead')}
              </button>
            ) : null}
            <MoreMenu items={more} />
          </div>
        ) : canManage && archived ? (
          <button
            type="button"
            className="btn primary"
            disabled={action.isPending}
            onClick={() => run({ lead, action: 'unarchive', body: {} }, t('Lead restored'))}
          >
            {t('Restore')}
          </button>
        ) : null}
      </Topbar>
      <div className="page">
        {followUp !== null && live && !closed ? (
          <FollowUpBar lead={lead} initial={followUp} onDone={() => setFollowUp(null)} />
        ) : null}
        {archived ? (
          <div className="note warn" role="status">
            {t('This lead is archived. It no longer appears in lists, tasks or counts.')}
          </div>
        ) : null}
        {lead.companyId === null && live ? <ChooseCompany lead={lead} /> : null}
        <div className="cols">
          <aside className="col-side" aria-label={t('Lead profile')}>
            <ProfileBox lead={lead} />
          </aside>
          <div className="col-main">
            <section className="card" aria-labelledby="lead-status-title">
              <h2 id="lead-status-title" className="card-title">
                {t('Status')}
              </h2>
              <StatusStepper
                statuses={statuses}
                current={lead.status}
                disabled={!live || action.isPending}
                onChange={(status) =>
                  run({ lead, action: 'status', body: { status } }, t('Status changed to {status}', { status: leadStatusText(t, status) }))
                }
              />
              {closed ? (
                <div className="closed-banner">
                  <strong>{leadStatusText(t, lead.status)}</strong>
                  <span>{t('This lead is closed. Choose an open status above to reopen it.')}</span>
                </div>
              ) : null}
            </section>
            <Timeline lead={lead} />
          </div>
        </div>
      </div>
      {dialog === 'log-call' ? <LogCallModal lead={lead} statuses={statuses} onClose={() => setDialog(null)} /> : null}
      {dialog === 'transfer' ? <TransferModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'close' ? <CloseLeadModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'contact' ? <SwitchContactModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'unassign' ? <UnassignModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'edit' ? <LeadModal lead={lead} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

/** Inline "Set follow-up": a date, Save, Clear (when one is set) and Cancel. */
function FollowUpBar({ lead, initial, onDone }: { lead: LeadFull; initial: string; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const onFail = useActionError();
  const save = useSaveLead();
  const [value, setValue] = useState(initial);

  function submit(next: string | null) {
    save.mutate(
      { id: lead.id, body: { nextFollowUp: next, updatedAt: lead.updatedAt } },
      {
        onSuccess: () => {
          toast(next ? t('Follow-up set') : t('Follow-up cleared'));
          onDone();
        },
        onError: (err) => onFail(err, true),
      },
    );
  }

  return (
    <form
      className="card inline-bar"
      aria-label={t('Set follow-up')}
      onSubmit={(e) => {
        e.preventDefault();
        if (value) submit(value);
      }}
    >
      <label htmlFor="lead-followup" className="lbl">
        {t('Follow-up date')}
      </label>
      <input id="lead-followup" type="date" className="in" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      <button type="submit" className="btn sm primary" disabled={!value || save.isPending}>
        {t('Save')}
      </button>
      {lead.nextFollowUp ? (
        <button type="button" className="btn sm" disabled={save.isPending} onClick={() => submit(null)}>
          {t('Clear')}
        </button>
      ) : null}
      <button type="button" className="btn sm" onClick={onDone}>
        {t('Cancel')}
      </button>
    </form>
  );
}

/** A lead imported without a company (unresolved duplicate): link one or create it from the lead. */
function ChooseCompany({ lead }: { lead: LeadFull }) {
  const t = useT();
  const toast = useToast();
  const onFail = useActionError();
  const action = useLeadAction();
  const [companyId, setCompanyId] = useState<number | undefined>(undefined);
  const [missing, setMissing] = useState(false);

  function resolve(target: number | 'create') {
    action.mutate(
      { lead, action: 'resolve-company', body: { companyId: target } },
      {
        onSuccess: (saved) => toast(t('Lead linked to {company}', { company: saved.company?.name ?? '' })),
        onError: (err) => onFail(err, true),
      },
    );
  }

  return (
    <section className="card" aria-labelledby="lead-choose-co">
      <h2 id="lead-choose-co" className="card-title">
        {t('Choose company')}
      </h2>
      <p className="muted-text">
        {t('This lead was imported without a company because it may match one that already exists. Link it, or create a new company from the lead.')}
      </p>
      <div className="inline-bar">
        <CompanyPicker
          id="lead-resolve-company"
          label={t('Existing company')}
          value={companyId}
          invalid={missing}
          errorText={t('Choose a company')}
          onChange={(v) => {
            setCompanyId(v);
            setMissing(false);
          }}
          className="grow"
        />
        <button
          type="button"
          className="btn primary"
          disabled={action.isPending}
          onClick={() => (companyId === undefined ? setMissing(true) : resolve(companyId))}
        >
          {t('Link company')}
        </button>
        <button type="button" className="btn" disabled={action.isPending} onClick={() => resolve('create')}>
          {t('Create new company')}
        </button>
      </div>
    </section>
  );
}
