import { Link } from 'react-router-dom';
import type { ContactCandidate, ContactDuplicateResult } from '../../api/contacts';
import { useT } from '../../i18n/useT';

const candidateName = (c: ContactCandidate) => `${c.firstName} ${c.lastName}`;

/** Live duplicate warning: the same email blocks saving; the same phone, or the same name at this company, is listed for review. */
export function ContactDuplicateHint({ result }: { result: ContactDuplicateResult | undefined }) {
  const t = useT();
  if (!result) return null;
  if (result.auto) {
    const c = result.auto;
    return (
      <div className="note danger" role="alert">
        {t('{name} already has this email address.', { name: candidateName(c) })}{' '}
        <Link to={`/companies/${c.companyId}#contacts`}>{t('Open their company')}</Link>
      </div>
    );
  }
  if (result.review.length === 0) return null;
  return (
    <div className="note warn" role="status">
      <strong>{t('Possible duplicates')}</strong>
      <ul className="dup-list">
        {result.review.map(({ candidate, how }) => (
          <li key={candidate.id}>
            <Link to={`/companies/${candidate.companyId}#contacts`}>{candidateName(candidate)}</Link>
            {' · '}
            {how === 'phone' ? t('same phone number') : t('same name at this company')}
          </li>
        ))}
      </ul>
    </div>
  );
}
