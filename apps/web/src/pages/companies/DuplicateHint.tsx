import { Link } from 'react-router-dom';
import type { DuplicateCandidate, DuplicateResult } from '../../api/companies';
import { useT } from '../../i18n/useT';

const label = (c: DuplicateCandidate) => `${c.number} ${c.name}`;

/**
 * Live duplicate warning under the company name. An automatic match (same website or email domain)
 * blocks saving and offers the existing record; review matches are listed but do not block.
 */
export function DuplicateHint({ result }: { result: DuplicateResult | undefined }) {
  const t = useT();
  if (!result) return null;
  if (result.auto) {
    const c = result.auto;
    return (
      <div className="note danger" role="alert">
        {t('This looks like {company}.', { company: label(c) })}{' '}
        <Link to={`/companies/${c.id}`}>{t('Open it instead?')}</Link>
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
            <Link to={`/companies/${candidate.id}`}>{label(candidate)}</Link>
            {' · '}
            {how === 'legal_name' ? t('same legal name') : how === 'name_country' ? t('same name and country') : t('same website domain')}
          </li>
        ))}
      </ul>
    </div>
  );
}
