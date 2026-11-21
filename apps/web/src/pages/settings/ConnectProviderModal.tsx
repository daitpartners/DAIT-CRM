import { CONNECT_PERSONAL_URL } from '../../api/mailboxes';
import { Modal } from '../../components/Modal';
import { useT } from '../../i18n/useT';
import { MicrosoftLogo } from './MicrosoftLogo';

/** Prototype "Other provider" → "Connect a mailbox". Microsoft 365 only for now (owner, 22 Nov 2026). */
export function ConnectProviderModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const later = (letter: string, colour: string, title: string, desc: string) => (
    <button type="button" className="btn provider" disabled>
      <span className="provider-mark" style={{ color: colour }} aria-hidden="true">
        {letter}
      </span>
      <span>
        <strong>{title}</strong>
        <span className="provider-desc">
          {desc} · {t('Coming later')}
        </span>
      </span>
    </button>
  );
  return (
    <Modal
      title={t('Connect a mailbox')}
      onClose={onClose}
      actions={
        <button type="button" className="btn" onClick={onClose}>
          {t('Cancel')}
        </button>
      }
    >
      <div className="provider-list">
        <a className="btn provider" href={CONNECT_PERSONAL_URL}>
          <MicrosoftLogo />
          <span>
            <strong>{t('Microsoft 365 / Outlook')}</strong>
            <span className="provider-desc">{t('Business Basic, Standard or Premium. Mail + calendar via Microsoft Graph. Recommended.')}</span>
          </span>
        </a>
        {later('G', '#1A73E8', t('Google Workspace / Gmail'), t('Mail + calendar via Google APIs.'))}
        {later('O', '#6A5E86', t('Other (IMAP / SMTP)'), t('Mail only. Enter server details manually.'))}
      </div>
    </Modal>
  );
}
