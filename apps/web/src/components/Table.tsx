import type { ReactNode } from 'react';

type TableProps = { head: ReactNode[]; children: ReactNode; empty?: string; isEmpty?: boolean };

/** Prototype table pattern: `.tbl` scrolls horizontally on narrow screens instead of the page. */
export function Table({ head, children, empty, isEmpty }: TableProps) {
  return (
    <div className="tbl">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isEmpty ? (
            <tr>
              <td colSpan={head.length} className="empty">
                {empty}
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}
