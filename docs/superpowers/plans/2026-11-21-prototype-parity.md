# Prototype Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every CRM screen reproduces the layout, sections, order and look of its prototype view, with later-release panels shown in place as placeholders and the lead page restructured to the prototype's contact-first design.

**Architecture:** Presentation-only release on top of 1A–1C (live, da66ab7). The prototype's missing CSS rules are ported first; a shared `PlaceholderCard`; contact profile columns added to the data model; then each page is reconciled against its prototype view with a side-by-side screenshot in the task report. No API rule changes; a handful of small API additions (contact profile fields, `research`/`meeting` activities, company list tiles/tabs counts, dashboard summary).

**Tech Stack:** unchanged (Node 24, Fastify 5, Prisma 6, React 18, TanStack Query 5, Vitest, Playwright). Screenshots via Playwright in e2e (`page.screenshot`) saved under `apps/web/e2e/parity/` (gitignored) and attached to reports.

**Spec:** `docs/superpowers/specs/2026-11-21-prototype-parity-design.md`. Companions: `docs/DAIT-CRM-Specification-v2.md` §13 "Screens match the prototype", `docs/data-model.md` contacts, `prototype/js/views-*.js` and `prototype/css/app.css` (source of truth per screen), `prototype/index.html` served locally with `python3 -m http.server 8765` from `prototype/` (hash routes like `#/leads/LD-2041`; the prototype keeps state in localStorage, so use a fresh browser context).

## Global Constraints

- 1A–1C Global Constraints still apply (brand tokens, Montserrat, three languages with `i18n:check` clean, combobox rule, escaped output, `safeUrl`, root `npm test` green before every "done" commit, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`).
- Behaviour rules are untouched: status effects, visibility, concurrency, rights, audit. A parity task may move or re-skin a control; it may not change what the API does.
- Carried-over UX fixes stay: sortable headers, bulk bar, inline validation, confirm dialogs, popover menu, phone layout below 900 px, tab roles.
- Placeholder = `PlaceholderCard({ title, release, hint? })`: muted card, the prototype's heading, one line "Available in release {release}", no interactive controls, `aria-disabled`.
- Acceptance per screen: `apps/web/e2e/parity/<screen>.spec.ts` captures the app screen at 1400×1000 (signed in as Maya) into `apps/web/e2e/parity/out/<screen>-app.png`; the implementer also captures the prototype view at the same viewport into `<screen>-proto.png` and lists in the report, section by section, prototype → app, with any deliberate deviation and its reason. The reviewer compares section order, controls and empty states, not pixels.
- Prototype strings become `t('…')` phrases with es/fr translations.
- Migration folder name must sort after `20261123100000_leads_tasks`: use `20261124100000_contact_profile`.

## Review Focus

1. The lead page must keep every 1C action reachable (log call, follow-up, transfer, close with reason, archive, switch contact, claim, unassign, choose company) after the restructure; the 1C e2e `leadPage.spec.ts` must still pass unchanged except for selectors. (Task 4.)
2. Placeholders must never submit anything: a user clicking "Send email" or "Email" in the prototype position gets a disabled control, not a request. (Task 1 unit test `placeholder has no enabled controls`.)
3. Contact profile fields are optional and nullable; existing contacts render the header without them (no "undefined", no empty pills). (Task 2 test + Task 4 e2e on a contact with no profile.)
4. Companies list tiles/tabs counts respect visibility (a Sales Rep's "Total companies" equals their list total). (Task 5 API test.)
5. The dashboard shows only the signed-in user's tasks, notifications and pipeline; a Sales Rep must not see team numbers. (Task 7 API test.)

---

### Task 1: CSS port, PlaceholderCard, parity screenshot harness

**Files:**
- Modify: `apps/web/src/styles/app.css` (port the prototype rules for `.tiles`, `.tile`, `.l2*`, `.xp*`, `.sks`, `.quick`, `.rnote`, `.link`, `.num`, `.step`, `.hdr-actions`, `.crow`, `.cols`/`.col-main` if missing — diff `prototype/css/app.css` against the app's; keep existing overrides)
- Create: `apps/web/src/components/PlaceholderCard.tsx`, `apps/web/e2e/parity/_shared.ts` (`captureParity(page, name)` helper: viewport 1400×1000, full-page screenshot to `e2e/parity/out/`), `apps/web/e2e/parity/README.md` (how to capture the prototype side: serve `prototype/` on 8765, same viewport)
- Modify: `.gitignore` (`apps/web/e2e/parity/out/`), `apps/web/playwright.config.ts` (include `e2e/parity/**/*.spec.ts`)
- Test: `apps/web/test/placeholderCard.test.tsx` (`placeholder has no enabled controls`, renders title and "Available in release 2")

- [ ] Port CSS; write PlaceholderCard + test (RED → GREEN); add the harness; root `npm test` green. Commit `feat(web): prototype css port, placeholder card, parity screenshot harness`.

---

### Task 2: Contact profile fields (API)

**Files:**
- Modify: `prisma/schema.prisma` (`Contact.headline String?`, `location String?`, `about String?`, `experience Json @default("[]")`, `education Json @default("[]")`, `skills Json @default("[]")`, `languages Json @default("[]")`), migration `20261124100000_contact_profile` (additive only; verify no DROP INDEX), `packages/shared/src/schemas/contact.ts` (`ContactProfile` schema: `headline ≤200, location ≤200, about ≤5000, experience: [{ title ≤120, company ≤120, from ≤10, to ≤10|null, description ≤1000|null }] ≤ 20, education: [{ school, degree, from, to }] ≤ 10, skills: string[] ≤ 40 each ≤ 60, languages: string[] ≤ 20`; `ContactUpdate` extended with these optional), `apps/api/src/companies/serialize.ts` (`contactSummary` adds `headline, location`; new `contactProfile(c)` with everything), `apps/api/src/routes/contacts.ts` (PATCH accepts profile fields; `GET /contacts/:id` returns `contactProfile`), `apps/api/src/leads/serialize.ts` (`leadDetail.contact` becomes `contactProfile`)
- Test: `apps/api/test/contacts.test.ts` (`profile fields round-trip and default to empty arrays`, `rejects 21 experience rows`), `apps/api/test/leads.test.ts` (`lead detail includes contact profile`)

- [ ] Tests RED → migrate (`--create-only`, edit, apply; no reset) → GREEN. Commit `feat(api): contact profile fields`.

---

### Task 3: Activities `research` and `meeting`; Skills editor API

**Files:**
- Modify: `apps/api/src/routes/leads.ts` (`POST /leads/:id/research { title 1–200, url? safeUrl, body? ≤5000, updatedAt }` → `research` activity + `source_records`-style note? — no: 1C has no source_records table; write the activity only, `url` on the activity; `POST /leads/:id/meeting { title, occurredAt ISO, body?, updatedAt }` → `meeting` activity), shared `schemas/lead.ts` (`ResearchNote`, `MeetingNote`)
- Test: `apps/api/test/leads.test.ts` (`research note writes a research activity with url`, `meeting note writes a meeting activity`)

- [ ] RED → GREEN. Commit `feat(api): research and meeting notes on a lead`.

---

### Task 4: Lead page restructured to the prototype (`views-lead-detail.js`)

**Files:**
- Rewrite: `apps/web/src/pages/leads/LeadPage.tsx` (orchestration only, ≤ 200 lines), `ProfileBox.tsx` → `ProfileCard.tsx`
- Create: `pages/leads/ComposePanel.tsx` (tabs Email [placeholder], Call note [existing LogCallModal body inline], Meeting, Research note; "Hide" toggle), `pages/leads/FollowUpPanel.tsx` (tabs Follow-up / Emails [placeholder] / Calls; Follow-up tab = next follow-up date + quick buttons Tomorrow / +4 days / Next week + Scheduled badge, Priority select, Type select, Status select, Open tasks list with checkboxes and "+ Task"), `pages/leads/SideColumn.tsx` (company card: legal name, industry · city, country · staff, AI summary placeholder, verification badge, website link, "{n} other leads", Full profile →; Skills & languages card with Edit → `SkillsModal.tsx`; Projects placeholder; Coming up (open tasks + follow-up); Original enquiry placeholder "Available in release 1D"), `pages/leads/ExperienceColumn.tsx` (timeline of experience with Current badge), `pages/leads/EditProfileModal.tsx` (contact profile fields: headline, location, about, experience rows, education rows)
- Keep: `StatusStepper` (rendered where the prototype's `.stepper` sits, inside the PROFILE card below the facts grid), `Timeline` (prototype "History"/activity list under the Calls tab and in the company Activities tab), `TransferModal`, `CloseLeadModal`, `SwitchContactModal`, `MoreMenu` (prototype `data-act` buttons: Edit lead, Archive, Clone [omitted per ruling], Close, + Task; Transfer/Claim/Unassign added here), `LeadModal` (Edit lead)
- Topbar: title `{number}`, sub `Lead created: {date} | Last contact: {type · when}`; right: `Email` (placeholder button, disabled) and `Edit profile`
- Modify: `apps/web/e2e/leadPage.spec.ts` (selectors only), `apps/web/src/api/leads.ts` (research/meeting mutations), `api/contacts.ts` (profile update)
- Test: `apps/web/test/followUpPanel.test.tsx` (quick buttons set the date; Scheduled badge), `apps/web/test/profileCard.test.tsx` (renders without profile fields: no empty pills, no "undefined"), `apps/web/e2e/parity/lead-page.spec.ts` (captures app screenshot; asserts the section headings in prototype order: PROFILE, Experience, compose tabs, Follow-up/Emails/Calls, company card, Skills & languages, Projects, Coming up, Original enquiry)

- [ ] Unit + e2e RED → implement → GREEN; 1C `leadPage.spec.ts` green; root `npm test` green; i18n clean. Report with side-by-side screenshots and the section table. Commit `feat(web): lead page matches the prototype`.

---

### Task 5: Companies list and profile parity (`views-companies.js`)

**Files:**
- Modify: `apps/api/src/routes/companies.ts` (`GET /companies` returns `tiles: { total, verified, aiQueue, possibleDuplicates }` and `counts: { all, clients, open, verify, dups }` respecting `companyWhere`; `tab` query `all|clients|open|verify|dups` where `open` = has a non-closed lead, `verify` = `verificationStatus != 'Verified'`, `dups` = companies sharing `nameNormalised` with another visible company; `aiQueue` = `aiResearchStatus in ('Pending','Processing')`), shared `CompanyListQuery.tab`
- Modify: `apps/web/src/pages/companies/CompaniesList.tsx` (four tiles, five tabs with counts, subtitle, columns as the prototype), `CompanyProfile.tsx` (header per prototype: logo initials, name, legal name line, badges; tab order unchanged; Overview sections and headings exactly as prototype: "Activity summary", "Pipeline at this company", "Rules enforced here" → use as placeholder/info card text), `tabs/OverviewTab.tsx`, `tabs/ContactsTab.tsx` ("Contacts at {name}"), `tabs/LocationsTab.tsx` ("Office & branch locations"), `tabs/LeadsTab.tsx` ("Leads & prospects linked to this company"), `tabs/ActivitiesTab.tsx` ("All interactions with this company"), AI tab → placeholder "AI classification" + "Suggestions awaiting review", Research Sources tab → placeholder "Research sources" + "Where this comes from"
- Test: `apps/api/test/companies.test.ts` (`tiles and tab counts respect visibility`, `dups tab lists companies sharing a normalised name`), `apps/web/e2e/parity/companies.spec.ts`, `company-profile.spec.ts` (headings in order)

- [ ] RED → GREEN; screenshots. Commit `feat: companies list tiles/tabs and profile headings match the prototype`.

---

### Task 6: Leads list, Contacts, Tasks, Notifications parity (`views-leads2.js`, `views-work.js`)

**Files:**
- Modify: `pages/leads/LeadsList.tsx` (subtitle "Inbound leads and researched prospects, one module"; search box in the Topbar right as the prototype; filter chips row styling; "Showing n of m"; pager row with Rows select 25/50/100 + First/Prev/Page n of m/Next/Last), `pages/contacts/ContactsList.tsx` (prototype has no standalone contacts page; keep ours but style the header like the other lists — deliberate deviation, note in report), `pages/tasks/TasksList.tsx` (prototype: Topbar "Tasks" + subtitle, My tasks / Team tasks buttons (team only with `view_all_leads`), two columns: main card with sections Overdue / Due today / Upcoming each as checkbox rows `task` with due date and lead link, Completed section; side card "How tasks get here" info text), `pages/notifications/NotificationsList.tsx` (prototype: card "Notifications" list with unread dot, "History" section for read ones, Mark all read)
- Test: `apps/web/e2e/parity/leads.spec.ts`, `tasks.spec.ts`, `notifications.spec.ts`; existing 1C e2e specs updated for selectors only

- [ ] RED → GREEN; screenshots. Commit `feat(web): leads list, tasks and notifications match the prototype`.

---

### Task 7: Dashboard (`views-work.js V.dashboard`) and Settings parity (`views-settings.js`)

**Files:**
- Create: `apps/api/src/routes/dashboard.ts` (`GET /dashboard` → `{ greeting: { name, date }, tiles: { myOpenLeads, newSinceYesterday, tasksDueToday, overdue, unreadNotifications }, tasks: taskRow[] (open, mine, by due, ≤ 10), notifications: ≤ 5, pipeline: [{ status, count }] for my open leads over the first 7 statuses }` — all scoped to the signed-in user)
- Modify: `apps/web/src/pages/Dashboard.tsx` (Topbar "Good morning/afternoon/evening, {first name}" + date line + "Notifications" button; tiles row; columns: "Tasks & follow-ups" card with task rows, "Today's agenda" placeholder (release 2 calendar), "Notifications" card, "My pipeline by status" bars), `pages/settings/SettingsLayout.tsx` + pages (prototype tabs: Preferences, Users, Dropdown values, Allocation rules, Email & calendar connections [existing System mailbox page renamed/placed here], Email templates [placeholder release 2])
- Test: `apps/api/test/dashboard.test.ts` (`dashboard is scoped to the signed-in user`), `apps/web/e2e/parity/dashboard.spec.ts`, `settings.spec.ts`

- [ ] RED → GREEN; screenshots. Commit `feat: dashboard and settings match the prototype`.

---

### Task 8: Wrap-up

**Files:**
- Create: `docs/RELEASE-PARITY-CHECKLIST.md` (owner walkthrough: open each screen next to the prototype; what to check)
- Modify: `README.md` (screens follow the prototype; how to run the prototype locally for comparison), `docs/DEPLOYMENT.md` (no one-off steps; migration additive)

- [ ] Full root `npm test`, `typecheck`, `i18n:check` green. Commit `docs: prototype parity checklist`. STOP — no deploy.

---

## Self-review notes

- Spec coverage: CSS/placeholders (T1), contact fields (T2), research/meeting (T3), lead page (T4), companies (T5), leads list/tasks/notifications (T6), dashboard/settings (T7), docs (T8). Acceptance screenshots in every page task.
- Deliberate deviations recorded in the plan: Contacts page kept (prototype has none); Clone omitted (ruled in 1C); Email/Mailer/Calendar/Quotations/Projects/Enquiries sidebar entries stay hidden until their release (design §5 says "visible in the sidebar only when their release ships") — placeholders appear inside pages, not in the sidebar.
- Names consistent: `PlaceholderCard`, `captureParity`, `contactProfile`, `ContactProfile`, `ResearchNote`, `MeetingNote`, `ComposePanel`, `FollowUpPanel`, `SideColumn`, `ExperienceColumn`, `EditProfileModal`, `SkillsModal`, dashboard route shape.
