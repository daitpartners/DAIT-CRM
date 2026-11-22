import type { CampaignStats, CampaignStatus } from '../../api/mailer';
import type { TFn } from '../../i18n/useT';

/** Prototype mailer status colours (views-mailer.js ST). */
const BADGE: Record<string, string> = {
  Queued: 'b-grey', Sending: 'b-warn', Sent: 'b-purple', Failed: 'b-bad', Skipped: 'b-grey', Replied: 'b-ok',
  Scheduled: 'b-purple2', Paused: 'b-grey', Completed: 'b-ok', Cancelled: 'b-bad',
};

export function statusText(t: TFn, s: string): string {
  switch (s) {
    case 'Queued': return t('Queued');
    case 'Sending': return t('Sending');
    case 'Sent': return t('Sent');
    case 'Failed': return t('Failed');
    case 'Skipped': return t('Skipped');
    case 'Replied': return t('Replied');
    case 'Scheduled': return t('Scheduled');
    case 'Paused': return t('Paused');
    case 'Completed': return t('Completed');
    case 'Cancelled': return t('Cancelled');
    default: return s;
  }
}

export function StatusBadge({ t, status }: { t: TFn; status: CampaignStatus | string }) {
  return <span className={`badge ${BADGE[status] ?? 'b-grey'}`}>{statusText(t, status)}</span>;
}

/** Prototype progress bar: sent + failed of those to send. */
export function Progress({ stats }: { stats: CampaignStats }) {
  const done = stats.sent + stats.failed;
  const pct = stats.toSend ? Math.round((done / stats.toSend) * 100) : 100;
  return (
    <>
      <span className="mbar" title={`${done} / ${stats.toSend}`}>
        <i style={{ width: `${pct}%` }} />
      </span>{' '}
      <span className="dim">{`${done} / ${stats.toSend}`}</span>
    </>
  );
}

/** Why a Sending campaign is not sending right now. */
export function waitText(t: TFn, reason: string | null): string | null {
  if (reason === 'working_hours') return t("Waiting for the client's working hours");
  if (reason === 'daily_limit') return t('Daily limit reached — continues tomorrow');
  return null;
}

/** Why a campaign is paused. The server stores the reason in English (no data change); translated here. */
export function pauseReasonText(t: TFn, reason: string | null): string | null {
  if (!reason) return null;
  const by = /^Paused by (.+)$/.exec(reason);
  if (by) return t('Paused by {name}', { name: by[1]! });
  if (reason === 'Mailbox disconnected') return t('Mailbox disconnected');
  if (reason === 'Mailbox needs reconnecting') return t('Mailbox needs reconnecting');
  return reason;
}
