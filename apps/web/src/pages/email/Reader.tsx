import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Priority } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useMailAction, useMailMessage, type MailDetail } from '../../api/mail';
import { PriorityLabel } from '../../components/StatusBadge';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText, leadStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import type { ComposeStart } from './ComposeModal';
import { LinkLeadModal } from './LinkLeadModal';

type Props = {
  id: number;
  /** Shown automatically (first message on arrival), not opened by the user: it stays unread. */
  peek?: boolean;
  connected: boolean;
  onReply: (start: ComposeStart) => void;
  onArchived: () => void;
};

/** Reading pane + side panel (prototype `.reader` and `.mailside`). */
export function Reader({ id, peek = false, connected, onReply, onArchived }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { dateTime, short, day } = useFormatDate();
  const { data: m, isError } = useMailMessage(id, peek);
  const action = useMailAction();
  const [linking, setLinking] = useState(false);

  if (isError) return <div className="reader empty">{t('This message is not available.')}</div>;
  if (!m) return <div className="reader empty">{t('Loading…')}</div>;

  const draft = m.status === 'draft';
  const inbound = m.status === 'received';
  const fail = (err: unknown) => toast(err instanceof ApiError ? errorText(t, err.code) : t('Something went wrong. Try again.'), 'warn');
  const run = (a: 'log' | 'task' | 'archive', done: string) =>
    action.mutate({ id: m.id, action: a }, {
      onSuccess: () => {
        toast(done);
        if (a === 'archive') onArchived();
      },
      onError: fail,
    });

  const reply = () =>
    onReply({
      replyTo: m.id,
      to: inbound ? m.fromAddress : m.toAddresses.join(', '),
      subject: /^\s*re\s*:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      leadId: m.lead?.id,
      companyId: m.company?.id,
    });

  return (
    <>
      <article className="reader" aria-label={m.subject}>
        <div className="reader-head">
          <div className="reader-title">
            <h2>{m.subject || t('(no subject)')}</h2>
            <div className="reader-meta">
              {m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress} {t('to')} {m.toAddresses.join(', ')}
              {m.ccAddresses.length ? ` · ${t('cc {cc}', { cc: m.ccAddresses.join(', ') })}` : ''} · {dateTime(m.occurredAt)}
            </div>
          </div>
          {draft ? null : (
            <div className="reader-actions">
              <button type="button" className="btn sm" onClick={reply} disabled={!connected} title={connected ? undefined : t('Connect your mailbox to reply')}>
                {t('Reply')}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={!m.lead || !!m.loggedAt || action.isPending}
                onClick={() => run('log', t('Logged on {lead}', { lead: m.lead?.number ?? '' }))}
              >
                {t('Log as activity')}
              </button>
              {m.lead ? null : (
                <button type="button" className="btn sm primary" onClick={() => setLinking(true)}>
                  {t('Link to lead / create lead')}
                </button>
              )}
              {m.folder !== 'archive' ? (
                <button type="button" className="btn sm" disabled={action.isPending} onClick={() => run('archive', t('Archived'))}>
                  {t('Archive')}
                </button>
              ) : null}
            </div>
          )}
        </div>
        <div className="body">{m.bodyText}</div>
        {m.attachmentNames.length ? (
          <div className="reader-attach">{t('Attachments: {names}', { names: m.attachmentNames.join(', ') })}</div>
        ) : null}
        <div className="reader-foot">
          {draft ? (
            t('Drafts are edited in Outlook.')
          ) : (
            <>
              {t('Suggested actions:')}
              {m.lead ? (
                <>
                  <button type="button" className="btn sm" disabled title={t('Calendar arrives in release 3')}>
                    {t('Create meeting')}
                  </button>
                  {m.lead.companyId ? (
                    <Link className="btn sm" to={`/companies/${m.lead.companyId}?tab=contacts`}>
                      {t('Add contact')}
                    </Link>
                  ) : null}
                  <button type="button" className="btn sm" disabled={action.isPending} onClick={() => run('task', t('Task created'))}>
                    {t('Add follow-up task')}
                  </button>
                </>
              ) : (
                <button type="button" className="btn sm" onClick={() => setLinking(true)}>
                  {t('Create lead from this email')}
                </button>
              )}
            </>
          )}
        </div>
      </article>
      <MailSide m={m} day={day} short={short} />
      {linking ? (
        <LinkLeadModal
          message={m}
          onClose={() => setLinking(false)}
          onLinked={(leadNumber) => toast(t('Linked to {lead}', { lead: leadNumber }))}
          onCreated={(leadId) => {
            toast(t('Lead created and linked'));
            navigate(`/leads/${leadId}`);
          }}
        />
      ) : null}
    </>
  );
}

function MailSide({ m, day, short }: { m: MailDetail; day: (ymd: string) => string; short: (iso: string) => string }) {
  const t = useT();
  const l = m.lead;
  const companyId = l?.companyId ?? m.company?.id;
  const event = (h: MailDetail['thread'][number]) => {
    const what = h.kind === 'sent' ? t('sent by {who}', { who: h.by ?? '' }) : h.kind === 'reply' ? t('reply received') : h.kind === 'draft' ? t('draft') : t('received');
    return h.direction === 'in' && h.unmatched ? `${what} · ${t('no matching contact')}` : what;
  };
  return (
    <aside className="mailside" aria-label={t('Linked records')}>
      <div className="navsec mail-sec">{t('Linked records')}</div>
      {l ? (
        <>
          <Link className="link" to={`/leads/${l.id}`}>
            <span>
              <strong>{t('Lead')}</strong>
              <span className="link-sub">{`${l.number} · ${leadStatusText(t, l.status)}`}</span>
            </span>
            <PriorityLabel priority={l.priority as Priority} />
          </Link>
          {/* Prototype: a linked message always shows Lead, Contact (name or "—") and Company. */}
          <SideLink to={companyId ? `/companies/${companyId}?tab=contacts` : null} title={t('Contact')} sub={m.contact?.name ?? '—'} />
          <SideLink to={m.company ? `/companies/${m.company.id}` : companyId ? `/companies/${companyId}` : null} title={t('Company')} sub={m.company?.name ?? '—'} />
        </>
      ) : (
        <div className="note warn">{t('No matching contact or lead. Link it to an existing lead or create one.')}</div>
      )}
      <div className="navsec mail-sec">{t('Thread history')}</div>
      <div className="mail-thread">
        {m.thread.map((h) => (
          <div key={h.id}>{`${short(h.occurredAt)} · ${event(h)}`}</div>
        ))}
      </div>
      {l?.nextFollowUp ? (
        <>
          <div className="navsec mail-sec">{t('Follow-up')}</div>
          <div className="mail-thread">
            {t('Next follow-up on this lead:')} <strong>{day(l.nextFollowUp)}</strong>
          </div>
        </>
      ) : null}
    </aside>
  );
}

/** A card in the side panel: a link when the record can be opened. */
function SideLink({ to, title, sub }: { to: string | null; title: string; sub: string }) {
  const inner = (
    <span>
      <strong>{title}</strong>
      <span className="link-sub">{sub}</span>
    </span>
  );
  return to ? <Link className="link" to={to}>{inner}</Link> : <div className="link">{inner}</div>;
}
