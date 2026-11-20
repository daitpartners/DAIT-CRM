import { Navigate, useLocation } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useMe } from '../api/queries';
import { useT } from '../i18n/useT';
import { Shell } from './Shell';

/** Layout route: loads /api/me; signed-out users go to /sign-in. */
export function RequireAuth() {
  const t = useT();
  const location = useLocation();
  const { data: me, error, isPending } = useMe();
  if (isPending) {
    return (
      <div className="placeholder" role="status">
        {t('Loading…')}
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 401) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }
  if (!me) {
    return (
      <div className="placeholder" role="alert">
        {t('Something went wrong. Please try again.')}
      </div>
    );
  }
  return <Shell me={me} />;
}
