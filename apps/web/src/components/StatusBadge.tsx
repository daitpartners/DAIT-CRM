import type { Priority } from '@dait-crm/shared';
import { leadStatusBadge, leadStatusText, priorityText } from '../i18n/labels';
import { useT } from '../i18n/useT';

/** A lead status as a coloured badge. */
export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  return <span className={leadStatusBadge(status)}>{leadStatusText(t, status)}</span>;
}

/** A priority with its coloured dot (`.prio.High` / `.Medium` / `.Low`). */
export function PriorityLabel({ priority }: { priority: Priority }) {
  const t = useT();
  return <span className={`prio ${priority}`}>{priorityText(t, priority)}</span>;
}
