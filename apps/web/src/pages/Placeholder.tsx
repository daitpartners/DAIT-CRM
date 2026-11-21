import { Topbar } from '../components/Topbar';
import { useT } from '../i18n/useT';

/** Pages whose module ships in a later release. `title` must already be translated. */
export function Placeholder({ title, release }: { title: string; release?: string }) {
  const t = useT();
  return (
    <>
      <Topbar title={title} />
      <div className="page">
        <section className="card">
          <div className="placeholder">
            <h2>{release ? t('Coming in release {release}', { release }) : t('Coming in a later release')}</h2>
            <p>{t('This module is not available yet.')}</p>
          </div>
        </section>
      </div>
    </>
  );
}

export function ReportsPage() {
  const t = useT();
  return <Placeholder title={t('Reports')} release="1E" />;
}
