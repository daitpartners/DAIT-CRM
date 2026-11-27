import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { resolveRecipients, useRecipientSuggestions, type Recipient } from '../../../api/drafts';
import { Icons } from '../../../components/Icons';
import { initials } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';

const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/;
const key = (a: string) => a.trim().toLowerCase();

/** The addresses in typed or pasted text (`a@b.co, "Ana" <ana@c.co>; x@y.z`), and what is not an address. */
export function parseAddresses(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[,;\n]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const angled = /<([^<>]+)>\s*$/.exec(part);
    const words = angled ? [angled[1]!.trim()] : part.split(/\s+/);
    for (const w of words) (EMAIL_RE.test(w) ? valid : invalid).push(w);
  }
  return { valid, invalid };
}

type Props = {
  label: 'To' | 'Cc' | 'Bcc';
  value: string[];
  onChange: (next: string[]) => void;
  autoFocus?: boolean;
  /** Who the addresses are, as the draft gave them (the rest are asked once with resolveRecipients). */
  known?: Recipient[];
  /** After the input, at the end of the row (the To row's Cc and Bcc links). */
  extra?: ReactNode;
  disabled?: boolean;
};

/**
 * A To / Cc / Bcc row of the mail editor (mockup `.fld` / `.rcp`): a chip per address (initials, the name or the
 * address, the lead number as `.lead-tag` when the CRM knows it, `Remove`), and an input taking Enter, a comma, a
 * semicolon, leaving the field, or a paste of several addresses. Text that is not an address stays in the input,
 * marked invalid. Suggestions (contacts, leads, users) from 2 characters.
 */
export function RecipientField({ label, value, onChange, autoFocus, known, extra, disabled }: Props) {
  const t = useT();
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hl, setHl] = useState(-1);
  const [info, setInfo] = useState<Map<string, Recipient>>(() => new Map((known ?? []).map((r) => [key(r.address), r])));
  const asked = useRef(new Set<string>((known ?? []).map((r) => key(r.address))));
  const latest = useRef(value);
  latest.current = value;
  const { data: suggestions } = useRecipientSuggestions(focused ? text : '');
  const offered = (suggestions ?? []).filter((s) => !value.some((v) => key(v) === key(s.address))).slice(0, 8);
  const open = focused && text.trim().length >= 2 && offered.length > 0;

  // Who each address is, asked once per address.
  useEffect(() => {
    const missing = value.filter((a) => !asked.current.has(key(a)));
    if (!missing.length) return;
    for (const a of missing) asked.current.add(key(a));
    resolveRecipients(missing)
      .then((items) => setInfo((m) => {
        const next = new Map(m);
        for (const r of items) next.set(key(r.address), r);
        return next;
      }))
      .catch(() => {});
  }, [value]);

  function add(addresses: string[], who: Recipient[] = []) {
    if (who.length) {
      setInfo((m) => {
        const next = new Map(m);
        for (const r of who) next.set(key(r.address), r);
        return next;
      });
      for (const r of who) asked.current.add(key(r.address));
    }
    const have = new Set(latest.current.map(key));
    const fresh = addresses.filter((a) => {
      if (have.has(key(a))) return false;
      have.add(key(a));
      return true;
    });
    if (fresh.length) onChange([...latest.current, ...fresh]);
  }

  /** Turns what was typed into chips; what is not an address stays in the input, marked. */
  function commit(raw: string) {
    const { valid, invalid: bad } = parseAddresses(raw);
    add(valid);
    setText(bad.join(', '));
    setInvalid(bad.length > 0);
    setHl(-1);
  }

  function pick(r: Recipient) {
    add([r.address], [r]);
    setText('');
    setInvalid(false);
    setHl(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setHl((i) => (e.key === 'ArrowDown' ? (i + 1) % offered.length : (i - 1 + offered.length) % offered.length));
      return;
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      if (e.key === 'Enter' && open && hl >= 0 && offered[hl]) pick(offered[hl]!);
      else if (text.trim()) commit(text);
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setFocused(false);
      return;
    }
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text');
    if (!/[,;\n]/.test(pasted) && !EMAIL_RE.test(pasted.trim())) return; // a part of an address: typed as usual
    e.preventDefault();
    commit(`${text} ${pasted}`);
  }

  const name = { To: t('To'), Cc: t('Cc'), Bcc: t('Bcc') }[label];
  const inputLabel = { To: t('Add recipient'), Cc: t('Add Cc'), Bcc: t('Add Bcc') }[label];

  return (
    <div className="fld">
      <label htmlFor={inputId}>{name}</label>
      <div className="fv">
        {value.map((a) => {
          const r = info.get(key(a));
          const shown = r?.name || a;
          return (
            <span key={key(a)} className="rcp" title={a}>
              <span className="av" aria-hidden="true">{initials(r?.name || a.split('@')[0]!.replace(/[._-]+/g, ' '))}</span>
              {shown}
              {r?.leadNumber ? <span className="lead-tag">{r.leadNumber}</span> : null}
              <button type="button" className="x" aria-label={t('Remove')} title={t('Remove')} disabled={disabled} onClick={() => onChange(value.filter((v) => key(v) !== key(a)))}>
                <span className="ico" aria-hidden="true">{Icons.x}</span>
              </button>
            </span>
          );
        })}
        <span className="rcp-in">
          <input
            id={inputId}
            aria-label={inputLabel}
            placeholder={value.length ? undefined : t('Add people')}
            aria-invalid={invalid || undefined}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            role="combobox"
            className={invalid ? 'bad' : undefined}
            value={text}
            autoFocus={autoFocus}
            disabled={disabled}
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
              setInvalid(false);
              setHl(-1);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (text.trim()) commit(text);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {open ? (
            <ul className="rcp-sug" role="listbox" id={listId} aria-label={t('Suggestions')}>
              {offered.map((s, i) => (
                <li
                  key={key(s.address)}
                  role="option"
                  aria-selected={i === hl}
                  className={i === hl ? 'hl' : undefined}
                  // Chosen on press, before the input loses the focus.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                >
                  <span className="av" aria-hidden="true">{initials(s.name || s.address)}</span>
                  <span className="sn">
                    <b>{s.name || s.address}</b>
                    {s.name ? <small>{s.address}</small> : null}
                  </span>
                  {s.leadNumber ? <span className="lead-tag">{s.leadNumber}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </span>
      </div>
      {extra}
    </div>
  );
}
