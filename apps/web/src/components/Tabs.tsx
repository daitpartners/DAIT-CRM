import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

/** `countClass` styles the count (e.g. 'bad' for the duplicate-review queue); `icon` sits before the label. */
export type TabDef = { id: string; label: string; count?: number; countClass?: string; icon?: ReactNode };

type TabsProps = {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  /** Accessible name of the tablist. */
  label: string;
  /** Content of the active panel; inactive panels are not rendered at all. */
  children?: ReactNode;
  className?: string;
  panelClassName?: string;
};

/**
 * WAI-ARIA tabs with automatic activation: one tab stop (roving tabindex), Left/Right wrap,
 * Home/End jump. Only the active panel is in the DOM, so only the active tab carries aria-controls
 * (an aria-controls pointing at a missing id is invalid).
 */
export function Tabs({ tabs, active, onChange, label, children, className, panelClassName }: TabsProps) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabId = (id: string) => `${base}-tab-${id}`;
  const panelId = (id: string) => `${base}-panel-${id}`;
  const current = Math.max(0, tabs.findIndex((t) => t.id === active));

  function go(i: number) {
    const n = tabs.length;
    const next = ((i % n) + n) % n;
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let target: number | null = null;
    if (e.key === 'ArrowRight') target = i + 1;
    else if (e.key === 'ArrowLeft') target = i - 1;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = tabs.length - 1;
    if (target === null) return;
    e.preventDefault();
    go(target);
  }

  const activeId = tabs[current]?.id ?? active;
  return (
    <>
      <div role="tablist" aria-label={label} className={className ? `tabs ${className}` : 'tabs'}>
        {tabs.map((t, i) => {
          const selected = i === current;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t.id)}
              className={selected ? 'tab on' : 'tab'}
              aria-selected={selected}
              aria-controls={selected ? panelId(t.id) : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {t.icon ? (
                <span className="ctab">
                  {t.icon}
                  {t.label}
                </span>
              ) : (
                t.label
              )}
              {t.count !== undefined ? (
                <>
                  {' '}
                  <span className={t.countClass ? `n ${t.countClass}` : 'n'}>{t.count}</span>
                </>
              ) : null}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={panelId(activeId)} aria-labelledby={tabId(activeId)} tabIndex={0} className={panelClassName}>
        {children}
      </div>
    </>
  );
}
