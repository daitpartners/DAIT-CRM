import { PlaceholderCard } from '../../../components/PlaceholderCard';
import { useT } from '../../../i18n/useT';

/** Release that brings AI research, enrichment and source records. */
const AI_RELEASE = '4';

/**
 * AI Intelligence tab in the prototype's layout, every panel a placeholder until release 4: main column
 * AI business intelligence, Suggestions awaiting review, Enrichment history; side column AI classification
 * and Enrichment engine.
 */
export function AiTab() {
  const t = useT();
  return (
    <div className="cols">
      <div className="col-main">
        <PlaceholderCard
          title={t('AI business intelligence')}
          release={AI_RELEASE}
          hint={t('Opportunity score, confidence and an AI company summary built from approved sources.')}
        />
        <PlaceholderCard
          title={t('Suggestions awaiting review')}
          release={AI_RELEASE}
          hint={t('Accepting writes the value. Verified fields are locked and never overwritten.')}
        />
        <PlaceholderCard title={t('Enrichment history')} release={AI_RELEASE} />
      </div>
      <aside className="col-side">
        <PlaceholderCard
          title={t('AI classification')}
          release={AI_RELEASE}
          hint={t('Industry, business category, opportunity score, confidence and potential services.')}
        />
        <PlaceholderCard title={t('Enrichment engine')} release={AI_RELEASE} />
      </aside>
    </div>
  );
}

/** Research Sources tab: the prototype's source table, a placeholder until release 4. */
export function SourcesTab() {
  const t = useT();
  return (
    <div className="cols">
      <div className="col-main">
        <PlaceholderCard
          title={t('Research sources')}
          release={AI_RELEASE}
          hint={t('Every URL and dataset the profile was built from. Missing facts stay empty; nothing is invented.')}
        />
      </div>
    </div>
  );
}
