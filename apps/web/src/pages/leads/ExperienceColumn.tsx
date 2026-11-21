import type { EducationEntry, ExperienceEntry } from '@dait-crm/shared';
import { useT } from '../../i18n/useT';

/** "2016 – 2021", or "2021 – Present" for the current role. */
function span(from: string, to: string | null, present: string): string {
  return `${from} – ${to ?? present}`;
}

/**
 * Right column of the PROFILE card (prototype `xpCol`): the contact's experience as a timeline, the current
 * role (no end) marked with a dot in brand purple and a "Current" badge. Education follows when recorded.
 */
export function ExperienceColumn({ experience, education }: { experience: ExperienceEntry[]; education: EducationEntry[] }) {
  const t = useT();
  return (
    <div className="l2col">
      <div className="l2h" role="heading" aria-level={3} id="lead-xp-title">
        <span>{t('Experience')}</span>
      </div>
      {experience.length === 0 ? (
        <div className="dim xp-none">{t('No experience recorded yet. Add it from Edit profile.')}</div>
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
      {education.length > 0 ? (
        <>
          <div className="l2h" role="heading" aria-level={3} id="lead-edu-title">
            <span>{t('Education')}</span>
          </div>
          <ul className="xp" aria-labelledby="lead-edu-title">
            {education.map((e, i) => (
              <li key={`${e.school}-${i}`} className="xpi">
                <div className="xpdot" aria-hidden="true" />
                <div>
                  <strong>{e.school}</strong>
                  <div>{e.degree}</div>
                  <div className="dim xp-span">{span(e.from, e.to, t('Present'))}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
