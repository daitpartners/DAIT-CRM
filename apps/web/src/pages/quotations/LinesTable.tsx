import { formatMoney, round2, type QuoteCurrency } from '@dait-crm/shared';
import { useT } from '../../i18n/useT';

/**
 * A line as the editor holds it while typing: numbers stay strings until saved, so a half-typed "1." is kept. `key`
 * is local (stable across saves) so a row keeps focus when the server answers.
 */
export type DraftLine = { key: string; item: string; description: string; qty: string; unit: string; unitPrice: string; discount: string };

export const num = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/** qty × price less the line discount, rounded as the shared quoteTotals rounds it. */
export function lineTotal(l: Pick<DraftLine, 'qty' | 'unitPrice' | 'discount'>): number {
  const gross = round2(num(l.qty) * num(l.unitPrice));
  return round2(gross - round2((gross * num(l.discount)) / 100));
}

/** An amount without its currency code, grouped as the currency is ("1,234.50"; INR "1,23,456.00"), as the prototype's money(). */
export function amount(n: number, currency: QuoteCurrency): string {
  return formatMoney(n, currency).slice(currency.length + 1);
}

let nextKey = 1;
export const newLineKey = () => `n${nextKey++}`;

/** Prototype "+ Add line": a priced-at-zero line to fill in (`item` / `unit` are the translated "New line" / "unit"). */
export const blankLine = (item: string, unit: string): DraftLine => ({ key: newLineKey(), item, description: '', qty: '1', unit, unitPrice: '0', discount: '0' });

type Props = {
  lines: DraftLine[];
  currency: QuoteCurrency;
  editable: boolean;
  onChange: (lines: DraftLine[]) => void;
};

/** The Products & services table of the quotation editor (prototype V.quoteEditor), totals per line as you type. */
export function LinesTable({ lines, currency, editable, onChange }: Props) {
  const t = useT();
  const set = (key: string, field: keyof Omit<DraftLine, 'key'>, value: string) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  return (
    <div className="tbl">
      <table>
        <thead>
          <tr>
            <th className="q-item" style={{ width: '34%' }}>{t('Item')}</th>
            <th>{t('Qty')}</th>
            <th>{t('Unit')}</th>
            <th className="num">{t('Unit price')}</th>
            <th className="num">{t('Discount %')}</th>
            <th className="num">{t('Line total')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key}>
              <td className="wrap">
                <input
                  className="cell"
                  style={{ width: '100%', fontWeight: 600 }}
                  aria-label={t('Item')}
                  aria-invalid={l.item.trim() === '' || undefined}
                  maxLength={300}
                  value={l.item}
                  disabled={!editable}
                  onChange={(e) => set(l.key, 'item', e.target.value)}
                />
                <input
                  className="cell"
                  style={{ width: '100%', marginTop: 4, fontSize: 12, color: 'var(--muted)' }}
                  aria-label={t('Description')}
                  placeholder={t('Description')}
                  value={l.description}
                  disabled={!editable}
                  onChange={(e) => set(l.key, 'description', e.target.value)}
                />
              </td>
              <td>
                <input className="cell num" style={{ width: 64 }} aria-label={t('Qty')} type="number" min="0" step="1" value={l.qty} disabled={!editable} onChange={(e) => set(l.key, 'qty', e.target.value)} />
              </td>
              <td>
                <input className="cell" style={{ width: 90 }} aria-label={t('Unit')} maxLength={30} value={l.unit} disabled={!editable} onChange={(e) => set(l.key, 'unit', e.target.value)} />
              </td>
              <td className="num">
                <input
                  className="cell num"
                  style={{ width: 120 }}
                  aria-label={t('Unit price')}
                  type="number"
                  min="0"
                  step="0.01"
                  value={l.unitPrice}
                  disabled={!editable}
                  onChange={(e) => set(l.key, 'unitPrice', e.target.value)}
                />
              </td>
              <td className="num">
                <input
                  className="cell num"
                  style={{ width: 70 }}
                  aria-label={t('Discount %')}
                  type="number"
                  min="0"
                  max="100"
                  value={l.discount}
                  disabled={!editable}
                  onChange={(e) => set(l.key, 'discount', e.target.value)}
                />
              </td>
              <td className="num" style={{ fontWeight: 600 }}>
                {amount(lineTotal(l), currency)}
              </td>
              <td>
                {editable ? (
                  <button type="button" className="btn xs" aria-label={t('Remove line')} onClick={() => onChange(lines.filter((x) => x.key !== l.key))}>
                    ×
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
