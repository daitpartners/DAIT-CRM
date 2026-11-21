# DAIT Partners CRM — Development plan

Prepared 20 Nov 2026. Read with `docs/DAIT-CRM-Specification-v2.md`, `docs/data-model.md` and the prototype (`dait-crm.html`).

> **Update 21 Nov 2026.** The approved design is `prototype/index.html` (the double-click `dait-crm.html` is built from
> it); every screen must match it. The project became a fresh build (see
> `docs/superpowers/specs/2026-11-21-dait-crm-fresh-build-design.md`), so the "Starting point" row below and Phase 0's
> study of an existing CRM no longer apply. Screen-by-screen status: `docs/RELEASE-PARITY-CHECKLIST.md`.

## 1. What this plan assumes

| Point | Value | Source |
|---|---|---|
| Domain | `https://crm.daitpartners.com` | Specification |
| Server | AlmaLinux 9, CyberPanel, OpenLiteSpeed in front of Node.js | Specification |
| Server size | Medium, 8–16 GB RAM, no GPU | Your answer |
| Starting point | A live Node.js CRM with real data; source code and database access are available | Your answer |
| Who builds | Claude Code, with you reviewing and approving each phase | Your answer |
| Release order | Leads and Companies first, then Email and Mailer, then Quotations, Projects and Calendar, then AI research | Your answer |
| Scope | The prototype as it stands today, including the redesigned Leads and the Mailer | Prototype |

**What is not known yet.** Nobody on this project has read the existing CRM's code. Its framework, database engine, login system and table names are unknown. Phase 0 exists to find out, and the estimates in section 6 can move once it is done.

## 2. Ground rules

1. **The live CRM keeps working throughout.** No change reaches production without first running on a staging copy.
2. **Existing data is never recreated or dropped.** Every database change is a migration that adds to what is there, with a tested way back.
3. **Backup before every production change.** A full database dump and a copy of the code, taken and verified the same day.
4. **Each phase ends with something you can check**, and waits for your approval before the next one starts.
5. **Business rules live on the server.** The prototype's `js/store.js` is the reference for each rule; the server copy gets an automated test.
6. **Follow the existing CRM's conventions** for framework, database access and naming. Do not introduce a second way of doing the same thing.

## 3. Environments on the server

| Environment | Address | Purpose |
|---|---|---|
| Production | `crm.daitpartners.com` | The live CRM. Changed only at a release. |
| Staging | `staging-crm.daitpartners.com` (new) | A copy of production code and data for building and testing. |

Setting up staging (Phase 0):

- **DNS:** add an A record for `staging-crm` pointing at the same server.
- **CyberPanel:** create the website, issue a Let's Encrypt certificate, and restrict access by password or IP so it is not public.
- **OpenLiteSpeed:** proxy the staging site to a second Node.js process on its own port, the same way production is proxied.
- **Database:** a separate staging database, loaded from a production dump. Replace real email addresses in staging with test addresses, so no test can email a real contact.
- **Processes:** web and worker as separate services (PM2 or systemd, whichever production already uses), each with its own environment file.
- **Secrets:** environment files outside the web root, readable only by the service user. This includes the key that encrypts mailbox tokens.
- **Memory check:** two environments plus a worker fit in 8–16 GB. Confirm actual free memory in Phase 0 before relying on it.

## 4. Phases

### Phase 0 — Inspect and prepare (no changes to production)

- Read the existing code: framework, database engine and access layer, login and roles, existing Lead, Company, Contact and Task features, API routes, UI components.
- Read the server setup: OpenLiteSpeed virtual host, how Node.js is started, logs, existing backups, firewall, SELinux state.
- Put the existing code in Git if it is not already, with production as the main branch.
- Set up nightly database backups with an off-server copy, and test one restore.
- Build staging as in section 3.
- **You receive:** a short findings report (what exists, what can be reused, what conflicts with the specification) and a gap list between the existing tables and `docs/data-model.md`.
- **You decide:** the lead and company ID scheme (keep the existing one). The five Phase 1 decisions in section 8 are pending and are not needed for this phase.

### Phase 1 — Release 1: Leads and Companies

- **Database:** migrations for leads, companies, contacts, locations, activities, assignments, tasks, enquiries and the person-profile fields (headline, experience, skills, languages), mapped onto existing tables where they already exist.
- **Leads list:** tiles, tabs, filters, sorting and paging done by the database. The list must stay fast at 100,000+ leads; this needs indexes on status, owner, type, country and created date, and a proper search index.
- **Lead page:** the collapsible profile box, the Follow-up tab, tasks, status changes, Edit profile.
- **Create lead and CSV import**, with duplicate detection.
- **Companies:** list, profile tabs, contacts, locations.
- **Website contact form:** the one public endpoint, with rate limiting and spam protection.
- **Allocation rules, notifications, follow-up tasks.**
- **Preferences:** language, date format and time zone per user.
- **Fixes carried over from the prototype review** (see section 7).
- **You check on staging:** the test scenarios in the specification, section 16, plus a load test with 100,000 sample leads.
- **Release:** backup, migrate, deploy in a quiet hour, smoke test, with a rollback step ready.

### Phase 2 — Release 2: Email and Mailer

Needs one thing from you before it starts: the Microsoft Entra app registration, done by a Microsoft 365 Global Administrator (about 10 minutes; steps are in the specification, section 7).

- **Mailbox connection:** Microsoft 365 sign-in and consent, tokens stored encrypted, redirect addresses registered for both production and staging.
- **Mail sync:** inbox and sent items matched to leads; the worker process runs it.
- **Email box on the lead page:** templates (including uploaded Outlook `.oft` files), Cc pick-list, project link, follow-up after sending.
- **Mailer:** select leads, the four-step wizard, queue tables, the worker sending one by one through Microsoft Graph, pause, resume and cancel, the audit record, do-not-email and unsubscribe handling.
- **Before the first real campaign:** check SPF, DKIM and DMARC for `daitpartners.com`, and agree a daily sending limit per mailbox.
- **You check on staging:** a campaign to test addresses only, a reply matched back to its lead, a skipped opt-out.

### Phase 3 — Release 3: Quotations, Projects, Calendar

- Quotation editor with revisions, send, accept and convert to project.
- Projects with stakeholders, and project emails.
- Calendar through Microsoft Graph, using the connection from Phase 2.
- Reports additions.

### Phase 4 — Release 4: AI research

- The enrichment worker and the provider interface from the specification.
- **Start with the Claude API.** On an 8–16 GB server with no GPU, a self-hosted model would be slow and would compete with the CRM for memory. Keep Ollama as a later option on a separate machine.
- Suggestions that never overwrite verified fields; accept, reject and source records.
- A monthly spending cap and a per-day limit on enrichment runs.

### Phase 5 — Handover

- Deployment notes for this server, the list of migrations, environment variables, log locations, backup and restore steps.
- Updated specification and data model, so they match what was built.

## 5. How each phase runs with Claude Code

1. **Plan:** Claude Code reads the relevant code and writes a short plan for the phase. You approve it.
2. **Build on staging,** in small pieces, each with automated tests for its rules.
3. **Review:** you walk through the result on staging against the prototype screen by screen.
4. **Release:** only after your sign-off, following the release steps in Phase 1.

Claude Code should work on a branch in the repository, never directly on production files. Give it access to staging; keep production deploys as a step you trigger.

## 6. Rough effort

These are estimates, made before anyone has seen the existing code. Treat them as ranges to be corrected after Phase 0.

| Phase | Working time | Depends on |
|---|---|---|
| 0 — Inspect and prepare | 3–5 days | Access to the server and code on day one |
| 1 — Leads and Companies | 3–5 weeks | How much of the existing Lead and Company code can be reused |
| 2 — Email and Mailer | 3–4 weeks | Entra registration done before the phase starts |
| 3 — Quotations, Projects, Calendar | 2–3 weeks | |
| 4 — AI research | 1–2 weeks | Claude API key and budget |
| 5 — Handover | 2–3 days | |

Your review time is on top of this. Reviews that happen within a day or two keep the ranges at the low end.

## 7. Fixes from the prototype review to build in

- **Website form matching:** do not attach an anonymous enquiry to an existing client because of a typed website address, and do not link it to an existing contact at a different company because of a matching phone number. Match on the business email domain; send the rest to manual review.
- **Quotation status:** rejecting one quotation must not turn a Won lead into Lost. Accepted, Rejected and Expired quotations cannot change status.
- **One source of truth:** two people or two browser tabs must never overwrite each other's changes. The database handles this in the real build; it needs a test.
- **Escaping:** every value shown on screen is escaped, including values that come from AI research.

## 8. Decisions needed from you

**Before Phase 1 — PENDING (put on hold by DAIT Partners, 20 Nov 2026)**

These five are not decided yet. DAIT Partners will come back with final answers; the parts of Phase 1 that depend on them wait until then.

| # | Decision | Status | What waits on it |
|---|---|---|---|
| 1 | **Removed lead-page features:** which of these the real CRM should have, and where: clone lead, edit lead details, archive, reassigning the owner, a reason when closing a lead, switching the contact, the full activity history | Pending | The final lead page layout and its actions |
| 2 | **Enquiries screen:** whether staff need a screen to review website enquiries, since it is off the menu in the prototype | Pending | The enquiry review screen and the manual-review queue |
| 3 | **Allocation rules:** which countries or sources go to which salesperson | Pending | Automatic assignment of new leads |
| 4 | **Roles:** who may see all leads and who sees only their own | Pending | Permissions on the Leads list and lead page |
| 5 | **Real dropdown values:** actual lead sources, statuses, industries and segments. The prototype's lists are samples | Pending | The lookup data loaded at release, and the filters that use it |

Not blocked by these: Phase 0 (inspect, backups, staging), and in Phase 1 the database migrations, the Leads list with paging and search, Companies, the website form endpoint and Preferences. Release 1 itself cannot go live until all five are final.

**Before Phase 2**

- **Who may use the Mailer,** and the daily limit per mailbox.
- **Lawful basis wording and the unsubscribe line,** reviewed by whoever handles data protection for DAIT Partners.
- **Working hours:** office time only, or the recipient's own time zone as well.

**Before Phase 3**

- **Tax rate and currencies** for quotations. The prototype values are placeholders.

**Before Phase 4**

- **Monthly budget for AI research,** and which sources it may use.

## 9. Main risks

| Risk | What reduces it |
|---|---|
| The existing CRM's structure does not fit the specification | Phase 0 findings report before any build; adapt the data model to the existing tables, not the other way round |
| A migration damages live data | Staging rehearsal with a fresh production copy, backup before release, tested rollback |
| Bulk email harms the domain's reputation | Per-mailbox daily limit, spacing, opt-out handling, SPF/DKIM/DMARC check; move large volumes to a dedicated sending service |
| The server runs short of memory | Measure in Phase 0; keep AI research off this machine |
| Lead list slows down as data grows | Database paging and indexes from the start; load test at 100,000 leads in Phase 1 |
