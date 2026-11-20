import { Combobox, type ComboOption } from './Combobox';
import { useT } from '../i18n/useT';

type Props = {
  id: string;
  label: string;
  options: ComboOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
};

/** Multi-select built from Combobox: pick to add, chips list with remove buttons. */
export function MultiCombobox({ id, label, options, values, onChange, placeholder, required, disabled }: Props) {
  const t = useT();
  const remaining = options.filter((o) => !values.includes(o.value));
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {disabled ? (
        <div>
          <span className="lbl">{label}</span>
        </div>
      ) : (
        <Combobox
          id={id}
          label={label}
          options={remaining}
          value={null}
          onChange={(v) => onChange([...values, v])}
          placeholder={placeholder ?? t('Add…')}
          required={required}
        />
      )}
      {values.length && !disabled ? (
        <ul className="chips" aria-label={t('Selected: {label}', { label })} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {values.map((v) => (
            <li key={v} className="pill">
              {labelOf(v)}
              <button type="button" aria-label={t('Remove {item}', { item: labelOf(v) })} onClick={() => onChange(values.filter((x) => x !== v))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
