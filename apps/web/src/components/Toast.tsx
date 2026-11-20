import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Kind = 'ok' | 'warn';
type Item = { id: number; text: string; kind: Kind };
type ToastFn = (text: string, kind?: Kind) => void;

const ToastContext = createContext<ToastFn>(() => {});

/** Toasts take already-translated text: call `toast(t('Saved'))`. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const next = useRef(1);
  const toast = useCallback<ToastFn>((text, kind = 'ok') => {
    const id = next.current++;
    setItems((xs) => [...xs, { id, text, kind }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((x) => (
          <div key={x.id} className={`toast ${x.kind}`}>
            {x.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  return useContext(ToastContext);
}
