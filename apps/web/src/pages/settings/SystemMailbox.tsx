import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { keys, useFailedEmailJobs, useSystemMailbox, type JobSummary } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { AccessDenied } from '../../components/AccessDenied';
import { useConfirm } from '../../components/ConfirmDialog';
import { Table } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';

const CONNECT_URL = '/api/auth/microsoft/connect?mode=system';

export function SystemMailbox() {
  const me = useCurrentUser();
  if (!me.can('view_admin_settings')) return <AccessDenied />;
  return <MailboxCard canManage={me.can('manage_users')} />;
}

function statusBadge(t: TFn, status: string) {
  if (status === 'connected') return <span className="badge b-ok">{t('Connected')}</span>;
  if (status === 'error') return <span className="badge b-bad">{t('Needs reconnecting')}</span>;
  return <span className="badge b-grey">{status}</span>;
}

/** Shows the outcome of the Microsoft connect redirect once, then clears it from the address bar. */
function useConnectResultToast() {
  const t = useT();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current) return;
    if (params.get('connected') === '1') toast(t('Mailbox connected'));
    else if (params.get('error') === 'connect-failed') toast(t('The mailbox could not be connected. Please try again.'), 'warn');
    else return;
    shown.current = true;
    setParams({}, { replace: true });
  }, [params, setParams, t, toast]);
}

function MailboxCard({ canManage }: { canManage: boolean }) {
  const t = useT();
  const me = useCurrentUser();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isPending, error } = useSystemMailbox();
  const failed = useFailedEmailJobs();
  useConnectResultToast();

  const fmt = (d: string) => formatDate(d, { locale: me.language, timezone: me.timezone, dateFormat: me.dateFormat });
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: keys.systemMailbox }),
    qc.invalidateQueries({ queryKey: keys.failedEmailJobs }),
  ]);
  const onError = (err: unknown) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn');

  const disconnect = useMutation({
    mutationFn: () => api<void>('/api/mailboxes/system/disconnect', { method: 'POST' }),
    onSuccess: async () => {
      await refresh();
      toast(t('Mailbox disconnected'));
    },
    onError,
  });

  const retry = useMutation({
    mutationFn: (id: number) => api<JobSummary>(`/api/jobs/${id}/retry`, { method: 'POST' }),
    onSuccess: async () => {
      await refresh();
      toast(t('Email queued to send again'));
    },
    onError,
  });

  async function confirmDisconnect(address: string) {
    const ok = await confirm({
      title: t('Disconnect mailbox?'),
      body: t('The CRM will stop sending email from {address}. Emails wait here until a mailbox is connected again.', { address }),
      confirmLabel: t('Disconnect'),
      danger: true,
    });
    if (ok) disconnect.mutate();
  }

  const account = data?.account ?? null;
  const head = [t('To'), t('Subject'), t('Attempts'), t('Last error')];
  return (
    <>
      <section className="card flush" aria-labelledby="mailbox-title">
        <div className="head">
          <div>
            <h2 id="mailbox-title">{t('System mailbox')}</h2>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
              {t('The Microsoft 365 mailbox the CRM uses to send notifications and other automatic emails.')}
            </div>
          </div>
          <div className="grow" />
          {canManage ? (
            <>
              <a className={account ? 'btn sm' : 'btn primary sm'} href={CONNECT_URL}>
                {account ? t('Reconnect') : t('Connect mailbox')}
              </a>
              {account ? (
                <button type="button" className="btn sm danger" onClick={() => confirmDisconnect(account.address)} disabled={disconnect.isPending}>
                  {t('Disconnect')}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        <div style={{ padding: '14px 18px' }}>
          {error ? (
            <div role="alert">{errorText(t, error instanceof ApiError ? error.code : 'unknown')}</div>
          ) : isPending ? (
            <div>{t('Loading…')}</div>
          ) : (
            <dl className="kv">
              <dt>{t('Mailbox')}</dt>
              {account ? (
                <dd>{account.address}</dd>
              ) : (
                <dd className="null">{t('Not connected. Emails wait here until the mailbox is connected.')}</dd>
              )}
              {account ? (
                <>
                  <dt>{t('Status')}</dt>
                  <dd>{statusBadge(t, account.status)}</dd>
                  {account.lastError ? (
                    <>
                      <dt>{t('Last error')}</dt>
                      <dd>{account.lastError}</dd>
                    </>
                  ) : null}
                  <dt>{t('Last updated')}</dt>
                  <dd>{fmt(account.updatedAt)}</dd>
                </>
              ) : null}
              <dt>{t('Waiting to send')}</dt>
              <dd>{data?.pendingJobs ?? 0}</dd>
              <dt>{t('Failed')}</dt>
              <dd>{data?.failedJobs ?? 0}</dd>
            </dl>
          )}
        </div>
      </section>

      <section className="card flush" aria-labelledby="failed-title" style={{ marginTop: 16 }}>
        <div className="head">
          <h2 id="failed-title">{t('Failed emails')}</h2>
        </div>
        {failed.error ? (
          <div className="empty" role="alert">{errorText(t, failed.error instanceof ApiError ? failed.error.code : 'unknown')}</div>
        ) : (
          <Table
            head={canManage ? [...head, <span className="sr">{t('Actions')}</span>] : head}
            isEmpty={failed.isPending || !failed.data?.length}
            empty={failed.isPending ? t('Loading…') : t('No failed emails')}
          >
            {failed.data?.map((j) => (
              <tr key={j.id}>
                <td className="wrap">{(j.payloadSummary.to ?? []).join(', ')}</td>
                <td className="wrap">{j.payloadSummary.subject ?? ''}</td>
                <td>{t('{n} of {max}', { n: j.attempts, max: j.maxAttempts })}</td>
                <td className="wrap">{j.lastError ?? ''}</td>
                {canManage ? (
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn xs" onClick={() => retry.mutate(j.id)} disabled={retry.isPending}>
                        {t('Retry')}
                      </button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}
      </section>
    </>
  );
}
