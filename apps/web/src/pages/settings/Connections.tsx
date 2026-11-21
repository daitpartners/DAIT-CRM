import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { CONNECT_PERSONAL_URL, useDisconnectMailbox, useMailboxes, type Mailbox } from '../../api/mailboxes';
import { useCurrentUser } from '../../api/useCurrentUser';
import { useConfirm } from '../../components/ConfirmDialog';
import { PlaceholderCard } from '../../components/PlaceholderCard';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { ConnectProviderModal } from './ConnectProviderModal';
import { MailboxOptionsModal } from './MailboxOptionsModal';
import { MicrosoftLogo } from './MicrosoftLogo';
import { SystemMailbox } from './SystemMailbox';

/**
 * Settings → Email & calendar connections (prototype V.connectionsCard, release 2A): connect your own Microsoft 365
 * mailbox; one row per mailbox (administrators and managers see everyone's) with Sync now / Options / Disconnect.
 * Administrators also see the 1A system mailbox below.
 */
export function Connections() {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const confirm = useConfirm();
  const { date } = useFormatDate();
  const { data } = useMailboxes();
  const disconnect = useDisconnectMailbox();
  const [params, setParams] = useSearchParams();
  const [options, setOptions] = useState<Mailbox | null>(null);
  const [providers, setProviders] = useState(false);

  // Back from Microsoft (personal connect): say how it went once, then drop the parameter.
  useEffect(() => {
    const result = params.get('mailbox');
    if (!result) return;
    if (result === 'connected') toast(t('Your mailbox is connected'));
    else toast(t('The mailbox could not be connected. Please try again.'), 'warn');
    params.delete('mailbox');
    setParams(params, { replace: true });
  }, []);

  const mine = data?.mine ?? null;
  const rows = data?.all ?? (mine ? [mine] : []);
  const canConnect = me.can('use_email');
  const isAdmin = me.can('view_admin_settings');

  async function onDisconnect(m: Mailbox) {
    const ok = await confirm({
      title: t('Disconnect mailbox?'),
      body: t('The CRM stops syncing and sending through this account and deletes its tokens. Emails already linked to leads stay in the CRM.'),
      confirmLabel: t('Disconnect'),
      danger: true,
    });
    if (!ok) return;
    disconnect.mutate(m.id, {
      onSuccess: () => toast(t('Mailbox disconnected')),
      onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
    });
  }

  return (
    <>
      <section className="card" aria-labelledby="conn-title">
        <div className="conn-head">
          <h2 id="conn-title">{t('Email & calendar connections')}</h2>
          <span className="conn-sub">{t('Each user connects their own mailbox. Sending, receiving and calendar sync run through it.')}</span>
          <div className="grow" />
          {canConnect && !mine ? (
            <a className="btn primary" href={CONNECT_PERSONAL_URL}>
              <MicrosoftLogo />
              {t('Connect Microsoft 365')}
            </a>
          ) : null}
          {canConnect ? (
            <button type="button" className="btn" onClick={() => setProviders(true)}>
              {t('Other provider')}
            </button>
          ) : null}
        </div>
        {canConnect && data && !mine ? (
          <div className="note warn">
            <strong>{t('Your mailbox is not connected.')}</strong>{' '}
            {t('Until it is, emails you write in the CRM are logged but not sent, and replies are not pulled in. Your Microsoft 365 Business Basic account works: it includes Exchange Online, which is what the CRM talks to.')}
          </div>
        ) : null}
        <ul className="conn-list">
          {rows.length === 0 && data ? <li className="empty">{t('No mailboxes connected yet.')}</li> : null}
          {rows.map((m) => (
            <li key={m.id} className="conn-row">
              <span className="conn-logo">
                <MicrosoftLogo />
              </span>
              <div className="conn-main">
                <div className="conn-addr">
                  {m.address} <span className="conn-owner">· {m.userName ?? '—'}</span>
                </div>
                <div className="conn-meta">
                  {t('Microsoft 365')} · <span className="badge b-ok">{t('Connected')}</span> ·{' '}
                  {m.lastSyncAt ? t('synced {when}', { when: date(m.lastSyncAt) }) : t('synced never')} ·{' '}
                  {m.messageCount === 1 ? t('1 message') : t('{n} messages', { n: m.messageCount.toLocaleString() })}
                </div>
              </div>
              <div className="conn-acts">
                <button type="button" className="btn sm" onClick={() => toast(t('Mail sync arrives with the Email screen (part 2B)'))}>
                  {t('Sync now')}
                </button>
                <button type="button" className="btn sm" onClick={() => setOptions(m)}>
                  {t('Options')}
                </button>
                <button type="button" className="btn sm danger" disabled={disconnect.isPending} onClick={() => void onDisconnect(m)}>
                  {t('Disconnect')}
                </button>
              </div>
            </li>
          ))}
        </ul>
        {isAdmin ? (
          <details className="conn-admin">
            <summary>{t('Administrator: Microsoft 365 app registration (one-time)')}</summary>
            <div>
              {t('1. In Microsoft Entra admin centre, register an app "DAIT CRM" (single tenant). 2. Redirect URI: https://crm.daitpartners.com/api/auth/microsoft/callback. 3. Delegated Graph permissions: Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, User.Read, offline_access; grant admin consent once so users are not asked individually. 4. Put the client id, secret and tenant id in the server environment (MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID). Nothing is stored in the browser.')}
            </div>
          </details>
        ) : null}
      </section>
      {isAdmin ? <SystemMailbox /> : null}
      {options ? <MailboxOptionsModal mailbox={options} onClose={() => setOptions(null)} /> : null}
      {providers ? <ConnectProviderModal onClose={() => setProviders(false)} /> : null}
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
