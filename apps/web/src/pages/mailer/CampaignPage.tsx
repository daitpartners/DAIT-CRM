import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useCampaign, useCampaignAction } from '../../api/mailer';
import { useConfirm } from '../../components/ConfirmDialog';
import { Tile } from '../../components/Tile';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { Progress, StatusBadge, pauseReasonText, waitText } from './status';
import { zoneSourceText, zoneText } from './zones';

/** An address that may wrap only before its @ (keeps "name" and "@domain" whole, so the table fits its card). */
function AddressBreak({ to }: { to: string }) {
  const at = to.indexOf('@');
  return at > 0 ? <>{to.slice(0, at)}<wbr />{to.slice(at)}</> : <>{to}</>;
}

/** One campaign (prototype mailer detail): tiles, recipients with their audit trail, details, the email as queued. */
export function CampaignPage() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { dateTime: date, date: day } = useFormatDate();
  const id = Number(useParams().id);
  const { data: c, isError } = useCampaign(id);
  const action = useCampaignAction(id);

  if (isError) {
    return (
      <>
        <Topbar title={t('Campaign not found')} />
        <div className="page"><div className="empty"><Link to="/mailer">{t('Back to Mailer')}</Link></div></div>
      </>
    );
  }
  if (!c) return <div className="page"><div className="empty">{t('Loading…')}</div></div>;

  const live = ['Sending', 'Scheduled', 'Paused'].includes(c.status);
  const run = (a: 'pause' | 'resume' | 'start' | 'cancel', done: string) =>
    action.mutate(a, { onSuccess: () => toast(done), onError: (err) => toast(err instanceof ApiError ? errorText(t, err.code) : t('Something went wrong. Try again.'), 'warn') });
  const minutes = (n: number) => (n === 1 ? t('1 minute') : t('{n} minutes', { n }));
  const when = c.status === 'Scheduled' && c.startAt ? t('Starts {when}', { when: date(c.startAt) }) : c.completedAt ? t('Ended {when}', { when: date(c.completedAt) }) : t('Started {when}', { when: date(c.createdAt) });
  const wait = c.status === 'Sending' ? waitText(t, c.waitReason) : null;

  return (
    <>
      <Topbar
        title={`${c.number} · ${c.name}`}
        crumb={<><Link to="/mailer">{t('Mailer')}</Link> / {c.number}</>}
        sub={
          <>
            <StatusBadge t={t} status={c.status} />{' '}
            <span className="l2line">
              {when}
              {wait ? <><i>|</i>{wait}</> : c.status === 'Sending' && c.next ? <><i>|</i>{t('Next: {who}', { who: c.next })}</> : null}
              {c.status === 'Paused' && c.pauseReason ? <><i>|</i>{pauseReasonText(t, c.pauseReason)}</> : null}
            </span>
          </>
        }
      >
        {c.isSender ? (
          <div className="hdr-actions">
            {c.status === 'Scheduled' ? <button type="button" className="btn" disabled={action.isPending} onClick={() => run('start', t('{id} started', { id: c.number }))}>{t('Start now')}</button> : null}
            {c.status === 'Sending' || c.status === 'Scheduled' ? <button type="button" className="btn" disabled={action.isPending} onClick={() => run('pause', t('{id} paused', { id: c.number }))}>{t('Pause')}</button> : null}
            {c.status === 'Paused' ? <button type="button" className="btn primary" disabled={action.isPending} onClick={() => run('resume', t('{id} resumed', { id: c.number }))}>{t('Resume')}</button> : null}
            {live ? (
              <button
                type="button"
                className="btn danger"
                disabled={action.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: t('Cancel the rest of {id}?', { id: c.number }),
                    body: t('{n} still queued will not be sent. Emails already sent stay on their leads. This cannot be undone.', { n: c.stats.queued === 1 ? t('1 email') : t('{n} emails', { n: c.stats.queued }) }),
                    confirmLabel: t('Cancel remaining'),
                    danger: true,
                  });
                  if (ok) run('cancel', t('{id} cancelled', { id: c.number }));
                }}
              >
                {t('Cancel remaining')}
              </button>
            ) : null}
          </div>
        ) : null}
      </Topbar>
      <div className="page">
        <div className="tiles">
          <Tile label={t('Sent')} value={c.stats.sent} meta={<Progress stats={c.stats} />} />
          <Tile label={t('Queued')} value={c.stats.queued} meta={live ? t('one every {minutes}', { minutes: minutes(c.intervalMinutes) }) : t('nothing waiting')} />
          <Tile label={t('Skipped / failed')} value={`${c.stats.skipped} / ${c.stats.failed}`} meta={t('reason shown under the status')} metaClass={c.stats.failed ? 'bad' : undefined} />
          <Tile label={t('Replied')} value={c.stats.replied} meta={t('matched from the mailbox')} metaClass={c.stats.replied ? 'ok' : undefined} />
        </div>
        <div className="cols">
          <div className="col-main">
            <section className="card flush">
              <div className="head">
                <h2>{t('Recipients')}</h2>
                <span className="dim mw-help">{c.stats.total === 1 ? t('1 lead · audit record per recipient') : t('{n} leads · audit record per recipient', { n: c.stats.total })}</span>
              </div>
              <div className="tbl">
                <table aria-label={t('Recipients')} className="mw-rec">
                  <thead>
                    <tr><th>{t('Lead')}</th><th>{t('Name')}</th><th>{t('To')}</th><th>{t('Local time')}</th><th>{t('Status')}</th><th>{t('Sent at')}</th><th>{t('Message')}</th></tr>
                  </thead>
                  <tbody>
                    {c.recipients.map((r) => (
                      <tr key={r.id}>
                        <td>{r.leadId && r.leadNumber ? <Link to={`/leads/${r.leadId}`} className="strong">{r.leadNumber}</Link> : '—'}</td>
                        <td>{r.name || r.company || '—'}</td>
                        <td className="mw-to">{r.to ? <AddressBreak to={r.to} /> : <span className="dim">—</span>}</td>
                        <td className="wrap" title={zoneSourceText(t, r.timezoneSource)}>{zoneText(t, r.timezones)}</td>
                        <td className="wrap mw-status">
                          <StatusBadge t={t} status={r.status} />
                          {r.error ? <div className="dim mw-err">{t(r.error)}</div> : null}
                        </td>
                        <td className="mw-sent">{r.sentAt ? date(r.sentAt) : <span className="dim">—</span>}</td>
                        <td className="mw-msg"><span className="dim">{r.messageId ?? '—'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
          <aside className="col-side">
            <section className="card">
              <h2>{t('Details')}</h2>
              <dl className="kv mw-details">
                <dt>{t('Template')}</dt>
                <dd>{c.templateName}{c.templateUpdatedAt ? <span className="dim"> · {t('version of {date}', { date: day(c.templateUpdatedAt) })}</span> : null}</dd>
                <dt>{t('From')}</dt><dd>{c.sender.name}<div className="dim">{c.senderAddress}</div></dd>
                <dt>{t('Cc')}</dt><dd>{c.cc.join(', ') || <span className="dim">—</span>}</dd>
                <dt>{t('Bcc')}</dt><dd>{c.bcc.join(', ') || <span className="dim">—</span>}</dd>
                <dt>{t('Start')}</dt><dd>{c.startAt ? date(c.startAt) : t('Immediately')}</dd>
                <dt>{t('Delay')}</dt><dd>{t('One every {minutes}', { minutes: minutes(c.intervalMinutes) })}{c.workingHoursOnly ? ` · ${t("client's working hours only")}` : ''}</dd>
                <dt>{t('Opt-out line')}</dt><dd>{c.unsubscribeLine ? t('Included') : t('Not included')}</dd>
                <dt>{t('Lawful basis')}</dt><dd>{t(c.lawfulBasis)}</dd>
                {/* The sender is the campaign's creator: only the sender creates and acts on a campaign. */}
                <dt>{t('Created')}</dt><dd>{`${c.sender.name} · ${date(c.createdAt)}`}</dd>
              </dl>
            </section>
            <section className="card">
              <h2>{t('Email as queued')}</h2>
              <div className="mprev">
                <div className="msub">{c.subject}</div>
                <pre>{c.body}</pre>
              </div>
              <div className="dim mw-help">{t('Saved with the campaign, so later template edits do not change this record.')}</div>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}
