import { importRowStatusText } from '@dait-crm/shared';
import type { ImportRowView } from '../../api/imports';
import { useLang } from '../../i18n/useT';
import { rowStatusBadge } from './labels';

/** A staged row's status badge (step 2 and the Data manager's row tables): "Already in CRM · CO-1042" when matched. */
export function RowStatusBadge({ row }: { row: Pick<ImportRowView, 'status' | 'matched'> }) {
  const lang = useLang();
  const text = importRowStatusText(row.status, lang);
  return (
    <span className={`badge ${rowStatusBadge(row.status)}`}>
      {row.status === 'Already in CRM' && row.matched ? `${text} · ${row.matched.number}` : text}
    </span>
  );
}
