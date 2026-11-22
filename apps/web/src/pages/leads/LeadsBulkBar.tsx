import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../../i18n/useT';
import { SendViaMailerButton } from '../mailer/MailerWizard';

type Props = {
  /** The ticked leads (the bar shows only while there are some). */
  leadIds: number[];
  /** The user may use the mailer (`use_email`). */
  canMail: boolean;
  /** The user's own mailbox is connected; undefined while loading. */
  mailboxConnected: boolean | undefined;
  onClear: () => void;
  onQueued: () => void;
  /** The release 1C bulk actions (Assign to…, Archive), placed before Clear. */
  children?: ReactNode;
};

/**
 * Leads bulk bar (prototype views-leads2.js `.mbulk`): "<n> selected", the mailbox hint when it is not connected,
 * then at the right end Clear and the primary Send via mailer.
 */
export function LeadsBulkBar({ leadIds, canMail, mailboxConnected, onClear, onQueued, children }: Props) {
  const t = useT();
  const n = leadIds.length;
  const gate = canMail && mailboxConnected === false ? t('Connect your Microsoft 365 mailbox in Settings to use the mailer.') : null;
  // "<strong>n</strong> selected" in any word order: split the translated phrase at the number.
  const [before, after] = t('{n} selected', { n: '\u0000' }).split('\u0000');
  return (
    <div className="mbulk on" role="region" aria-label={t('Bulk actions')}>
      <span>
        {before}
        <strong>{n}</strong>
        {after}
        {gate && n ? (
          <>
            {' · '}
            <span className="dim">
              {gate} <Link to="/settings/connections">{t('Open Settings')}</Link>
            </span>
          </>
        ) : null}
      </span>
      {children}
      <span className="grow" />
      <button type="button" className="btn sm" onClick={onClear}>
        {t('Clear')}
      </button>
      {canMail ? (
        // Release 2C: Send via mailer for the ticked leads; checks them before the wizard opens.
        <SendViaMailerButton leadIds={leadIds} disabled={mailboxConnected !== true || !n} title={gate ?? undefined} onQueued={onQueued} />
      ) : null}
    </div>
  );
}
