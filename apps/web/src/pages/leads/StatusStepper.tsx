import { isClosedStatus } from '@dait-crm/shared';
import type { LookupValue } from '../../api/queries';
import { leadStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

type Props = {
  /** The `lead_status` lookup group (any order; shown by sortOrder). */
  statuses: LookupValue[];
  current: string;
  onChange: (status: string) => void;
  /** No status changes (no right, archived lead, or a save in flight). */
  disabled?: boolean;
};

/**
 * The lead's pipeline as a row of steps in lookup order: earlier steps done, the current one
 * marked. Clicking an open status changes to it; closed statuses (Won / Lost / Not Relevant) are
 * shown but not clickable: they go through the Close dialog (a reason or a confirmation).
 * Retired statuses are left out unless the lead is on one.
 */
export function StatusStepper({ statuses, current, onChange, disabled }: Props) {
  const t = useT();
  const steps = statuses
    .filter((s) => s.isActive || s.value === current)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const at = steps.findIndex((s) => s.value === current);
  // A closed lead has no "done" trail: it ended there, whatever came before.
  const closedNow = isClosedStatus(current);

  return (
    <ol className="stepper" aria-label={t('Lead status')}>
      {steps.map((s, i) => {
        const closed = isClosedStatus(s.value);
        const on = s.value === current;
        const done = !closedNow && !closed && at >= 0 && i < at;
        const cls = ['stage', done ? 'done' : '', on ? 'on' : '', closed ? 'end' : '', on && closed ? 'closed' : '']
          .filter(Boolean)
          .join(' ');
        return (
          <li key={s.value} className={cls}>
            <button
              type="button"
              aria-current={on ? 'step' : undefined}
              disabled={closed || disabled}
              title={closed && !on ? t('Use Close lead to set this status') : undefined}
              onClick={() => {
                if (!on && !closed && !disabled) onChange(s.value);
              }}
            >
              <span className="bar" aria-hidden="true" />
              <span className="t">{leadStatusText(t, s.value)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
