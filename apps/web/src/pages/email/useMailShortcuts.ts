import { useEffect, useRef } from 'react';
import type { CommandId } from './useMailCommands';

/** Focus in a field (typing there types, Review Focus 4). */
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * The command a key stands for (web-mail release 2, Outlook): Delete → delete, E → archive, Ctrl/⌘+U → mark unread
 * (`toggleRead`, F31), R → reply, Shift+R → reply all, F → forward, N → new mail. Letters with Ctrl, ⌘ or Alt are the
 * browser's (⌘R reloads), except Ctrl/⌘+U.
 */
export function shortcutFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): CommandId | null {
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key === 'u') return 'toggleRead';
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Delete') return e.shiftKey ? null : 'delete';
  if (key === 'r') return e.shiftKey ? 'replyAll' : 'reply';
  if (e.shiftKey) return null;
  switch (key) {
    case 'e': return 'archive';
    case 'f': return 'forward';
    case 'n': return 'new';
    default: return null;
  }
}

/**
 * The Email screen's keyboard shortcuts (shortcutFor), and Escape → `onEscape`. `run` is the screen's command runner
 * (useMailCommands' `run` on the open message), so a disabled command (view only, a draft, still sending) does nothing.
 * Nothing fires while focus is in an input, textarea, select or contenteditable element, or while a dialog is open
 * (Compose, Link email to a lead, a confirmation), so typing there types (Review Focus 4).
 */
export function useMailShortcuts(run: (id: CommandId) => void, opts: { enabled: boolean; onEscape: () => void }) {
  // The latest callbacks, without binding the listener again on every render.
  const latest = useRef({ run, onEscape: opts.onEscape });
  latest.current = { run, onEscape: opts.onEscape };

  useEffect(() => {
    if (!opts.enabled) return;
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.target instanceof Element && e.target.closest(TYPING)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === 'Escape') {
        latest.current.onEscape();
        return;
      }
      const id = shortcutFor(e);
      if (!id) return;
      e.preventDefault();
      if (e.repeat) return;
      latest.current.run(id);
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [opts.enabled]);
}
