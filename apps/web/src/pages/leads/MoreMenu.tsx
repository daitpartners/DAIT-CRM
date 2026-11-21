import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icons } from '../../components/Icons';
import { useT } from '../../i18n/useT';

export type MenuItem = { id: string; label: string; onSelect: () => void; danger?: boolean };

/**
 * "More ▾" actions as a real popover menu (WAI-ARIA menu button): opens on click / Enter / Space /
 * ArrowDown with focus on the first item, Up/Down/Home/End move, Escape or Tab or a click outside
 * closes (Escape returns focus to the button), choosing an item closes it and runs the action.
 */
export function MoreMenu({ items, label }: { items: MenuItem[]; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const base = useId();
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    refs.current[0]?.focus();
    function onDown(e: MouseEvent) {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (items.length === 0) return null;

  function focusItem(i: number) {
    const n = items.length;
    refs.current[((i % n) + n) % n]?.focus();
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const at = refs.current.findIndex((el) => el === document.activeElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(at + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(at - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusItem(0);
        break;
      case 'End':
        e.preventDefault();
        focusItem(items.length - 1);
        break;
      case 'Escape':
        e.preventDefault();
        // Inside a dialog's focus trap too: this menu handles its own Escape.
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  }

  return (
    <div className="menu-wrap" ref={root}>
      <button
        ref={button}
        type="button"
        className="btn"
        id={`${base}-btn`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${base}-menu` : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label ?? t('More')}
        {Icons.caret}
      </button>
      {open ? (
        <div className="menu" role="menu" id={`${base}-menu`} aria-labelledby={`${base}-btn`} onKeyDown={onMenuKey}>
          {items.map((item, i) => (
            <button
              key={item.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.danger ? 'danger' : undefined}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
