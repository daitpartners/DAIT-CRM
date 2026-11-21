import { useT } from '../../../i18n/useT';

/** Placeholder for a tab whose feature ships in a later release (the prototype's empty-state card). */
export function EmptyTab({ release }: { release: string }) {
  const t = useT();
  return (
    <section className="card empty">
      <strong>{t('Available in release {release}', { release })}</strong>
      <div>{t('This section is not part of the current release yet.')}</div>
    </section>
  );
}
