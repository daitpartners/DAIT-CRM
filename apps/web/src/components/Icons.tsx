/* Inline SVG icons copied from the prototype's UI.I set (prototype/js/ui.js). */
import type { ReactElement } from 'react';

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const Icons: Record<string, ReactElement> = {
  dash: (
    <svg {...base}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  leads: (
    <svg {...base}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
      <path d="M17 14c2.8.5 4 2.9 4 6" />
    </svg>
  ),
  companies: (
    <svg {...base}>
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" />
    </svg>
  ),
  contacts: (
    <svg {...base}>
      <rect x="4" y="3" width="15" height="18" rx="2" />
      <circle cx="11.5" cy="10" r="2.5" />
      <path d="M7.5 17c.6-2 2.2-3 4-3s3.4 1 4 3M2 7h3M2 12h3M2 17h3" />
    </svg>
  ),
  tasks: (
    <svg {...base}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  ),
  bell: (
    <svg {...base}>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  ),
  reports: (
    <svg {...base}>
      <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
    </svg>
  ),
  settings: (
    <svg {...base}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </svg>
  ),
  plus: (
    <svg {...base} width="16" height="16" strokeWidth={2.2}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  caret: (
    <svg {...base} strokeWidth={2}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  menu: (
    <svg {...base} strokeWidth={2}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
  close: (
    <svg {...base} strokeWidth={2}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
};
