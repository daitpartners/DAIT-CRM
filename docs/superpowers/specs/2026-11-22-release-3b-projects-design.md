# Release 3B — Projects (design)

Owner, 22 Nov 2026: "go and start" 3B; project value = **net before GST** (option 1); "go with your plan" on the calls
below. Standing rules: screens match `prototype/index.html` (`views-projects.js` V.projectModal / V.projectsCard /
V.projects / V.compose, the company profile's Projects tab in `views-companies.js`, the lead page's Projects card and
email form Project picker in `views-lead-detail.js`, the Email page Project filter in `views-work.js`, project rules in
`store.js` createProject / updateProject / projectsFor / primaryStakeholders / convertQuote), checked by side-by-side
screenshots before "done"; build only what the prototype shows; mail is private to its owner, administrators included.
Data shape: `docs/data-model.md` `projects` / `project_stakeholders`.

## Intent

Once a client says yes, the team records the engagement as a project: which client, which lead and quotation it came
from, who manages it, what it is worth and which client people must be copied on every project email. One client can
have many projects, each from its own lead.

## Goals / non-goals / anti-goals

- Goals: Projects list (tiles, filters, table, Create project, Email a project); Create / Edit project dialog with
  stakeholder ticks; Convert to project on an accepted quotation; Projects card on the lead page and company Overview;
  company profile Projects tab; Project picker in Compose and on the lead page's email form (stakeholders pre-filled in
  Cc, email tagged with the project); Email page Project filter; sidebar Projects entry; timeline entries and
  notifications as the prototype.
- Non-goals: a project detail page (the prototype has none — the list, dialog and cards are the whole UI); tasks,
  milestones, time or invoices on projects; deleting projects (Cancelled is the end state); changing a project's client;
  reports or dashboard changes; automatic project creation when a lead is Won.
- Anti-goals: someone seeing a project on a lead they cannot see; anyone else seeing an email because it carries a
  project tag (the Project filter only narrows the viewer's own mail); a quotation converted twice; a project value
  including GST when it came from a quotation.

## Approaches

1. **Chosen:** two new tables as in the data model — `projects` and `project_stakeholders` — plus an optional
   `project_id` on email messages and the real relation for the existing `quotations.project_id`.
2. Projects as extra fields on the lead — rejected: one client has many projects, and a quotation converts into its own
   project; a lead holds one.

## Decided

**Data.** `projects`: number `PRJ-<n>` (unique, sequential, as the prototype's `PRJ-1`), company (required), lead
(nullable), quotation (nullable, unique — one project per quotation), name (required), status
`Active | On hold | Completed | Cancelled` (default Active), start date (default today, owner's time zone), value
(decimal, nullable), currency `USD | CAD | INR`, project manager (user, required, default the creator), description,
created by, created/updated at, completed at (set when status becomes Completed, cleared if it moves away).
`project_stakeholders`: project, contact (unique pair) — the prototype has only "Primary stakeholders", so every row is
a primary stakeholder (no role / is_primary columns). `email_messages.project_id` nullable.

**Value.** Typed freely in the dialog. Converting a quotation uses its accepted (last sent) revision's net amount —
after line and overall discounts, **before GST** (owner, option 1) — and its currency.

**Create / Edit dialog (prototype V.projectModal, field for field).** Client* (searchable; only companies with the
Client flag, labelled "· client"; locked when editing), From lead (the client's leads, "— none —"), Project name*
(prefilled "<company> · "), Status, Start date, Value, Currency (default: preset → the client's country rule India →
INR, Canada → CAD, else USD), Project manager (active users, default me), Linked quotation (the client's quotations,
"— none —"; a quotation already linked to another project is not offered), Primary stakeholders (checkbox per client
contact "name · designation or type · email or 'no email'", hint "(copied on every project email)"; pre-ticked on create:
the lead's contact plus contacts that are the company's primary or of type Decision Maker), Description. Validation
toasts as prototype ("Choose a client first", "Project name is required"). Save toast "PRJ-n created · k
stakeholders" / "Project updated". Choosing a quotation in the dialog links it (sets the quotation's project).

**Convert to project (quotation editor, prototype convertQuote).** Enabled only on an Accepted quotation with no
project, for users who may edit it. Creates the project with client, lead, quotation, name = subject, value = net
before GST, currency, manager = the quotation's owner, stakeholders defaulted as above, start today. Quotation history
"Converted to project PRJ-n"; lead timeline "Converted to project PRJ-n" ("From accepted quotation Q-…"). Toast
"Project PRJ-n created from Q-…". Afterwards the editor shows the linked project instead of the button. A second
attempt returns the existing project (no duplicate).

**On create (any route, prototype createProject).** Company gets the Client flag (already true from the dialog's
list). With a lead: timeline "Project created · PRJ-n <name>" with "Stakeholders: …". Notification to the project
manager "Project created · <name>" ("<company> · from LD-…", link to /projects) — not sent when the manager is the
person creating it.

**Who sees / may change (owner: "go with your plan").** See: users who can see its lead (archived leads included);
without a lead, its company — the same rule as quotations. Create, edit, convert: users with `manage_quotes` who are
the lead's assignee, the project manager, or have `view_all_leads` (Administrators, Managers); without a lead, any
`manage_quotes` user who can see the company may create, and the manager or `view_all_leads` may edit. Optimistic
concurrency (409 stale) as elsewhere.

**Projects list (prototype V.projects).** Top bar "Projects · Engagements won from leads. One client can have many
projects, each from its own lead." with "Email a project" (opens Compose with the client filter's company) and "Create
project". Tiles over the projects the user can see: Active projects (count; sub "n clients" = client companies the user
can see), Total value (summed per currency, "USD 12,000 · INR 4,50,000", sub "across all projects"), Completed (sub
"this year" — completed at in the current year), On hold. Filters: Client (searchable, clients), Status, "✕ Clear",
"n projects"; kept in the URL (`/projects?company=…&status=…`). Table columns: Project (name, PRJ-n below), Client
(→ company Projects tab), From lead (→ lead), Status badge (Active green, Completed grey, others amber), Start, Value
(".00" dropped as prototype), Project manager, Primary stakeholders (names), Quotation (→ editor), Email + Edit buttons.
Newest first. Empty text as prototype.

**Company profile.** New tab "Projects (n)" between "Leads & Prospects" and "Activities": table (Project with PRJ-n ·
Q-…, From lead, Status, Start, Value, Project manager, Primary stakeholders, Email / Edit), "+ Create project" when a
client, and the side card "How projects work" (prototype text). Overview side column: the real Projects card replaces
the placeholder. Leads tab "Projects" figure becomes the real count.

**Lead page.** Side column Projects card (prototype V.projectsCard): count, "+ Create project" when the company is a
client (dialog preset with this lead), rows linking to `/projects?company=…`, projects from this lead highlighted; the
unlock hint when not a client. Email form Project picker enabled when the company is a client ("— no project —" /
"no projects yet" / "available once the lead is Won"), default the project from this lead; choosing one tags the email.

**Email.** Compose: Client → Lead → Project, as the prototype; choosing a project fills its lead if empty and sets Cc to
the project's stakeholders with an email (excluding To); without a project, Cc keeps today's behaviour. The sent email
carries `project_id`; `/email?compose=1&company=…&lead=…&project=…` opens Compose preset (list and tab Email buttons).
Email page "Project" filter: projects the user can see (narrowed by the chosen client); choosing one sets the client and
filters the user's **own** mail to that project.

**Sidebar.** "Projects" after Quotations, badge = number of projects the user can see (prototype shows the total).

**Languages.** All new text in en / es / fr (prototype i18n strings where they exist).

**Mark Won and create project (prototype Won dialog).** The lead page's Won confirmation gains the prototype's third
button "Mark Won and create project": it marks the lead Won exactly as "Mark Won" does, then opens the Create project
dialog preset with this client and lead. The dialog text says the project is created as a separate step (prototype).

## Builder's calls (from the builder check, marked as such)

- *The project manager always sees their projects*, whatever the lead visibility, on the list, tiles, badge, cards,
  Email filter and when editing (visibility = lead/company rule **or** manager = me). Picking a manager does not widen
  anything else on the lead.
- *Linked quotation:* the dialog offers only the client's **Accepted** quotations that have no project (plus the one
  already linked). Linking sets the quotation's project and writes quotation history "Linked to project PRJ-n";
  choosing a different one or "— none —" on edit clears the old quotation's link (history "Unlinked from project PRJ-n"),
  so its Convert button returns. Linking only points; it does not change the value or currency typed in the dialog. One
  project per quotation is enforced by a unique key and the change runs in one transaction.
- *Lead page email form:* choosing a project adds that project's stakeholders (with an email, not the To address) to the
  Cc ticks and removes the previous project's stakeholders; ticks the user added by hand stay. On first load the
  default project's stakeholders are pre-ticked.
- *Editing:* every field except Client may change, in any status (Completed and Cancelled included), by the people who
  may edit. "From lead" offers only the client's leads the editor can see; the server re-checks that. Changing the lead
  writes no new timeline entries.

## Left to the builder

API shapes, file layout, number sequence locking (as quotations), which emails count as "the project's" beyond the ones
sent with the tag, tests. Before calling it done: the screenshot parity check (list, dialog create/edit, company
Projects tab and Overview card, lead card, quotation convert, Compose with a project, Email filter, sidebar) against the
prototype, differences fixed or listed for the owner.
