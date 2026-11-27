import { useState } from 'react';
import { useLeads, type LeadSummary } from '../../../api/leads';
import { Icons } from '../../../components/Icons';
import { useDebounce } from '../../../hooks/useDebounce';
import { leadStatusText } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';
import { Menu, type MenuEntry } from '../menus';

/** The lead shown on the button: its number, company and stage. */
export type PickedLead = { id: number; number: string; company: string; status: string };

type Props = {
  value: PickedLead | null;
  /** A link's client (`?company=`): the leads offered are that client's. */
  companyId?: number;
  /** A lead chosen (with its contact, for To), or `No lead` (null). */
  onChange: (lead: LeadSummary | null) => void;
  disabled?: boolean;
};

/**
 * The New message page's Lead row (mockup `.leadpick`): a button `{number} · {company} · {stage}` (or `Choose a lead`)
 * opening a menu with the leads search (LD number or company, the leads list's search, debounced; the client's leads
 * when the link named one), each lead with its stage, then `No lead`.
 */
export function LeadPicker({ value, companyId, onChange, disabled }: Props) {
  const t = useT();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [q, setQ] = useState('');
  const query = useDebounce(q.trim(), 250);
  const { data } = useLeads({ q: query || undefined, companyId, pageSize: 8, tab: 'all' }, at !== null);
  const leads = (data?.items ?? []).filter((l) => !l.archivedAt);

  const close = () => {
    setAt(null);
    setQ('');
  };
  const items: MenuEntry[] = [
    { kind: 'head', key: 'h', label: t('Leads') },
    ...leads.map((l): MenuEntry => ({
      key: `l${l.id}`, label: `${l.number} · ${l.companyName}`, icon: Icons.link, crm: true, hint: leadStatusText(t, l.status),
      checked: l.id === value?.id ? true : undefined, onSelect: () => onChange(l),
    })),
    ...(data && leads.length === 0 ? [{ kind: 'note' as const, key: 'none', label: t('No leads match.') }] : []),
    { kind: 'sep', key: 's' },
    { key: 'none-lead', label: t('No lead'), icon: Icons.x, checked: value === null ? true : undefined, onSelect: () => onChange(null) },
  ];

  return (
    <>
      <button
        type="button"
        className="leadpick"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        disabled={disabled}
        onClick={(e) => {
          if (at) return close();
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: r.left, y: r.bottom + 4 });
        }}
      >
        <span className="ico" aria-hidden="true">{Icons.link}</span>
        <span className="lp-t">{value ? `${value.number} · ${value.company} · ${leadStatusText(t, value.status)}` : t('Choose a lead')}</span>
        <span className="ico car" aria-hidden="true">{Icons.down}</span>
      </button>
      {at ? (
        <Menu
          at={at}
          label={t('Choose a lead')}
          className="mm-link"
          items={items}
          onClose={close}
          top={(
            <input
              type="search"
              className="in"
              value={q}
              placeholder={t('Search leads by LD number or company')}
              aria-label={t('Search leads by LD number or company')}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
        />
      ) : null}
    </>
  );
}
