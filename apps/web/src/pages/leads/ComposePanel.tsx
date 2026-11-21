import { createContext, useContext, useState } from 'react';
import type { LeadFull } from '../../api/leads';
import type { LookupValue } from '../../api/queries';
import { Icons } from '../../components/Icons';
import { Tabs } from '../../components/Tabs';
import { useT } from '../../i18n/useT';
import { CallNoteForm } from './CallNoteForm';
import { EMAIL_SUBJECT_ID, EmailForm } from './EmailForm';
import { MeetingForm, ResearchForm } from './NoteForms';

const FOLD_KEY = 'dait-lead-composer-closed';

function readFold(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
}

/** What the lead page shares with the composer: which tab is open, whether the box is folded, and "open Email". */
export type ComposeControl = {
  tab: string;
  setTab: (tab: string) => void;
  closed: boolean;
  setClosed: (closed: boolean) => void;
  /** Opens the box on the Email tab, scrolls to it and puts the cursor in Subject. */
  openEmail: () => void;
};

export const ComposeContext = createContext<ComposeControl | null>(null);

/** State for `ComposeContext`, created once by the lead page. */
export function useComposeControl(): ComposeControl {
  const [tab, setTab] = useState('email');
  const [closed, setClosedState] = useState(readFold);

  function setClosed(next: boolean) {
    setClosedState(next);
    try {
      localStorage.setItem(FOLD_KEY, next ? '1' : '0');
    } catch {
      /* storage blocked: the state lasts for this visit only */
    }
  }

  function openEmail() {
    setTab('email');
    setClosed(false);
    // After the panel is shown: bring the composer into view and focus Subject.
    requestAnimationFrame(() => {
      document.getElementById('composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById(EMAIL_SUBJECT_ID)?.focus({ preventScroll: true });
    });
  }

  return { tab, setTab, closed, setClosed, openEmail };
}

/**
 * The prototype's composer (`#composer`): tabs Email / Call note / Meeting / Research note (Email first and open
 * by default) and a Hide / Show toggle that folds the box. Picking a tab always opens it; every form stays mounted
 * so drafts survive switching tabs. `live` = the user may act on the lead (manage_leads, not archived).
 */
export function ComposePanel({ lead, statuses, live }: { lead: LeadFull; statuses: LookupValue[]; live: boolean }) {
  const t = useT();
  const { tab, setTab, closed, setClosed } = useContext(ComposeContext)!;

  return (
    <section id="composer" className={closed ? 'card flush composer is-closed' : 'card flush composer'} aria-label={t('Compose')}>
      <div className="composer-head">
        <Tabs
          label={t('Compose')}
          active={tab}
          onChange={(id) => {
            setTab(id);
            setClosed(false);
          }}
          tabs={[
            { id: 'email', label: t('Email'), icon: Icons.mail },
            { id: 'call', label: t('Call note'), icon: Icons.phone },
            { id: 'meeting', label: t('Meeting'), icon: Icons.calendar },
            { id: 'research', label: t('Research note'), icon: Icons.book },
          ]}
          panelClassName="body"
        >
          {/* All four forms stay mounted (hidden when inactive or folded) so a draft survives a tab switch. */}
          <div hidden={closed || tab !== 'email'}>
            {/* Remount when the contact changes so To and the greeting follow the new person. */}
            <EmailForm key={lead.contact?.id ?? 'none'} lead={lead} disabled={!live} />
          </div>
          <div hidden={closed || tab !== 'call'}>
            <CallNoteForm lead={lead} statuses={statuses} disabled={!live} />
          </div>
          <div hidden={closed || tab !== 'meeting'}>
            <MeetingForm lead={lead} disabled={!live} />
          </div>
          <div hidden={closed || tab !== 'research'}>
            <ResearchForm lead={lead} disabled={!live} />
          </div>
        </Tabs>
        <button type="button" className="l2ctog" aria-expanded={!closed} aria-controls="composer" onClick={() => setClosed(!closed)} title={t('Show or hide this box')}>
          <span>{closed ? t('Show') : t('Hide')}</span>
          {Icons.chev}
        </button>
      </div>
    </section>
  );
}
