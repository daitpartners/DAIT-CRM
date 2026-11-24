import type { KeyboardEvent } from 'react';
import { useT } from '../../../i18n/useT';

export type Step = 1 | 2 | 3 | 4;

/** The four steps (mockup `ol.wsteps`): the current one `on`, earlier ones `done`; each is clickable. */
export function WizardSteps({ step, onGo }: { step: Step; onGo: (n: Step) => void }) {
  const t = useT();
  const steps: { n: Step; label: string; title: string }[] = [
    { n: 1, label: t('Upload'), title: t('Language and files') },
    { n: 2, label: t('Sort the data'), title: t('Engine builds the table') },
    { n: 3, label: t('AI research'), title: t('Fill missing details') },
    { n: 4, label: t('Review and import'), title: t('Approve and save') },
  ];
  const key = (e: KeyboardEvent<HTMLLIElement>, n: Step) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onGo(n);
    }
  };
  return (
    <ol className="wsteps" aria-label={t('Import steps')}>
      {steps.map((s) => (
        <li
          key={s.n}
          data-step={s.n}
          role="button"
          tabIndex={0}
          title={s.title}
          className={s.n === step ? 'on' : s.n < step ? 'done' : undefined}
          aria-current={s.n === step ? 'step' : undefined}
          onClick={() => onGo(s.n)}
          onKeyDown={(e) => key(e, s.n)}
        >
          <span>{s.n}</span>
          {s.label}
        </li>
      ))}
    </ol>
  );
}
