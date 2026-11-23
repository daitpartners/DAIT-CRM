import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../i18n/useT';
import { Icons } from './Icons';

export type ComboOption = { value: string; label: string };

export type ComboboxProps = {
  id: string;
  label: string;
  options: ComboOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  /** Keep the label for screen readers only (e.g. inside a toolbar). */
  hideLabel?: boolean;
  /** Always show the search box, even for a short list (options that are searched server-side). */
  searchable?: boolean;
  /** Called with the typed text as it changes ('' when the list closes), for server-side search. */
  onQuery?: (text: string) => void;
  /** Marks the input invalid and points it at an error message. */
  errorId?: string;
};

/** Below this many options a plain <select> is easier than a search box (prototype's COMBO_MIN). */
export const COMBO_MIN = 8;

function highlight(label: string, q: string): ReactNode {
  if (!q) return label;
  const k = label.toLowerCase().indexOf(q);
  if (k < 0) return label;
  return (
    <>
      {label.slice(0, k)}
      <mark>{label.slice(k, k + q.length)}</mark>
      {label.slice(k + q.length)}
    </>
  );
}

export function Combobox(props: ComboboxProps) {
  const { id, label, required, hideLabel } = props;
  return (
    <div>
      <label htmlFor={id} className={hideLabel ? 'sr' : 'lbl'}>
        {label}
        {required && !hideLabel ? <>{' '}<span className="req" aria-hidden="true">*</span></> : null}
      </label>
      {props.options.length < COMBO_MIN && !props.searchable ? <PlainSelect {...props} /> : <SearchBox {...props} />}
    </div>
  );
}

function PlainSelect({ id, options, value, onChange, placeholder, required }: ComboboxProps) {
  const t = useT();
  const showBlank = value === null || value === '' || !required;
  return (
    <select
      id={id}
      className="in"
      value={value ?? ''}
      required={required}
      onChange={(e) => {
        if (e.target.value !== '') onChange(e.target.value);
      }}
    >
      {showBlank ? <option value="">{placeholder ?? t('Choose…')}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function SearchBox({ id, options, value, onChange, placeholder, required, onQuery, errorId }: ComboboxProps) {
  const t = useT();
  const listId = `${id}-list`;
  const selected = options.find((o) => o.value === value);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(selected?.label ?? '');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  // When closed, the input always shows the chosen option's label.
  useEffect(() => {
    if (!open) setText(selected?.label ?? '');
  }, [open, selected?.label]);

  const q = query.trim().toLowerCase();
  // With onQuery the caller searches server-side, so `options` are already the matches.
  const shown = useMemo(() => (q && !onQuery ? options.filter((o) => o.label.toLowerCase().includes(q)) : options), [options, q, onQuery]);

  useEffect(() => {
    if (!open || active < 0) return;
    const li = listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    li?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  function show() {
    if (open) return;
    setOpen(true);
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
  }

  function hide() {
    setOpen(false);
    setQuery('');
    setActive(-1);
    onQuery?.('');
  }

  function choose(i: number) {
    const o = shown[i];
    if (!o) return;
    hide();
    setText(o.label);
    if (o.value !== value) onChange(o.value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) return show();
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return show();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      if (open) {
        e.preventDefault();
        choose(active);
      }
    } else if (e.key === 'Escape') {
      if (open) e.preventDefault();
      hide();
    } else if (e.key === 'Tab') {
      // Keep an exact typed match, otherwise revert to the current value.
      const exact = q ? options.find((o) => o.label.toLowerCase() === q) : undefined;
      hide();
      if (exact && exact.value !== value) onChange(exact.value);
    }
  }

  const total = options.length;
  return (
    <div className="combo">
      <input
        id={id}
        type="text"
        className={errorId ? 'in err' : 'in'}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 && shown[active] ? `${id}-opt-${active}` : undefined}
        aria-required={required || undefined}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
        autoComplete="off"
        placeholder={placeholder ?? t('Type to search…')}
        value={text}
        onFocus={(e) => {
          // A dialog opening on this field gives it the cursor without opening the list (review #33).
          if (!e.currentTarget.dataset.dialogFocus) show();
          e.currentTarget.select();
        }}
        onClick={show}
        onChange={(e) => {
          setText(e.target.value);
          setQuery(e.target.value);
          onQuery?.(e.target.value);
          setOpen(true);
          setActive(e.target.value.trim() ? 0 : -1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => hide()}
      />
      <button
        type="button"
        className="caret"
        tabIndex={-1}
        aria-label={t('Open list')}
        onMouseDown={(e) => {
          e.preventDefault();
          if (open) hide();
          else (e.currentTarget.previousElementSibling as HTMLInputElement | null)?.focus();
        }}
      >
        {Icons.caret}
      </button>
      <ul id={listId} ref={listRef} className="combo-list" role="listbox" aria-label={t('Options')} hidden={!open}>
        <li className="hint" role="presentation">
          {q ? t('{n} of {total} match', { n: shown.length, total }) : t('{total} options · type to filter', { total })}
        </li>
        {shown.map((o, i) => (
          <li
            key={o.value}
            id={`${id}-opt-${i}`}
            data-i={i}
            role="option"
            aria-selected={i === active}
            className={i === active ? 'on' : undefined}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(i);
            }}
          >
            {highlight(o.label, q)}
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="none" role="presentation">
            {t('No match for "{q}"', { q: query.trim() })}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
