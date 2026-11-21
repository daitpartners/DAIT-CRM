import { useId, useState } from 'react';
import type { LeadFull } from '../../api/leads';
import type { LookupValue } from '../../api/queries';
import { Icons } from '../../components/Icons';
import { Tabs } from '../../components/Tabs';
import { useT } from '../../i18n/useT';
import { CallNoteForm } from './CallNoteForm';
import { MeetingForm, ResearchForm } from './NoteForms';

const FOLD_KEY = 'dait-lead-composer-closed';

function readFold(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The prototype's composer (`#composer`): Email (release 2: a disabled button in the tab's place), then the
 * working tabs Call note / Meeting / Research note, and a Hide / Show toggle that folds the box. Picking a
 * tab always opens it. `live` = the user may act on the lead (manage_leads, not archived).
 */
export function ComposePanel({ lead, statuses, live }: { lead: LeadFull; statuses: LookupValue[]; live: boolean }) {
  const t = useT();
  const [tab, setTab] = useState('call');
  const [closed, setClosedState] = useState(readFold);
  const hint = useId();

  function setClosed(next: boolean) {
    setClosedState(next);
    try {
      localStorage.setItem(FOLD_KEY, next ? '1' : '0');
    } catch {
      /* storage blocked: the state lasts for this visit only */
    }
  }

  return (
    <section id="composer" className={closed ? 'card flush composer is-closed' : 'card flush composer'} aria-label={t('Compose')}>
      <div className="composer-head">
        <button type="button" className="tab ctab-ph" disabled title={t('Available in release 2')} aria-describedby={hint}>
          <span className="ctab">
            {Icons.mail}
            {t('Email')}
          </span>
        </button>
        <span id={hint} hidden>
          {t('Available in release 2')}
        </span>
        <Tabs
          label={t('Compose')}
          active={tab}
          onChange={(id) => {
            setTab(id);
            setClosed(false);
          }}
          tabs={[
            { id: 'call', label: t('Call note') },
            { id: 'meeting', label: t('Meeting') },
            { id: 'research', label: t('Research note') },
          ]}
          panelClassName="body"
        >
          {closed ? null : tab === 'call' ? (
            <CallNoteForm lead={lead} statuses={statuses} disabled={!live} />
          ) : tab === 'meeting' ? (
            <MeetingForm lead={lead} disabled={!live} />
          ) : (
            <ResearchForm lead={lead} disabled={!live} />
          )}
        </Tabs>
        <button type="button" className="l2ctog" aria-expanded={!closed} aria-controls="composer" onClick={() => setClosed(!closed)} title={t('Show or hide this box')}>
          <span>{closed ? t('Show') : t('Hide')}</span>
          {Icons.chev}
        </button>
      </div>
    </section>
  );
}
