import { createContext, useCallback, useContext, useId, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n/useT';
import { useDialogFocus } from './Modal';

export type ConfirmOptions = { title: string; body: string; confirmLabel: string; danger?: boolean };
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);

/** `const confirm = useConfirm(); if (await confirm({...})) ...` — every destructive action goes through this. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? <ConfirmDialog {...pending} onSettle={settle} /> : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

function ConfirmDialog({ title, body, confirmLabel, danger, onSettle }: ConfirmOptions & { onSettle: (ok: boolean) => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useDialogFocus(ref, () => onSettle(false), '[data-cancel]');
  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onSettle(false);
      }}
    >
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} style={{ width: 440 }}>
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId} style={{ margin: 0, lineHeight: 1.5, color: 'var(--body)' }}>
          {body}
        </p>
        <div className="actions">
          <button type="button" className="btn" data-cancel onClick={() => onSettle(false)}>
            {t('Cancel')}
          </button>
          <button type="button" className={danger ? 'btn danger' : 'btn primary'} onClick={() => onSettle(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
