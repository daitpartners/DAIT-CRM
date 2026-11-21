import { useCurrentUser } from '../../api/useCurrentUser';
import { PlaceholderCard } from '../../components/PlaceholderCard';
import { useT } from '../../i18n/useT';
import { SystemMailbox } from './SystemMailbox';

/**
 * Settings → Email & calendar connections (prototype V.connectionsCard). Each user's own mailbox comes with
 * release 2 (placeholder); administrators also see the 1A system mailbox here.
 */
export function Connections() {
  const t = useT();
  const me = useCurrentUser();
  return (
    <>
      <PlaceholderCard
        title={t('Email & calendar connections')}
        release="2"
        hint={t('Each user connects their own mailbox. Sending, receiving and calendar sync run through it.')}
      />
      {me.can('view_admin_settings') ? <SystemMailbox /> : null}
    </>
  );
}

/** Settings → Email templates (prototype V.templatesCard): release 2. */
export function EmailTemplates() {
  const t = useT();
  return (
    <PlaceholderCard
      title={t('Email templates')}
      release="2"
      hint={t('Available in every compose box. Write templates here or upload Outlook .oft files.')}
    />
  );
}
