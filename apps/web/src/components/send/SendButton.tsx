import { useCallback, useRef, useState } from 'react';
import { useCurrentUser } from '../../api/useCurrentUser';
import { useT } from '../../i18n/useT';
import { Menu } from '../../pages/email/menus';
import { Icons } from '../Icons';
import { ScheduleSend } from './ScheduleSend';

/**
 * The split Send button (mockup `.split`): `Send`, and `▾` (Send options). `menu` (the inline editor, mockup state 2):
 * ▾ opens a menu Send / Schedule send…, the latter opening Schedule send; `popover` (the full page, state 3): ▾ opens
 * Schedule send directly. `recipientZone`: the lead's zone when not the sender's, for Schedule send's recipient line.
 */
export function SendButton({ onSend, onSchedule, options, disabled = false, title, recipientZone = null }: {
  onSend(): void;
  onSchedule(at: Date): void;
  options: 'menu' | 'popover';
  disabled?: boolean;
  /** Why it is disabled (e.g. `View only — {name}'s mailbox`). */
  title?: string;
  recipientZone?: { zone: string; label: string } | null;
}) {
  const t = useT();
  const me = useCurrentUser();
  const caret = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const closeSchedule = useCallback(() => setScheduling(false), []);

  function openOptions() {
    if (options === 'popover') {
      setScheduling((s) => !s);
      return;
    }
    const r = caret.current?.getBoundingClientRect();
    setMenuAt(menuAt ? null : { x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 });
  }

  return (
    <div className="wm-send send-split">
      <div className="split">
        <button type="button" className="btn primary" onClick={onSend} disabled={disabled} title={title}>
          <span className="ico">{Icons.send}</span>
          {t('Send')}
        </button>
        <button
          ref={caret}
          type="button"
          className="btn primary"
          aria-label={t('Send options')}
          aria-haspopup={options === 'menu' ? 'menu' : 'dialog'}
          aria-expanded={options === 'menu' ? menuAt !== null : scheduling}
          // While open, ▾ is the toggle: its press must not also count as the click outside that closes the menu.
          onMouseDown={(e) => {
            if (menuAt || scheduling) e.nativeEvent.stopPropagation();
          }}
          onClick={openOptions}
          disabled={disabled}
          title={title}
        >
          <span className="ico">{Icons.down}</span>
        </button>
      </div>
      {menuAt ? (
        <Menu
          at={menuAt}
          label={t('Send options')}
          onClose={() => setMenuAt(null)}
          items={[
            { key: 'send', label: t('Send'), icon: Icons.send, onSelect: onSend },
            { key: 'schedule', label: t('Schedule send…'), icon: Icons.clock, onSelect: () => setScheduling(true) },
          ]}
        />
      ) : null}
      {scheduling ? (
        <ScheduleSend
          timezone={me.timezone}
          recipientZone={recipientZone}
          onClose={closeSchedule}
          onPick={(at) => {
            setScheduling(false);
            onSchedule(at);
          }}
        />
      ) : null}
    </div>
  );
}
