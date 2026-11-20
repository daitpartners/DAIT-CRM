import { useT } from '../i18n/useT';
import { Placeholder } from './Placeholder';

export function Dashboard() {
  const t = useT();
  return <Placeholder title={t('Dashboard')} release="1E" />;
}
