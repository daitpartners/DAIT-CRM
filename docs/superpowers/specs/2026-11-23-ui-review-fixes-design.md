# UI review fixes + collapsible panels (design)

Owner, 23 Nov 2026: asked for a UI/UX review ("there are things which need to [be] highlighted and fix"); the review
(`~/Documents/DAIT-CRM/ui-review-2026-11-23/report.md`, screenshots `NN-app.png` / `NN-proto.png` in the same folder)
found 39 findings (#01–#33, some with several parts). Owner then: "side panel should have collapsible button" and "same
with email section", and "Go" to: fix all review findings, matching the prototype wherever it shows the answer, plus the
two collapsible panels as proposed. Standing rules: screens match `prototype/` (build only what it shows, except the two
owner additions below); check by side-by-side screenshots before "done"; mail is private to its owner; en/es/fr for all
UI text; deploy only on the owner's "deploy".

## Goals
1. Fix every finding in the review report. Where the prototype shows the answer, match it. Where the prototype has the
   same weakness (#02 Leads/Projects overflow, #08 fixed Unassigned sentence, #23 squeezed editor, #25 project count,
   #29 Reports subtitle), fix it sensibly in the prototype's visual language.
2. Collapsible main sidebar (owner addition).
3. Collapsible Email folders column (owner addition).

## Non-goals / anti-goals
- No change to the "deliberate differences" listed at the end of the report, or to items under "Owner decisions" in
  docs/PENDING.md.
- No change to visibility/privacy rules. No new server features beyond what a finding needs.
- Not making the app a phone app: phone width only gets #32 fixed.

## Decided
- **Collapsible sidebar.** A « button at the top of the sidebar collapses it to an icon rail (about 64 px): icons only,
  name as a tooltip (and `aria-label`), count badges become a small dot on the icon, the user block shows the avatar
  only, Sign out stays reachable. » expands it. The choice is remembered per browser in localStorage (wrapped in
  try/catch; default expanded). Keyboard accessible (a real button with `aria-expanded`). Each nav item needs an icon
  (use the prototype's sidebar icons; add simple ones in the same style where the prototype has none).
- **Collapsible Email folders column.** A « button in the folders/templates column header folds it to a thin strip with
  » to reopen; the list and reader take the space. Remembered per browser (localStorage, try/catch). Collapsing must
  not lose the selected folder or filters.
- **#19 Create meeting from an email**: enabled when the mail is linked to a lead the user may log activity on; opens
  the existing meeting/task creation flow (Calendar is live — reuse it) preset with the lead, the email subject as title.
  Remove the "release 3" tooltip.
- **#04 English system text**: titles and notification texts the server stores must show in the viewer's language.
  Preferred approach: store a key + params (or recognise the known stored patterns) and translate at display time;
  existing rows must display translated too (map known English patterns at display time if they cannot be migrated).
  AI history trigger/engine labels likewise.
- **#11, #26, #15, #29**: replace release-number/planning wording with plain current wording (meetings never send
  invitations — owner decision; AI footnote describes the Website reader plus Claude Code when switched on, no table
  names).
- **#27 Won via accepted quotation**: show the same warning the Close-lead dialog shows before planned meetings/tasks
  are auto-completed (on the accept action), or don't complete future-dated meetings — pick what the Close-lead flow
  does and make acceptance consistent with it.
- **#28 Notifications**: proper type label and icon for quotation, AI research and email notifications; 24-hour times
  like the rest of the CRM.
- **#02 Wide tables**: no hidden columns without a cue — visible horizontal scroll with a fade/shadow cue, sticky first
  column where the prototype layout allows, and/or tighter column widths; Quotations Owner column must not clip.
- Everything else: as the report's "Prototype" line says.

## Left to the builder
Exact icons, CSS, component structure, test approach (unit tests for logic like #04 translation and #27; e2e/parity
specs for the panels and key screens). Before "done": before/after screenshots for every finding against the
prototype into `~/Documents/DAIT-CRM/parity-screenshots-ui-review-fixes/`, including both panels collapsed/expanded at
1400 and 1280 widths and in es/fr.

## Note (after the minor-fixes batch)
This release builds on branch `minor-fixes` (21 commits, under review in parallel). That batch already fixed review
finding #19 (Email reader "Create meeting" now opens the calendar's New follow-up for the lead — commit 6e80739) and the
"already known" items (company Leads tab lead number link, Shift+Tab leaving dialogs, quotation history translated,
"Coming up" lists quotations, Compose contact line greyed). Check those against the report and do not redo them.
