import { useMemo, useState } from 'react';
import { useCompanies } from '../api/companies';
import { useDebounce } from '../hooks/useDebounce';
import { useT } from '../i18n/useT';
import { Combobox, type ComboOption } from './Combobox';

type Props = {
  id: string;
  label: string;
  value: number | undefined;
  onChange: (id: number) => void;
  required?: boolean;
  /** Shows `errorText` under the box and marks it invalid. */
  invalid?: boolean;
  errorText?: string;
  /** Label for a value chosen outside the picker (e.g. "Link" on a duplicate hint) that a search may not return. */
  selected?: ComboOption | null;
  className?: string;
  /** Offers an empty first option with this label (also the placeholder); choosing it calls `onClear`. */
  emptyLabel?: string;
  onClear?: () => void;
  /** Labels options "CO-… · name". */
  showNumber?: boolean;
};

/** Company chooser that searches companies server-side as the user types. Closed companies are not offered. */
export function CompanyPicker({
  id, label, value, onChange, required, invalid, errorText, selected, className, emptyLabel, onClear, showNumber,
}: Props) {
  const t = useT();
  const [text, setText] = useState('');
  const q = useDebounce(text.trim(), 400);
  const { data } = useCompanies({ page: 1, pageSize: 100, sort: 'name', dir: 'asc', q: q || undefined });
  // Remember the chosen company so its name stays shown when a later search no longer returns it.
  const [chosen, setChosen] = useState<ComboOption | null>(null);
  const options = useMemo(() => {
    const opts = (data?.items ?? [])
      .filter((c) => c.status !== 'Closed')
      .map((c) => ({ value: String(c.id), label: showNumber ? `${c.number} · ${c.name}` : c.name }));
    for (const o of [chosen, selected]) if (o && !opts.some((x) => x.value === o.value)) opts.unshift(o);
    if (emptyLabel !== undefined) opts.unshift({ value: '', label: emptyLabel });
    return opts;
  }, [data, chosen, selected, emptyLabel, showNumber]);

  return (
    <div className={className}>
      <Combobox
        id={id}
        label={label}
        required={required}
        searchable
        options={options}
        value={value === undefined ? null : String(value)}
        placeholder={emptyLabel ?? t('Type to search companies…')}
        onQuery={setText}
        errorId={invalid ? `${id}-err` : undefined}
        onChange={(v) => {
          if (v === '') {
            onClear?.();
            return;
          }
          const o = options.find((x) => x.value === v);
          if (o) setChosen(o);
          onChange(Number(v));
        }}
      />
      {invalid ? (
        <div id={`${id}-err`} className="err-msg" role="alert">
          {errorText}
        </div>
      ) : null}
    </div>
  );
}
