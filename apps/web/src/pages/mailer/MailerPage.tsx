import { Link, useNavigate } from 'react-router-dom';
import { useCampaigns } from '../../api/mailer';
import { useMailboxes } from '../../api/mailboxes';
import { Icons } from '../../components/Icons';
import { Topbar } from '../../components/Topbar';
import { useFormatDate } from '../../hooks/useFormatDate';
import { useT } from '../../i18n/useT';
import { Progress, StatusBadge, waitText } from './status';

/** Mailer page (release 2C; prototype views-mailer.js V.mailer): your campaigns (Administrators: everyone's). */
export function MailerPage() {
  const t = useT();
  const navigate = useNavigate();
  const { date } = useFormatDate();
  const { data: campaigns, isLoading } = useCampaigns();
  const { data: boxes } = useMailboxes();
  const connected = boxes?.mine?.status === 'connected';
  const when = (c: NonNullable<typeof campaigns>[number]) =>
    c.status === 'Scheduled' && c.startAt
      ? t('Starts {when}', { when: date(c.startAt) })
      : c.completedAt
        ? t('Ended {when}', { when: date(c.completedAt) })
        : t('Started {when}', { when: date(c.createdAt) });

  return (
    <>
      <Topbar title={t('Mailer')} sub={t('Personalised emails to selected leads, sent one by one from your own mailbox')}>
        <Link className="btn primary" to="/leads">
          {Icons.plus}
          {t('New from Leads')}
        </Link>
      </Topbar>
      <div className="page">
        {boxes && !connected ? (
          <div className="note warn">
            {t('Connect your Microsoft 365 mailbox in Settings to use the mailer.')} <Link to="/settings/connections">{t('Open Settings')}</Link>
          </div>
        ) : null}
        <section className="card flush">
          <div className="head">
            <h2>{t('Campaigns')}</h2>
            <span className="dim mw-help">{t('Tick leads on the Leads page, then choose Send via mailer.')}</span>
          </div>
          <div className="tbl">
            <table aria-label={t('Campaigns')}>
              <thead>
                <tr>
                  <th>{t('Campaign')}</th><th>{t('Template')}</th><th>{t('Sender')}</th><th>{t('Progress')}</th><th>{t('Replied')}</th><th>{t('Status')}</th><th>{t('When')}</th>
                </tr>
              </thead>
              <tbody>
                {(campaigns ?? []).map((c) => (
                  <tr key={c.id} className="clickable" onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) navigate(`/mailer/${c.id}`); }}>
                    <td><Link to={`/mailer/${c.id}`} className="strong">{c.number}</Link> · {c.name}</td>
                    <td>{c.templateName}</td>
                    <td>{c.sender.name}</td>
                    <td><Progress stats={c.stats} /></td>
                    <td>{c.stats.replied}</td>
                    <td>
                      <StatusBadge t={t} status={c.status} />
                      {c.status === 'Sending' && waitText(t, c.waitReason) ? <span className="dim"> {waitText(t, c.waitReason)}</span> : null}
                    </td>
                    <td className="dim">{when(c)}</td>
                  </tr>
                ))}
                {!isLoading && !campaigns?.length ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty">
                        {t('No campaigns yet.')} <Link to="/leads">{t('Go to Leads')}</Link>{t(', tick the people to email and choose Send via mailer.')}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
        <div className="note info">
          {t('Sending limits to keep in mind: a personal Microsoft 365 mailbox suits a few dozen to a few hundred personalised emails a day. Thousands a day is marketing mail and belongs on a dedicated sending service, so the daitpartners.com domain keeps its reputation.')}
        </div>
      </div>
    </>
  );
}
