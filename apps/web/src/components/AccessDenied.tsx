import { useT } from '../i18n/useT';

export function AccessDenied() {
  const t = useT();
  return (
    <section className="card">
      <div className="placeholder" role="alert">
        <h2>{t('You do not have access')}</h2>
        <p>{t('Ask an administrator if you need this page.')}</p>
      </div>
    </section>
  );
}
