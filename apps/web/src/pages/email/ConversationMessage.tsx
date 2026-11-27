import { useState, type MouseEvent, type ReactNode } from 'react';
import type { MailDetail } from '../../api/mail';
import { Icons } from '../../components/Icons';
import { useFormatDate } from '../../hooks/useFormatDate';
import { initials } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { AttachmentCards } from './AttachmentCards';
import { MailBody } from './MailBody';
import { RowMenu } from './menus';
import type { CommandId, MailTarget, useMailCommands } from './useMailCommands';

type Commands = ReturnType<typeof useMailCommands>;

type Props = {
  m: MailDetail;
  /** Another user's mailbox (team view): no Reply, Reply all or Forward; Log as activity instead. */
  viewOnly: boolean;
  commands: Commands;
  /** An expanded older message: a click on the sender folds it back to its row. The opened message has none. */
  onCollapse?: () => void;
  /** Under the body (the newest message's Reply / Reply all / Forward, or the view-only pill and CRM buttons). */
  footer?: ReactNode;
};

/**
 * One expanded message of the reading pane's conversation (mockup `.msg.exp`): the avatar, `{name} <{address}>`,
 * `To: … · Cc: …` and the date (24-hour, the viewer's time zone), with its own buttons acting on this message only:
 * Reply, Reply all, Forward and More actions (the list's right-click menu), or in view only Log as activity and More
 * actions. Then its attachment cards and its body (auto-height HTML frame, or plain text).
 */
export function ConversationMessage({ m, viewOnly, commands, onCollapse, footer }: Props) {
  const t = useT();
  const { dateTime } = useFormatDate();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const target: MailTarget = { ids: [m.id], item: m };
  const name = m.fromName || m.fromAddress;
  const who = (
    <>
      {name}
      {m.fromName ? <small>{` <${m.fromAddress}>`}</small> : null}
    </>
  );

  const act = (id: CommandId, icon: ReactNode, label: string) => {
    const s = commands.state(id, target);
    return (
      <button type="button" className="icon-btn" aria-label={label} title={s.title ?? label} disabled={!s.enabled} onClick={() => commands.run(id, target)}>
        <span className="ico" aria-hidden="true">{icon}</span>
      </button>
    );
  };
  const openMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenuAt({ x: r.right - 240, y: r.bottom + 4 });
  };

  return (
    <article className="msg exp" aria-label={`${name}, ${dateTime(m.occurredAt)}`}>
      <div className="mh">
        <span className="av" aria-hidden="true">{initials(name)}</span>
        {onCollapse ? (
          <button type="button" className="who" aria-expanded="true" onClick={onCollapse}>{who}</button>
        ) : (
          <div className="who">{who}</div>
        )}
        <div className="acts">
          {viewOnly ? (
            act('log', Icons.activity, t('Log as activity'))
          ) : (
            <>
              {act('reply', Icons.reply, t('Reply'))}
              {act('replyAll', Icons.replyall, t('Reply all'))}
              {act('forward', Icons.forward, t('Forward'))}
            </>
          )}
          <button type="button" className="icon-btn" aria-label={t('More actions')} title={t('More actions')} aria-haspopup="menu" aria-expanded={menuAt !== null} onClick={openMenu}>
            <span className="ico" aria-hidden="true">{Icons.more}</span>
          </button>
        </div>
        <div className="to">
          {t('To:')} <b>{m.toAddresses.join(', ')}</b>
          {m.ccAddresses.length ? (
            <>
              {' · '}{t('Cc:')} <b>{m.ccAddresses.join(', ')}</b>
            </>
          ) : null}
        </div>
        <div className="date">{dateTime(m.occurredAt)}</div>
      </div>
      {m.attachmentNames.length ? <AttachmentCards messageId={m.id} names={m.attachmentNames} /> : null}
      <MailBody html={m.bodyHtml} text={m.bodyText} autoHeight />
      {footer}
      {menuAt ? <RowMenu at={menuAt} target={target} commands={commands} onClose={() => setMenuAt(null)} /> : null}
    </article>
  );
}
