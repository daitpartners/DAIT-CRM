# DAIT Partners CRM — Final deliverable (20 Nov 2026)

Prepared for DAIT Partners. This package closes the design-and-prototype phase and is the hand-over to development
(the Node.js build on crm.daitpartners.com, AlmaLinux 9 / CyberPanel / OpenLiteSpeed).

## 1. What is in the package

| Item | Where | What it is for |
|---|---|---|
| **Working prototype (single file)** | `dait-crm.html` | Double-click to open. Whole CRM with sample data; no server, no install. |
| **Public Contact Us form (single file)** | `contact-form.html` | The six-field website form. Keep beside `dait-crm.html`; submissions appear under Enquiries. |
| **Prototype source** | `index.html`, `css/`, `js/`, `assets/`, `public/` | Same app as separate files; the base for any further change. `README.md` maps the files. |
| **Build script** | `build.py` | Regenerates the two single files from the source: `python3 build.py`. |
| **Development specification v2** | `docs/DAIT-CRM-Specification-v2.md` | Instructions for Claude Code / the dev team: modules, rules, hosting, integrations, phases, tests. |
| **Data model** | `docs/data-model.md` | Every table and column, keys, indexes, relationships. |
| **UX test report** | `docs/ux-test-report.md` | Independent test pass: verdict, defects fixed, open items by severity, suggested order. |
| **Screenshots** | `screenshots/` | 15 PNGs of the main screens for decks and reviews. |
| **Sample Outlook template** | `docs/sample-template.oft` | For trying Settings → Email templates → Upload .oft. |
| **Logo files** | `assets/logo-full.png`, `assets/logo-mark.png` | Converted from the supplied Illustrator file. |

Online (private until shared from each page's Share menu):
- Design canvas, 21 screens + data model diagram: https://claude.ai/artifact/8ucEcSweEVAaUaGvRBuTuL
- Live prototype: https://claude.ai/artifact/2M4qnw56VDoCiwFXzjATNJ

## 2. Scope delivered

**Modules** — Dashboard · Leads (list, create lead/prospect, action-first lead page) · Companies (list, 8-tab profile incl.
AI Intelligence and Research Sources) · Enquiries (immutable website submissions, manual review) · Email (Microsoft 365
connection, Client → Lead → Project composer, stakeholders in Cc, templates incl. .oft) · Calendar · Quotations (editor with
revisions, send, accept, convert) · Projects (many per client, each from its own lead) · Tasks · Reports · Settings.

**Rules enforced in the mock data layer (`js/store.js`), to be mirrored server-side**
- Company duplicate check: domain → legal name → normalised name + country → manual review. Contact: email → phone → name + company. Never auto-merged.
- Website enquiry: validate → store immutable record → match/create company → match/create contact → create lead (always new) → allocate → notify → follow-up task. Ambiguous matches wait in "Needs review".
- Lead transfer requires a note, writes history, moves open tasks, notifies the receiver. Follow-up date ↔ task kept in sync.
- AI enrichment proposes values only for unverified fields; accepting marks a field AI-sourced; verified fields are locked; unknowns stay NULL.
- Quotation send freezes a revision; edits after sending open a new one; Accepted → lead Won + company Client; Convert → project.
- Project stakeholders are pre-filled in Cc on every project email; emails are filed on company, lead and project.

**Platform decisions recorded in the spec** — brand theme and Montserrat; searchable dropdowns for every list of 8+ options;
Microsoft Graph for mail and calendar (Business Basic is sufficient); OAuth tokens encrypted server-side; English / Spanish /
French per user with JSON resource files; Outlook .oft templates parsed server-side; separate Node worker for enrichment with a
pluggable engine (Ollama self-hosted or Claude API).

## 3. Status and known limitations

- The prototype stores data in the browser only; nothing is sent anywhere. Settings → Reset sample data restores the demo.
- Microsoft sign-in and consent screens are simulated; the real flow needs the one-time Entra app registration described in Settings and spec §7.
- Translation in the prototype is phrase-based, so some dynamic text stays English; the real build keys every string.
- Open UX items from the test report (phone layout, confirmations on delete, column sorting, inline validation, Settings split, focus styles) are listed with a suggested order in `docs/ux-test-report.md`.
- Sample names, companies and figures are fictional.
- The single files load the Montserrat font from Google Fonts; offline they use a system font.
- Pre-hand-over fixes (20 Nov): Won from every screen now applies the same rule and the Won dialog no longer promises an automatic
  project; closed leads no longer leave open or overdue tasks; old browser data no longer crashes the app; unsafe link schemes
  are blocked; quotation inputs are validated, sending needs a contact email and conversion happens once; suggestion decisions
  are applied once; IDs no longer collide; delete/archive ask for confirmation; keyboard focus is visible. The rules are added
  to the specification so the real build matches.

## 4. Recommended next steps

1. Share the canvas and prototype with the sales team for a guided walk-through; collect comments on the canvas.
2. Hand `docs/DAIT-CRM-Specification-v2.md` and `docs/data-model.md` to development; Phase 1 is inspecting the existing CRM and database before any migration.
3. Complete the Microsoft Entra app registration (Global Administrator, ~10 minutes) so mailbox connection can be tested on day one.
4. Decide the ID strategy (keep the existing CRM's) and confirm the allocation rules, tax rate and currencies, which are placeholders here.
