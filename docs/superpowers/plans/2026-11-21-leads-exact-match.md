# Leads Exact Prototype Match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The lead page and Leads list look like the prototype (`V.leads2`, `V.leads2List`) for leads with and without a contact, with every current action still reachable.

**Architecture:** Presentation-only changes in `apps/web/src/pages/leads/*`; no API changes. Our extra controls move into the places the design names (Follow-up tab Owner row, Edit profile dialog footer); unbuilt features render as in the prototype and answer clicks with a "Coming in release N" toast.

**Tech Stack:** React 19 + Vite, TanStack Query, react-hook-form, Playwright e2e, Vitest unit; i18n via `t('…')` with `apps/web/src/locales/{es,fr}.json` (checked by `npm run i18n:check`).

**Spec:** `docs/superpowers/specs/2026-11-21-leads-exact-match-design.md`

## Global Constraints

- Node 24 locally: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH` before any npm/npx command.
- Every new visible phrase goes through `t()` and gets es + fr entries (`npm run typecheck` runs the i18n check).
- No API or schema changes; behaviour rules (visibility, status effects, concurrency `updatedAt`) unchanged.
- Unbuilt-feature toasts use exactly: "Sending email arrives in release 2", "Coming in release 4".
- Copy from the prototype verbatim where the spec quotes it (placeholders, AI line, Projects hint, email intro text).

## Review Focus

- Archived lead: no Owner/Status/Email actions are live; Restore still offered to admins/managers (assert in Task 4 spec).
- Closed lead picked back to an open status in the Follow-up Status select reopens it (assert in Task 2 spec).
- Sales representative on an unassigned lead sees Claim in the Owner row and no Transfer (assert in Task 2 spec).
- Lead without a company: Add contact card offers ChooseCompany first rather than a contact form with no company (Task 5 spec).
- Email panel with no contact email: To placeholder "No email on file – add a contact", Send still only toasts (Task 3 spec).

---

### Task 1: Leads list — purple Lead IDs, prototype tabs and filters

**Files:**
- Modify: `apps/web/src/pages/leads/LeadsList.tsx` (tabs ~line 220, Priority filter ~line 358, Lead ID cell)
- Modify: `apps/web/src/styles/app.css` (only if the link colour needs a rule)
- Test: `apps/web/e2e/parity/leads.spec.ts`, `apps/web/e2e/leads.spec.ts` (anything using the Unassigned tab or Priority filter)

**Interfaces:** Produces nothing other tasks use.

- [ ] **Step 1: Update the parity spec first:** tabs equal `['All leads','Leads','Prospects','My leads','Overdue follow-ups']`; filter selects in order Status / Source / Country / Assigned / Lead type / Created (no "Priority: Any"); the first row's Lead ID is a link whose computed colour equals the company-link purple (`rgb(104, 17, 207)`, prototype `--link`/`#6811CF`) and font-weight 600; the Unassigned tile links to `/leads?assignedTo=none`.
- [ ] **Step 2: Run** `npx playwright test e2e/parity/leads.spec.ts` (from `apps/web`) — expect FAIL on tabs.
- [ ] **Step 3: Implement:** drop the `unassigned` tab entry and the Priority filter (keep `priority` in the URL parser so old links don't break, just no control); render Lead ID as `<Link className="lid">` styled like the prototype (`font-weight:600`, link colour); keep the URL tab value `unassigned` mapping to the `assignedTo=none` filter for old bookmarks.
- [ ] **Step 4: Run** the parity spec and `npx playwright test e2e/leads.spec.ts` — PASS (fix tests that clicked the removed tab to use the Assigned filter's "Unassigned").
- [ ] **Step 5: Commit** `feat(web): Leads list tabs, filters and Lead ID links as in the prototype`.

### Task 2: Follow-up tab — Owner row, Status row, close via Status

**Files:**
- Modify: `apps/web/src/pages/leads/FollowUpPanel.tsx`
- Modify: `apps/web/src/pages/leads/CloseLeadModal.tsx` (add `initialStatus?: ClosedStatus`)
- Test: `apps/web/e2e/leadPage.spec.ts` (transfer + close tests), new cases below

**Interfaces:**
- Produces: `CloseLeadModal({ lead, onClose, initialStatus }: { lead: LeadFull; onClose: () => void; initialStatus?: ClosedStatus })` — preselects the radio/select; reason still required for Lost / Not Relevant.
- `FollowUpPanel` props unchanged (`{ lead, statuses, live }`); it now owns TransferModal / UnassignModal / CloseLeadModal opening for the Owner and Status rows.

- [ ] **Step 1: Write failing e2e cases** in `leadPage.spec.ts`:
  - `transfer from the Follow-up tab`: on the lead page click button "Transfer" inside region "Follow-up and history"; the existing note-required flow then passes as today.
  - `closing as Lost from the Status select needs a reason`: select "Lost" in label "Status" → dialog "Close lead" opens with Lost chosen; saving without a reason shows the reason error; with a reason the status badge shows Lost and the next follow-up is empty.
  - `reopen a closed lead from Status`: after closing, select "Contacted" → status badge Contacted.
  - `a representative claims an unassigned lead from Owner`: as ARJUN on an unassigned lead, the Owner row shows button "Claim" and no "Transfer"; clicking it shows "Arjun Mehta" as owner.
  - `no quick date buttons`: buttons "Tomorrow", "+4 days", "Next week", "Clear" have count 0.
- [ ] **Step 2: Run** `npx playwright test e2e/leadPage.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** in `FollowUpControls`: first row Next follow-up (date input + badge only) / Priority / Type; second row **Owner** (`<span>` name or "Unassigned", then buttons: Transfer if `can('transfer_leads')`, Unassign if `can('view_all_leads') && assignedTo`, Claim if `can('claim_leads') && !assignedTo` → `action 'claim'`); third row **Status** select with every lookup status incl. Won/Lost/Not Relevant — Lost/Not Relevant open `CloseLeadModal` with `initialStatus` (select value stays the current status until saved); Won and open statuses call `action 'status'`. Clearing: emptying the date and blurring asks the existing "Clear follow-up?" confirm then saves `null`. Delete `QUICK_DAYS`, `quickLabel`, the Clear button. Emails tab: `<div className="empty">{t('No emails yet')}</div>` instead of PlaceholderCard. All controls disabled when `!live`.
- [ ] **Step 4: Run** the spec and `npm run typecheck` (root) — PASS.
- [ ] **Step 5: Commit** `feat(web): Follow-up tab owner and status rows as in the prototype`.

### Task 3: Composer — Email tab first with the prototype form

**Files:**
- Create: `apps/web/src/pages/leads/EmailForm.tsx`
- Modify: `apps/web/src/pages/leads/ComposePanel.tsx`, `apps/web/src/pages/leads/ProfileCard.tsx` (enable "Focus on email"), `apps/web/src/styles/app.css` (port `.ccbox .ccfield .cchips .cchip` from `prototype/css/app.css`)
- Test: `apps/web/e2e/parity/lead-page.spec.ts`

**Interfaces:**
- Produces: `ComposePanel` gains an imperative open: export `openEmailTab()` via a small context or a `composeRef` — use `export const ComposeContext = createContext<{ openEmail: () => void }>` in `ComposePanel.tsx`, provided by `LeadPage`. Task 4's topbar Email button and ProfileCard's Focus on email call `openEmail()`.
- `EmailForm({ lead }: { lead: LeadFull })`.

- [ ] **Step 1: Failing parity assertions:** composer tabs read `['Email','Call note','Meeting','Research note']` with Email selected; Email panel has labels To, Cc stakeholders, Project (disabled, option text "available once the lead is Won"), Template ("— blank —"), Subject (value "Intro call this week?"), Message (starts "Hi Priya," for LD with contact; "Hi Helix Dental Group," style company fallback for a prospect), checkbox "Set follow-up in" checked with select value "3 days", button "Send email"; clicking Send shows toast "Sending email arrives in release 2" and the Subject keeps its value; for a lead without contact email the To placeholder is "No email on file – add a contact".
- [ ] **Step 2: Run** `npx playwright test e2e/parity/lead-page.spec.ts` — FAIL.
- [ ] **Step 3: Implement** `EmailForm`: prototype intro text verbatim — subject `Intro call this week?`, body `Hi {first},\n\nThanks for getting in touch with DAIT Partners. I'd love to hear more about what you're working on at {company}. Would a 30-minute call this week suit you?\n\nBest regards,\n{me}` where `{first}` = contact first name or company name, `{company}` = company name, `{me}` = current user's name. Cc: chips of the lead company's contacts with email (from `useContacts({ companyId })`) and active users (from the users list hook used by TransferModal), plus typed full emails; no sending. Follow-up days options 2 days / 3 days (default) / 1 week. In `ComposePanel`, Email becomes the first `Tabs` entry and the default tab; remove the disabled placeholder button. Focus on email: folds the profile (existing fold) and calls `openEmail()` then focuses Subject.
- [ ] **Step 4: Run** spec + `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(web): Email tab with the prototype compose form (sending in release 2)`.

### Task 4: Topbar, profile card and Edit profile dialog

**Files:**
- Modify: `apps/web/src/pages/leads/LeadPage.tsx`, `apps/web/src/pages/leads/EditProfileModal.tsx`
- Create: `apps/web/src/pages/leads/LeadActionsFooter.tsx`
- Delete: `apps/web/src/pages/leads/MoreMenu.tsx`, `apps/web/src/pages/leads/StatusStepper.tsx` (and their unit tests if any) once unused
- Test: `apps/web/e2e/parity/lead-page.spec.ts`, `apps/web/e2e/leadPage.spec.ts`

**Interfaces:**
- Consumes: `ComposeContext.openEmail` (Task 3).
- Produces: `LeadActionsFooter({ lead, onEditLead, onSwitchContact, onArchive }: {...; onEditLead: () => void; onSwitchContact?: () => void; onArchive: () => void })`; `EditProfileModal({ contact, onClose, footer })` where `contact: Contact | null` and `footer?: ReactNode` (null contact = only the footer actions, title "Edit lead").

- [ ] **Step 1: Failing assertions:** topbar has no link "Leads", no text "Owner:", no buttons "More", "Claim"; button "Email" is enabled and clicking it selects the Email tab; no element `.stepper`/StatusStepper (`getByRole('group', { name: 'Lead status' })` count 0); "Edit profile" opens a dialog whose footer has "Edit lead details", "Switch contact" (lead with company), "Archive"; Archive asks to confirm and then the page shows the archived note and a "Restore" button for MAYA; on an archived lead the Status select and Owner buttons are disabled.
- [ ] **Step 2: Run** both lead specs — FAIL.
- [ ] **Step 3: Implement:** Topbar `title={lead.number}` with `sub` = created + last contact only, no `crumb`; actions: Email (`btn primary`, enabled, `onClick={openEmail}`), Edit profile (shown when `canManage && !archived`), Restore (archived, can manage). Remove Claim, MoreMenu, Owner line, StatusStepper; keep the closed banner inside ProfileCard with text "This lead is closed. Choose an open status in the Follow-up tab to reopen it." Edit profile opens `EditProfileModal` with `footer={<LeadActionsFooter …/>}` wiring LeadModal / SwitchContactModal / archive confirm (existing `archive()`).
- [ ] **Step 4: Run** specs + `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(web): lead topbar and Edit profile actions as in the prototype`.

### Task 5: Right column — No contact card, AI line, Projects, conditional cards

**Files:**
- Modify: `apps/web/src/pages/leads/SideColumn.tsx`, `apps/web/src/pages/companies/ContactModal.tsx` (add `onSaved?: (contact: ContactSummary) => void`)
- Test: `apps/web/e2e/parity/lead-page.spec.ts` (prospect case)

**Interfaces:**
- Produces: `ContactModal` prop `onSaved?: (contact: ContactSummary) => void`, called with the created/updated contact before `onClose`.

- [ ] **Step 1: Failing assertions** on a prospect without contact (create via API as the parity spec does): side column order = "No contact yet" card (button "Add contact"), company card, Projects card; company card contains "No AI research yet." and a button "Run research" whose click shows toast "Coming in release 4"; Projects card text "Projects 0" and "Projects unlock when a lead at this company is marked Won or a quotation is accepted." and is not `aria-disabled`; no "Coming up" and no "Original enquiry" headings; Add contact → fill First name/Last name → Save → the profile shows that name and the No contact card is gone. Lead without company: Add contact shows the ChooseCompany picker first.
- [ ] **Step 2: Run** spec — FAIL.
- [ ] **Step 3: Implement:** NoContactCard (`<section className="card side-card">` with `<b>No contact yet</b>`, grow, `btn sm primary` "Add contact"); opens `ContactModal companyId={lead.companyId} onSaved={(c) => action 'contact' {contactId:c.id}}`, or `ChooseCompany` when `companyId === null`. Company card AI: `<div className="note">` "No AI research yet. " + link-styled button "Run research" → toast. Projects: plain card `<h2>Projects <span className="n">0</span></h2>` + hint with `<b>Won</b>`. Coming up rendered only when `items.length > 0`; Original enquiry removed until the lead has `enquiryId` (render nothing now).
- [ ] **Step 4: Run** spec + typecheck — PASS.
- [ ] **Step 5: Commit** `feat(web): lead side column as in the prototype`.

### Task 6: Docs, full verification, screenshots

**Files:**
- Modify: `docs/RELEASE-PARITY-CHECKLIST.md` (Lead page + Leads list sections; remove superseded "Deliberate differences": Unassigned tab, Priority filter, status steps/quick buttons/Owner line, placeholder cards on the lead page), `docs/superpowers/specs/2026-11-21-prototype-parity-design.md` (one line: Leads deviations superseded by the exact-match design)

- [ ] **Step 1:** `npm test` (root) — all green; `npm run typecheck` — clean.
- [ ] **Step 2:** Capture app + prototype screenshots for LD-2041-equivalent and a prospect without contact (parity specs + Playwright on `http://127.0.0.1:8765/index.html#/leads/LD-2040`), compare section by section, fix any remaining visible gap.
- [ ] **Step 3: Commit** `docs: Leads exact-match checklist`.
