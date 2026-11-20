import { Link } from 'react-router-dom';
import { Topbar } from '../components/Topbar';
import { useT } from '../i18n/useT';

export function NotFound() {
  const t = useT();
  return (
    <>
      <Topbar title={t('Page not found')} />
      <div className="page">
        <section className="card">
          <div className="placeholder">
            <h2>{t('We could not find that page.')}</h2>
            <p>
              <Link to="/">{t('Go to the dashboard')}</Link>
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
