import { useId } from 'react';
import { useT } from '../i18n/useT';

type PlaceholderCardProps = {
  /** The prototype's heading for this panel (already translated by the caller). */
  title: string;
  /** The release that brings the real panel, e.g. "2" or "1D". */
  release: string;
  /** Optional one-line description of what will appear here (already translated). */
  hint?: string;
};

/**
 * A later-release panel shown in its prototype position: muted card, heading, "Available in release {release}".
 * Deliberately renders no interactive controls, so nothing here can submit a request.
 */
export function PlaceholderCard({ title, release, hint }: PlaceholderCardProps) {
  const t = useT();
  const headingId = useId();
  return (
    <section className="card ph-card" aria-disabled="true" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <p className="ph-note">{t('Available in release {release}', { release })}</p>
      {hint ? <p className="ph-hint">{hint}</p> : null}
    </section>
  );
}
