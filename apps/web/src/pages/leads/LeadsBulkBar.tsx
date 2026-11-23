import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../../i18n/useT';
import { MailerButton, useSendViaMailer } from '../mailer/MailerWizard';

type Props = {
  /** The ticked leads (the bar shows only while there are some; an open wizard outlives them). */
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
  const mailer = useSendViaMailer(leadIds, onQueued);
  // A Leads list refresh clears the ticks: the bar goes, an open Send via mailer wizard stays.
  if (!n) return mailer.wizard;
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
        <MailerButton disabled={mailboxConnected !== true || mailer.pending} title={gate ?? undefined} onClick={mailer.start} />
      ) : null}
      {mailer.wizard}
    </div>
  );
}
