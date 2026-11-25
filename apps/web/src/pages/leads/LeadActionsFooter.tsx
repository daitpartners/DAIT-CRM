import type { LeadFull } from '../../api/leads';
import { Modal } from '../../components/Modal';
import { useT } from '../../i18n/useT';

type ActionsProps = {
  lead: LeadFull;
  onEditLead: () => void;
  /** Left out when the lead has no company to pick a contact from. */
  onSwitchContact?: () => void;
  onArchive: () => void;
  /** Delete lead… (Administrators, `delete_leads`); left out for everyone else. */
  onDelete?: () => void;
};

/**
 * The lead-level actions the prototype has no button for (owner-approved home: the Edit profile dialog):
 * Edit lead details, Switch contact, Archive and (Administrators) Delete lead…. Each opens its own dialog.
 */
export function LeadActionsFooter({ lead, onEditLead, onSwitchContact, onArchive, onDelete }: ActionsProps) {
  const t = useT();
  return (
    <div className="lead-acts" role="group" aria-label={t('Lead {number}', { number: lead.number })}>
      <button type="button" className="btn sm" onClick={onEditLead}>
        {t('Edit lead details')}
      </button>
      {onSwitchContact ? (
        <button type="button" className="btn sm" onClick={onSwitchContact}>
          {t('Switch contact')}
        </button>
      ) : null}
      <div className="grow" />
      <button type="button" className="btn sm danger" onClick={onArchive}>
        {t('Archive')}
      </button>
      {onDelete ? (
        <button type="button" className="btn sm danger" onClick={onDelete}>
          {t('Delete lead…')}
        </button>
      ) : null}
    </div>
  );
}

/** "Edit profile" on a lead without a contact person: only the lead actions (the Add contact card covers the contact). */
export function LeadActionsModal(props: ActionsProps & { onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={t('Edit lead')} onClose={props.onClose}>
      <p className="dim">{t('This lead has no contact person yet. Add one from the No contact yet card.')}</p>
      <LeadActionsFooter {...props} />
    </Modal>
  );
}
