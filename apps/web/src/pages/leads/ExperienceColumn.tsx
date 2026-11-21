import type { ExperienceEntry } from '@dait-crm/shared';
import { useT } from '../../i18n/useT';

/** "2016 – 2021", or "2021 – Present" for the current role. */
function span(from: string, to: string | null, present: string): string {
  return `${from} – ${to ?? present}`;
}

/**
 * Right column of the PROFILE card (prototype `xpCol`): the contact's experience as a timeline, the current
 * role (no end) marked with a dot in brand purple and a "Current" badge. Like the prototype, it lists experience
 * only; education is edited in Edit profile and counts towards the completeness ring. Shown on every lead (owner,
 * 22 Nov 2026): with no roles recorded, one row with "—", the lead's company as the most recent one, and "—".
 */
export function ExperienceColumn({ experience, companyName }: { experience: ExperienceEntry[]; companyName: string }) {
  const t = useT();
  return (
    <div className="l2col">
      <div className="l2h" role="heading" aria-level={3} id="lead-xp-title">
        <span>{t('Experience')}</span>
      </div>
      {experience.length === 0 ? (
        <ul className="xp" aria-labelledby="lead-xp-title">
          <li className="xpi now">
            <div className="xpdot" aria-hidden="true" />
            <div>
              <strong>—</strong>
              <div>{companyName}</div>
              <div className="dim xp-span">—</div>
            </div>
          </li>
        </ul>
      ) : (
        <ul className="xp" aria-labelledby="lead-xp-title">
          {experience.map((e, i) => (
            <li key={`${e.title}-${e.company}-${i}`} className={e.to ? 'xpi' : 'xpi now'}>
              <div className="xpdot" aria-hidden="true" />
              <div>
                <strong>{e.title}</strong>
                <div>
                  {e.company}
                  {e.to ? null : (
                    <>
                      {' '}
                      <span className="badge b-ok">{t('Current|role')}</span>
                    </>
                  )}
                </div>
                <div className="dim xp-span">{span(e.from, e.to, t('Present'))}</div>
                {e.description ? <div className="xpd">{e.description}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
