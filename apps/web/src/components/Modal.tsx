import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Keeps Tab inside `ref`, calls `onEscape` on Escape, and restores focus to the opener on unmount. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onEscape: () => void, initial?: string) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const first = root?.querySelector<HTMLElement>(initial ?? FOCUSABLE);
    first?.focus();
    function onKey(e: KeyboardEvent) {
      if (!root) return;
      if (e.key === 'Escape') {
        // An open combobox inside the dialog handles (and prevents) its own Escape first.
        if (e.defaultPrevented) return;
        e.preventDefault();
        escape.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === firstEl || !root.contains(document.activeElement))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (document.activeElement === lastEl || !root.contains(document.activeElement))) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [ref, initial]);
}

type ModalProps = { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode };

/** Accessible dialog: role="dialog", aria-modal, labelled by its title, Escape and backdrop close it. */
export function Modal({ title, onClose, children, actions }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, onClose);
  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        {children}
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
    </div>
  );
}
