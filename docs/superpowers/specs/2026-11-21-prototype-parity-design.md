# Prototype parity — every screen matches the prototype (short design)

Deepak Singh, 21 Nov 2026: "we need to match this prototype for all the pages" and "update the doc as well".
Builds on releases 1A–1C (live, f8ea3a0). Presentation only; behaviour rules are unchanged.

## Intent

The owner approved the HTML prototype (`prototype/index.html`) as the design. Each CRM screen must reproduce the
corresponding prototype view's layout, sections, order and look, so the sales team sees one consistent product.

## Goals / non-goals / anti-goals

- Goals: lead page restructured to the prototype's contact-first layout; Leads list, Companies list, company profile,
  Contacts, Tasks, Notifications, Dashboard and Settings reconciled with their prototype views; contact profile fields
  added; later-release panels shown in place as placeholders; spec and data model updated.
- Non-goals: building later-release features (email, mailer, calendar, quotations, projects, AI, enquiries).
- Anti-goals: changing any API rule to fit a visual; placeholders that look clickable; losing the carried-over UX fixes
  (sortable headers, bulk actions, inline validation, confirmations, phone layout).

## Approaches

1. Patch each page ad hoc — rejected: no shared record of what "matches" means; drift returns.
2. Port the prototype's HTML strings directly into React — rejected: loses escaping, i18n and accessibility work.
3. **Chosen:** a per-view parity checklist derived from `prototype/js/views-*.js` (sections in order, controls,
   empty states), applied page by page with side-by-side screenshots in the plan's acceptance step; shared
   `PlaceholderCard` for later-release panels; prototype CSS rules ported where missing.

## Decided

- Source of truth per screen: Dashboard `views-work.js V.dashboard`; Leads `views-leads2.js`; lead form
  `views-leads.js V.leadForm`; lead page `views-lead-detail.js`; Companies list/profile/modal `views-companies.js`;
  Tasks `views-work.js V.tasks`; Notifications `V.notifications`; Settings `views-settings.js` (preferences,
  users, lookups, allocation; mailbox/templates/connections as placeholders).
- Lead page = prototype structure: Topbar (number, created, last contact; Email button as placeholder, Edit profile);
  PROFILE card (contact name + badges, headline, company line, LinkedIn/mobile/email/office, lead facts grid, about,
  experience column; "Focus on email" toggle kept as a collapse); compose panel (Email tab placeholder; Call note,
  Meeting, Research note tabs working — Call note = existing Log call; Research note = `research` activity;
  Meeting = `meeting` activity without calendar); Follow-up / Emails (placeholder) / Calls tabs (follow-up date with
  quick buttons Tomorrow / +4 days / Next week, status select, priority, type, open tasks + "+ Task"); right column:
  company card (AI summary placeholder, verification badge, website, other leads, Full profile), Skills & languages
  (editable), Projects (placeholder), Coming up (open tasks/follow-ups), Original enquiry (placeholder until 1D).
  Current actions (Transfer, Close with reason, Archive, Switch contact, Claim, Unassign) live in the "More ▾" / header
  as the prototype's `data-act` buttons; status stepper stays, placed where the prototype's `.stepper` sits.
- Contacts gain `headline, location, about, experience[], education[], skills[], languages[]` (data-model.md updated).
  Editable from the lead page profile ("Edit profile") and the company Contacts tab.
- `PlaceholderCard({ title, release })`: muted card, no controls, one line "Available in release N".
- Acceptance: for each view, a side-by-side screenshot (prototype vs app, same viewport) attached in the task report;
  reviewer compares section order and controls, not pixels.
- Spec: `docs/DAIT-CRM-Specification-v2.md` gets a §14 note "Screens match the prototype"; fresh-build design §5 gets the
  layout rule (done); data model updated (done).

## Left to the builder

Component split, CSS porting details, which prototype micro-interactions (collapsible side column, quick-date
buttons) map to existing hooks.
