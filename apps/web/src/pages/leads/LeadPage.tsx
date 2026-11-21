import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isClosedStatus } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useLeadAction, useLead, type LeadFull } from '../../api/leads';
import { useLookups } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { useConfirm } from '../../components/ConfirmDialog';
import { Icons } from '../../components/Icons';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText, leadStatusText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';
import { ChooseCompany } from './ChooseCompany';
import { CloseLeadModal } from './CloseLeadModal';
import { ComposePanel } from './ComposePanel';
import { EditProfileModal } from './EditProfileModal';
import { FollowUpPanel } from './FollowUpPanel';
import { LeadModal } from './LeadModal';
import { MoreMenu, type MenuItem } from './MoreMenu';
import { ProfileCard } from './ProfileCard';
import { SideColumn } from './SideColumn';
import { SkillsModal } from './SkillsModal';
import { StatusStepper } from './StatusStepper';
import { SwitchContactModal } from './SwitchContactModal';
import { TransferModal, UnassignModal } from './TransferModal';
import { useActionError } from './staleToast';

type Dialog = 'transfer' | 'close' | 'contact' | 'edit' | 'unassign' | 'profile' | 'skills' | null;

/** `/leads/:id`: the prototype's lead page (views-lead-detail.js + views-leads2.js), or the error / loading state. */
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

function contactTypeText(t: TFn, type: string): string {
  return type === 'call' ? t('Call') : type === 'email' ? t('Email') : type === 'meeting' ? t('Meeting') : type;
}

/**
 * Orchestration only: topbar (number, created, last contact, owner; Email placeholder, Edit profile, More ▾),
 * PROFILE card with the status stepper, then composer + Follow-up / Emails / Calls beside the side column.
 */
function LeadView({ lead, crumb }: { lead: LeadFull; crumb: ReactNode }) {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const confirm = useConfirm();
  const onFail = useActionError();
  const action = useLeadAction();
  const { date } = useFormatDate();
  const { data: lookups } = useLookups();
  const [dialog, setDialog] = useState<Dialog>(null);

  const canManage = me.can('manage_leads');
  const archived = lead.archivedAt !== null;
  const closed = isClosedStatus(lead.status);
  const live = canManage && !archived;
  const canProfile = me.can('manage_companies') && lead.contact !== null && !archived;
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

  const item = (id: Exclude<Dialog, null>, label: string): MenuItem => ({ id, label, onSelect: () => setDialog(id) });
  const more: MenuItem[] = live
    ? [
        item('edit', t('Edit lead')),
        ...(me.can('transfer_leads') ? [item('transfer', t('Transfer'))] : []),
        ...(!closed ? [item('close', t('Close lead'))] : []),
        ...(lead.companyId !== null ? [item('contact', t('Switch contact'))] : []),
        ...(me.can('view_all_leads') && lead.assignedTo ? [item('unassign', t('Unassign'))] : []),
        { id: 'archive', label: t('Archive'), danger: true, onSelect: () => void archive() },
      ]
    : [];

  const sub = (
    <span className="l2line">
      {t('Lead created:')} <b>{date(lead.createdAt)}</b>
      <i>|</i>
      {t('Last contact:')} <b>{lead.lastContact ? `${contactTypeText(t, lead.lastContact.type)} · ${date(lead.lastContact.at)}` : '—'}</b>
      <i>|</i>
      {t('Owner:')} <b>{lead.assignedTo?.name ?? t('Unassigned')}</b>
    </span>
  );

  return (
    <>
      <Topbar title={lead.number} sub={sub} crumb={crumb} badges={archived ? <span className="badge b-grey">{t('Archived|lead')}</span> : undefined}>
        <div className="hdr-actions">
          {live && me.can('claim_leads') && lead.assignedTo === null ? (
            <button
              type="button"
              className="btn primary"
              disabled={action.isPending}
              onClick={() => run({ lead, action: 'claim', body: {} }, t('{number} is now yours', { number: lead.number }))}
            >
              {t('Claim')}
            </button>
          ) : null}
          <button type="button" className="btn primary" disabled title={t('Available in release 2')}>
            {Icons.send}
            {t('Email')}
          </button>
          {canProfile ? (
            <button type="button" className="btn" onClick={() => setDialog('profile')}>
              {Icons.edit}
              {t('Edit profile')}
            </button>
          ) : null}
          {canManage && archived ? (
            <button type="button" className="btn" disabled={action.isPending} onClick={() => run({ lead, action: 'unarchive', body: {} }, t('Lead restored'))}>
              {t('Restore')}
            </button>
          ) : null}
          <MoreMenu items={more} />
        </div>
      </Topbar>
      <div className="page">
        {archived ? (
          <div className="note warn" role="status">
            {t('This lead is archived. It no longer appears in lists, tasks or counts.')}
          </div>
        ) : null}
        {lead.companyId === null && live ? <ChooseCompany lead={lead} /> : null}
        <ProfileCard lead={lead}>
          <StatusStepper
            statuses={statuses}
            current={lead.status}
            disabled={!live || action.isPending}
            onChange={(status) => run({ lead, action: 'status', body: { status } }, t('Status changed to {status}', { status: leadStatusText(t, status) }))}
          />
          {closed ? (
            <div className="closed-banner">
              <strong>{leadStatusText(t, lead.status)}</strong>
              <span>{t('This lead is closed. Choose an open status above to reopen it.')}</span>
            </div>
          ) : null}
        </ProfileCard>
        <div className="cols">
          <div className="col-main">
            <ComposePanel lead={lead} statuses={statuses} live={live} />
            <FollowUpPanel lead={lead} statuses={statuses} live={live} />
          </div>
          <SideColumn lead={lead} onEditSkills={canProfile ? () => setDialog('skills') : undefined} />
        </div>
      </div>
      {dialog === 'transfer' ? <TransferModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'close' ? <CloseLeadModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'contact' ? <SwitchContactModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'unassign' ? <UnassignModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'edit' ? <LeadModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'profile' && lead.contact ? <EditProfileModal contact={lead.contact} onClose={() => setDialog(null)} /> : null}
      {dialog === 'skills' && lead.contact ? <SkillsModal contact={lead.contact} onClose={() => setDialog(null)} /> : null}
    </>
  );
}
