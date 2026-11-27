import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { MailItem } from '../../api/mail';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { firstName, initials, leadStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { rowTime } from './listDates';
import { rowTarget, type CommandId, type useMailCommands } from './useMailCommands';

type Props = {
  m: MailItem;
  /** The open (or shown) message. */
  on: boolean;
  to: string;
  /** Team view: the row says whose mailbox it is in (mockup state 5). */
  team: boolean;
  checked: boolean;
  /** Some row is checked: every avatar shows its checkbox. */
  selecting: boolean;
  /** Its right-click menu is open: the row stays highlighted, without its hover actions (mockup state 4). */
  menuOpen: boolean;
  onCheck: (checked: boolean) => void;
  onMenu: (e: MouseEvent) => void;
  commands: ReturnType<typeof useMailCommands>;
};

/**
 * A message list row (web-mail release 2, mockup `.row`), the stretched-link pattern: the row is a `div.mrow` whose
 * link, named by sender and subject, covers it, with the avatar's Select message checkbox (on hover, or once any row is
 * checked) and the hover actions above it. Sender (bold when unread), replied / attachment / flag icons, subject, the
 * conversation count, the 24-hour time, preview, the lead chip with its stage, the mailbox in team view.
 */
export function MessageRow({ m, on, to, team, checked, selecting, menuOpen, onCheck, onMenu, commands }: Props) {
  const t = useT();
  const me = useCurrentUser();
  const outbound = m.status !== 'received';
  const who = outbound ? t('To: {to}', { to: m.toAddresses.join(', ') }) : m.fromName || m.fromAddress;
  const subject = m.subject || t('(no subject)');
  const mailbox = m.viewOnly ? t("{name}'s mailbox", { name: firstName(m.owner.name) }) : t('Your mailbox');
  const target = rowTarget(m);
  const cls = ['mrow', m.isRead ? '' : 'unread', on ? 'sel' : '', checked ? 'checked' : '', selecting ? 'selecting' : '', menuOpen ? 'ctx' : '']
    .filter(Boolean).join(' ');

  const act = (id: CommandId, icon: ReactNode, label: string) => {
    const s = commands.state(id, target);
    const name = s.label ?? label;
    return (
      <button type="button" aria-label={name} title={s.title ?? name} disabled={!s.enabled} onClick={() => commands.run(id, target)}>
        <span className="ico" aria-hidden="true">{icon}</span>
      </button>
    );
  };

  return (
    <div className={cls} onContextMenu={onMenu}>
      <div className="avw">
        <span className="av" aria-hidden="true">{initials(m.fromName || m.fromAddress)}</span>
        <span className="ck">
          <input type="checkbox" aria-label={t('Select message')} checked={checked} onChange={(e) => onCheck(e.target.checked)} />
        </span>
        {team ? <span className={`ownr${m.viewOnly ? '' : ' self'}`} title={mailbox} aria-hidden="true">{initials(m.owner.name)}</span> : null}
      </div>
      <Link className="mrow-link" to={to} aria-label={`${who}, ${subject}`} aria-current={on ? 'true' : undefined}>
        <span className="rl1">
          <span className="rfrom">{who}</span>
          <span className="ricons">
            {m.replied ? <span className="ico" title={t('You replied')}>{Icons.reply}</span> : null}
            {m.hasAttachments ? <span className="ico" title={t('Has attachments')}>{Icons.clip}</span> : null}
            {m.flagStatus === 'flagged' ? <span className="ico flag" title={t('Flagged')}>{Icons.flag}</span> : null}
          </span>
        </span>
        <span className="rl2">
          <span className="rsubj">{subject}</span>
          {m.conversationCount > 1 ? (
            <span className="rcount" title={t('{n} messages in this conversation', { n: m.conversationCount })}>{m.conversationCount}</span>
          ) : null}
          <span className="rtime">{rowTime(m.occurredAt, me.timezone, me.language)}</span>
        </span>
        <span className="rprev">{m.preview}</span>
        <span className="rl4">
          {m.leadRestricted && m.leadNumber ? (
            <span className="lchip">{t("{lead} · another owner's lead", { lead: m.leadNumber })}</span>
          ) : m.leadNumber ? (
            <span className={`lchip st-${(m.leadStatus ?? '').replace(/\s+/g, '-')}`}>
              <i aria-hidden="true" />
              {m.leadStatus ? `${m.leadNumber} · ${leadStatusText(t, m.leadStatus)}` : m.leadNumber}
            </span>
          ) : null}
          {m.projectNumber ? <span className="badge b-ok">{m.projectNumber}</span> : null}
          {m.status === 'failed' ? <span className="badge b-bad">{t('Failed')}</span> : null}
          {m.status === 'queued' || m.status === 'sending' ? <span className="badge b-grey">{t('Sending')}</span> : null}
          {team ? <span className="mbx">{mailbox}</span> : null}
        </span>
      </Link>
      <div className="hacts">
        {act('delete', Icons.trash, t('Delete'))}
        {act('archive', Icons.archive, t('Archive'))}
        {act('flag', Icons.flag, t('Flag'))}
        {act('toggleRead', Icons.unread, t('Mark as unread'))}
      </div>
    </div>
  );
}
