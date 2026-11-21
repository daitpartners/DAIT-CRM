import { useState } from 'react';
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
import { ComposeContext, ComposePanel, useComposeControl } from './ComposePanel';
import { EditProfileModal } from './EditProfileModal';
import { FollowUpPanel } from './FollowUpPanel';
import { LeadActionsFooter, LeadActionsModal } from './LeadActionsFooter';
import { LeadModal } from './LeadModal';
import { ProfileCard } from './ProfileCard';
import { SideColumn } from './SideColumn';
import { SkillsModal } from './SkillsModal';
import { SwitchContactModal } from './SwitchContactModal';
import { useActionError } from './staleToast';

type Dialog = 'contact' | 'edit' | 'profile' | 'skills' | null;

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
  return <LeadView lead={lead} />;
}

function contactTypeText(t: TFn, type: string): string {
  return type === 'call' ? t('Call') : type === 'email' ? t('Email') : type === 'meeting' ? t('Meeting') : type;
}

/**
 * Orchestration only, as the prototype's V.leads2: topbar (number, created, last contact; Email, Edit profile),
 * PROFILE card, then composer + Follow-up / Emails / Calls beside the side column. Edit profile also holds the
 * lead actions the prototype has no button for (Edit lead details, Switch contact, Archive).
 */
function LeadView({ lead }: { lead: LeadFull }) {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const confirm = useConfirm();
  const onFail = useActionError();
  const action = useLeadAction();
  const { date } = useFormatDate();
  const { data: lookups } = useLookups();
  const [dialog, setDialog] = useState<Dialog>(null);
  const compose = useComposeControl();

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

  const leadActions = {
    lead,
    onEditLead: () => setDialog('edit'),
    onSwitchContact: lead.companyId !== null ? () => setDialog('contact') : undefined,
    onArchive: () => {
      setDialog(null);
      void archive();
    },
  };

  const sub = (
    <span className="l2line">
      {t('Lead created:')} <b>{date(lead.createdAt)}</b>
      <i>|</i>
      {t('Last contact:')} <b>{lead.lastContact ? `${contactTypeText(t, lead.lastContact.type)} · ${date(lead.lastContact.at)}` : '—'}</b>
    </span>
  );

  return (
    <ComposeContext.Provider value={compose}>
      <Topbar title={lead.number} sub={sub} badges={archived ? <span className="badge b-grey">{t('Archived|lead')}</span> : undefined}>
        <div className="hdr-actions">
          <button type="button" className="btn primary" onClick={compose.openEmail}>
            {Icons.send}
            {t('Email')}
          </button>
          {live ? (
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
          {closed ? (
            <div className="closed-banner">
              <strong>{leadStatusText(t, lead.status)}</strong>
              <span>{t('This lead is closed. Choose an open status in the Follow-up tab to reopen it.')}</span>
            </div>
          ) : null}
        </ProfileCard>
        <div className="cols">
          <div className="col-main">
            <ComposePanel lead={lead} statuses={statuses} live={live} />
            <FollowUpPanel lead={lead} statuses={statuses} live={live} />
          </div>
          <SideColumn lead={lead} live={live} onEditSkills={canProfile ? () => setDialog('skills') : undefined} />
        </div>
      </div>
      {dialog === 'contact' ? <SwitchContactModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'edit' ? <LeadModal lead={lead} onClose={() => setDialog(null)} /> : null}
      {dialog === 'profile' && lead.contact && canProfile ? (
        <EditProfileModal contact={lead.contact} lead={lead} onClose={() => setDialog(null)} footer={<LeadActionsFooter {...leadActions} />} />
      ) : null}
      {dialog === 'profile' && !(lead.contact && canProfile) ? <LeadActionsModal {...leadActions} onClose={() => setDialog(null)} /> : null}
      {dialog === 'skills' && lead.contact ? <SkillsModal contact={lead.contact} onClose={() => setDialog(null)} /> : null}
    </ComposeContext.Provider>
  );
}
