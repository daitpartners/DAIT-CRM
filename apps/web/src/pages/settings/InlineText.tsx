import { useEffect, useState } from 'react';

type Props = { label: string; value: string; onSave: (next: string) => boolean };

/** A table-cell text input that saves on blur or Enter and reverts on Escape (or when onSave returns false). */
export function InlineText({ label, value, onSave }: Props) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  function commit() {
    if (text === value) return;
    if (!onSave(text)) setText(value);
  }

  return (
    <input
      className="in cell-in"
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setText(value);
        }
      }}
    />
  );
}
