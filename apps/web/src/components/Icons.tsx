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
  phone: (
    <svg {...base}>
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
    </svg>
  ),
  mail: (
    <svg {...base}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  ),
  note: (
    <svg {...base}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </svg>
  ),
  flag: (
    <svg {...base}>
      <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    </svg>
  ),
  swap: (
    <svg {...base}>
      <path d="M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7" />
    </svg>
  ),
  user: (
    <svg {...base}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  ),
  calendar: (
    <svg {...base}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  ),
  quote: (
    <svg {...base}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </svg>
  ),
  search: (
    <svg {...base}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  ),
  spark: (
    <svg {...base}>
      <path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />
    </svg>
  ),
  star: (
    <svg {...base}>
      <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />
    </svg>
  ),
  // Web-mail release 2: the mockup's "…" (three filled dots).
  more: (
    <svg {...base}>
      <circle cx="5" cy="12" r="1.3" fill="currentColor" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
      <circle cx="19" cy="12" r="1.3" fill="currentColor" />
    </svg>
  ),
  send: (
    <svg {...base} strokeWidth={2}>
      <path d="M21 3L10 14M21 3l-7 18-4-7-7-4z" />
    </svg>
  ),
  edit: (
    <svg {...base} strokeWidth={2}>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  ),
  book: (
    <svg {...base} strokeWidth={2}>
      <path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z" />
      <path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z" />
    </svg>
  ),
  linkedin: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.4 2H3.6A1.6 1.6 0 0 0 2 3.6v16.8A1.6 1.6 0 0 0 3.6 22h16.8a1.6 1.6 0 0 0 1.6-1.6V3.6A1.6 1.6 0 0 0 20.4 2zM8 19H5V9h3zM6.5 7.7A1.7 1.7 0 1 1 6.5 4.3a1.7 1.7 0 0 1 0 3.4zM19 19h-3v-4.9c0-1.2 0-2.7-1.6-2.7s-1.9 1.3-1.9 2.6V19h-3V9h2.9v1.4a3.2 3.2 0 0 1 2.9-1.6c3 0 3.6 2 3.6 4.6z" />
    </svg>
  ),
  chev: (
    <svg {...base} strokeWidth={2.2} className="chev">
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  /* The prototype's clock (notifications of another kind). */
  clock: (
    <svg {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  /* Not in the prototype (which reuses the Tasks icon): Projects, so the folded sidebar tells the two apart. */
  projects: (
    <svg {...base}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M3 13h18" />
    </svg>
  ),
  /* Not in the prototype (collapsible panels, owner 23 Nov 2026): « to fold a panel, sign-out, in the same line style. */
  fold: (
    <svg {...base}>
      <path d="M11 17l-5-5 5-5" />
      <path d="M18 17l-5-5 5-5" />
    </svg>
  ),
  signout: (
    <svg {...base}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  ),
  /* Web-mail release 1 (mockup 2026-11-26-outlook-mail): view only, and the "what the CRM keeps" note. */
  lock: (
    <svg {...base}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  ),
  shield: (
    <svg {...base}>
      <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  /* Web-mail release 2 (mockup 2026-11-26-outlook-mail, its P icon map): commands, folders, attachments. */
  trash: (
    <svg {...base}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  ),
  archive: (
    <svg {...base}>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
    </svg>
  ),
  move: (
    <svg {...base}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M11 13h6M14 10l3 3-3 3" />
    </svg>
  ),
  reply: (
    <svg {...base}>
      <path d="M10 8L4 13l6 5" />
      <path d="M4 13h10a6 6 0 0 1 6 6" />
    </svg>
  ),
  replyall: (
    <svg {...base}>
      <path d="M11 8l-5 5 5 5" />
      <path d="M7 8l-5 5 5 5" />
      <path d="M6 13h9a6 6 0 0 1 6 6" />
    </svg>
  ),
  forward: (
    <svg {...base}>
      <path d="M14 8l6 5-6 5" />
      <path d="M20 13H10a6 6 0 0 0-6 6" />
    </svg>
  ),
  unread: (
    <svg {...base}>
      <rect x="3" y="6" width="15" height="12" rx="2" />
      <path d="M3 8l7.5 5L18 8" />
      <circle cx="19.5" cy="6" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  eye: (
    <svg {...base}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  followup: (
    <svg {...base}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <path d="M12 13v3l2 1" />
    </svg>
  ),
  link: (
    <svg {...base}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  ),
  activity: (
    <svg {...base}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3" />
    </svg>
  ),
  task: (
    <svg {...base}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  ),
  meeting: (
    <svg {...base}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <path d="M8 14h3v3H8z" />
    </svg>
  ),
  mailplus: (
    <svg {...base}>
      <path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8" />
      <path d="M3 7l9 6 9-6" />
      <path d="M19 15v6M16 18h6" />
    </svg>
  ),
  filter: (
    <svg {...base}>
      <path d="M4 5h16l-6 8v5l-4 2v-7z" />
    </svg>
  ),
  sync: (
    <svg {...base}>
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 20v-4h-4" />
    </svg>
  ),
  inbox: (
    <svg {...base}>
      <path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 13h5l1 3h6l1-3h5" />
    </svg>
  ),
  draft: (
    <svg {...base}>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M14 6l4 4" />
    </svg>
  ),
  hourglass: (
    <svg {...base}>
      <path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9" />
    </svg>
  ),
  users: (
    <svg {...base}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
      <path d="M17 14c2.8.5 4 2.9 4 6" />
    </svg>
  ),
  clip: (
    <svg {...base}>
      <path d="M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14.5 7" />
    </svg>
  ),
  external: (
    <svg {...base}>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  ),
  download: (
    <svg {...base}>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  ),
  x: (
    <svg {...base}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  check: (
    <svg {...base}>
      <path d="M5 12l5 5 9-10" />
    </svg>
  ),
  down: (
    <svg {...base}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  dbl: (
    <svg {...base}>
      <path d="M11 17l-5-5 5-5" />
      <path d="M18 17l-5-5 5-5" />
    </svg>
  ),
  dblr: (
    <svg {...base}>
      <path d="M13 17l5-5-5-5" />
      <path d="M6 17l5-5-5-5" />
    </svg>
  ),
  template: (
    <svg {...base}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 9v12" />
    </svg>
  ),
};
