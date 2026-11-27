import { Link } from 'react-router-dom';
import type { Priority } from '@dait-crm/shared';
import type { MailDetail } from '../../api/mail';
import { PriorityLabel } from '../../components/StatusBadge';
import { useFormatDate } from '../../hooks/useFormatDate';
import { leadStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

/**
 * Release 2B-2's side panel (prototype `.mailside`), moved out of the old Reader unchanged when the conversation reading
 * pane replaced it (web-mail release 2, Task 15). Task 16's lead panel takes its place.
 */
export function MailSide({ m }: { m: MailDetail }) {
  const { day, short } = useFormatDate();
  const t = useT();
  const l = m.lead;
  const companyId = l?.companyId ?? m.company?.id;
  const event = (h: MailDetail['thread'][number]) => {
    const what = h.kind === 'sent' ? (h.by ? t('sent by {who}', { who: h.by }) : t('sent')) : h.kind === 'reply' ? t('reply received') : h.kind === 'draft' ? t('draft') : t('received');
    return h.direction === 'in' && h.unmatched ? `${what} · ${t('no matching contact')}` : what;
  };
  return (
    <aside className="mailside" aria-label={t('Linked records')}>
      <div className="navsec mail-sec">{t('Linked records')}</div>
      {m.restrictedLead ? (
        <>
          {/* Another owner's lead: its number and company name only, not links (web-mail release 1). */}
          <SideLink to={null} title={t('Lead')} sub={t("{lead} · another owner's lead", { lead: m.restrictedLead.number })} />
          <SideLink to={null} title={t('Company')} sub={m.restrictedLead.companyName} />
        </>
      ) : l ? (
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
