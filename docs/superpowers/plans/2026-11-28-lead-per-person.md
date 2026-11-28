# One lead per person Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Every person at a company is their own lead, with their own Lead ID.
- A one-time split gives the 70 people without a lead their own lead and moves their history to it.
- A Won lead makes its person a customer.
- The Leads table and Contacts views show the owner's columns and filters.

**Architecture:**
- A new module `apps/api/src/leads/person.ts` owns "a lead for this person": the company's main lead, a new lead made from it, and marking a customer.
- Contact creation, Switch contact, Move contact, import updates, mail matching and the one-time `lead-split` CLI all go through that module.
- Migration 29 adds `contacts.customer_since` and a partial unique index so that two leads never share a person.

**Tech Stack:** TypeScript, Fastify 5, Prisma 6 on Postgres, React 18 with TanStack Query 5, vitest (apps/api/test on a real test database; apps/web unit tests), Playwright parity specs. npm workspaces, with packages/shared (zod; rebuild after changes).

**Spec:** `docs/superpowers/specs/2026-11-28-lead-per-person-design.md` (owner approved, 28 Nov 2026)

## Global Constraints

- **Branch:** `lead-per-person`, from `lead-mail-timeline`. It reuses `personInEmail` (apps/api/src/mail/leadPanel.ts) and `teamSenders` (apps/api/src/mail/leadTimeline.ts) from that branch.
- **Migration 29 adds only:**
  - `contacts.customer_since TIMESTAMP(3) NULL`, following the schema's existing DateTime mapping;
  - `CREATE UNIQUE INDEX leads_contact_id_unique ON leads(contact_id) WHERE contact_id IS NOT NULL`. Live has 0 shared contacts.
  - Write it with `prisma migrate diff` against a scratch database. Never `migrate dev`: it would drop `enrichment_settings.claude_monthly_cap_usd`.
- **"The company's main lead"** is that company's lead with the lowest id among open ones (not Won/Lost/Not Relevant, not archived), else the lowest id overall.
- **A lead made for a person copies from the main lead:**
  - Copied: `companyId`, `companyName`, `country`, `city`, `website`, `leadSource`, `outreachLanguage`, `leadType`, `priority`, `importBatch`, and `assignedToId` (the owner).
  - Set fresh: `contactId` = the person, `businessEmail` = the person's business email, `status` = New (or Contacted where the split rule says so), no next follow-up.
  - `createdById`: the acting user (Add contact, import), or the main lead's creator for the split.
- **Customer:** a lead's status becoming `Won` sets its person's `customer_since` (only if null). Leaving Won never clears it.
- **Leads table column order, exactly:** Lead ID · Lead Name · Company Name · Language · Type · Source · Status · Country · Priority · Assigned to · Next follow-up · Created by.
  - "Lead Name" is the person's name, or "No contact yet".
  - "Created by" is the creator's name, or "—".
  - Both are sortable.
- **Copy:** UI labels come from the existing i18n (en/es/fr) with new keys for "Lead Name", "Company Name", "Created by", "Customers", "All people", "Customer" and "Split from {number}".
  - Live app styles only (existing classes and badges).
  - Every changed screen is checked with side-by-side screenshots against the live app's current look before it is called done.
- **Privacy and logs:** logs and CLI output carry ids and counts only. Mail privacy rules are unchanged.
- **No new npm dependencies, no Graph calls.** The API stays one process.
- **Commit trailers:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01GKS9Jmtrg6EmfFh6J9p9ci`. Never commit `Reference/` or unrelated package-lock drift.
- **Tests:** `cd apps/api && PATH=/opt/homebrew/opt/node@24/bin:$PATH TZ=Europe/London npx vitest run <file>`. The full suite is `PATH=/opt/homebrew/opt/node@24/bin:$PATH TZ=Europe/London npm test` at the repo root. Known flakes are listed in docs/PENDING.md.

## Review Focus

1. **Adding a person whose email already belongs to a lead at that company.** No second lead; that lead becomes the person's. (Task 2)
2. **A conversation where Elaine and Amanda (both with leads) are both on the email.** Each message goes to the lead of its person by the panel rule: sender first, then To, then Cc. (Tasks 3 and 4)
3. **Running the split twice, or after someone already added a lead by hand for one of the 70.** It creates 0 and moves nothing twice. (Task 4)
4. **A company whose only lead is closed or archived.** The new person's lead still copies from it but starts New, and the closed lead is untouched. (Tasks 1 and 4)
5. **Moving a person whose lead is Won.** The person moves; the Won lead keeps its company and its person link, and a timeline note says so. (Task 2)

---

### Task 1: Migration 29, `person.ts`, and Won makes a customer

**Files:**
- Create: `prisma/migrations/20261228100000_lead_per_person/migration.sql`
- Modify: `prisma/schema.prisma`
- Create: `apps/api/src/leads/person.ts`
- Modify: `apps/api/src/leads/service.ts` (`applyStatusChange`)
- Test: `apps/api/test/leadPerson.test.ts`

**Interfaces:**
- Produces:
  - `mainLeadOf(tx: Tx, companyId: number): Promise<Lead | null>`
  - `createLeadForPerson(tx: Tx, contact: Contact, opts: { createdById: number | null; status?: 'New' | 'Contacted'; createdAt?: Date }): Promise<Lead>`
    - Writes the lead (copying from `mainLeadOf` per Global Constraints).
    - Writes an assignment row (by null, note from the caller, default none) and the `created` timeline line.
    - With no main lead, it creates the lead from the contact and company alone: country from the company, source `'Other'`, owner none.
  - `leadOfPerson(tx: Tx, contactId: number): Promise<Lead | null>`
  - `markCustomer(tx: Tx, lead: Pick<Lead, 'id' | 'contactId' | 'companyId' | 'businessEmail'>): Promise<void>`

- [ ] **Step 1: Write the failing tests:**
  - `creates a lead for a person copying the company's main lead and its owner`: a KPMG-like company whose main lead is owned by Carlos, Not Contacted, type Prospect, language en. The new lead has the person, Carlos, status New, the copied fields, and the person's business email.
  - `the main lead is the lowest open lead, else the lowest id`.
  - `a company with no lead gets a lead from the company alone`.
  - `the database refuses a second lead for the same person`: expect a unique violation.
  - `setting a lead Won marks its person a customer; reopening keeps it`.
  - `a Won lead without a person but with a name or email creates its contact as a customer; a company-only lead makes none`.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement the migration, the schema change, `person.ts`, and the Won hook in `applyStatusChange`.** The hook runs only on a transition into Won, inside the same transaction. Rebuild packages/shared if touched.
- [ ] **Step 4: Run** `npx vitest run test/leadPerson.test.ts`, then the lead status tests. Expect PASS.
- [ ] **Step 5: Commit** `feat(leads): one lead per person in the schema; Won makes its person a customer`.

### Task 2: Keep one lead per person when people are added, switched or moved

**Files:**
- Modify: `apps/api/src/routes/contacts.ts` (POST `/contacts`, POST `/contacts/:id/move`)
- Modify: `apps/api/src/routes/leads.ts` (POST `/leads/:id/contact`)
- Modify: `apps/api/src/imports/updates.ts` (where it links or creates the lead's contact)
- Modify: the Switch contact picker in `apps/web/src/pages/leads/SwitchContactModal.tsx`
- Test: `apps/api/test/contacts.test.ts`, `apps/api/test/leads*.test.ts`, `apps/api/test/import*.test.ts` (whichever cover these routes)

**Interfaces:**
- Consumes: Task 1's `createLeadForPerson`, `leadOfPerson`.
- Produces: the contact create response gains `leadId: number`.

- [ ] **Step 1: Write the failing tests:**
  - `adding a contact creates their lead, owned by the company lead's owner, created by the user`. This covers every caller of POST `/contacts`, including the email panel's Add contact.
  - `adding a contact whose email is a lead's business email at that company links that lead instead of making a second`. That lead gets `contactId`; no new lead.
  - `Switch contact refuses a person who already has a lead`: 422 on the `contactId` path. The picker lists only people without a lead (or the current one).
  - `moving a person moves their open lead with them`: company and company name change, with a timeline note "Moved with {name} to {company}".
  - `moving a person whose lead is Won keeps the lead where it was`: the lead keeps its company and person link, with a timeline note.
  - `an import update linking a person who already has a lead is reported for that row and links nothing`.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement** in each route's existing transaction, keeping the lock order the routes document (leads, then contact).
- [ ] **Step 4: Run** the touched test files. Expect PASS.
- [ ] **Step 5: Commit** `feat(contacts): adding, switching and moving a person keeps one lead per person`.

### Task 3: Mail goes to the lead of the person in it

**Files:**
- Modify: `apps/api/src/mail/match.ts` (`matchMail`)
- Test: `apps/api/test/mailMatch*.test.ts` (or the file covering `matchMail`)

**Interfaces:**
- Consumes: the person rule. Reuse it by extracting from `personInEmail` (apps/api/src/mail/leadPanel.ts) a pure helper, `personAddress(m: { from: string; to: string[]; cc: string[] }, isCompanyPerson: (a: string) => boolean): string | null`. Both callers use it.

- [ ] **Step 1: Write the failing tests:**
  - `a reply in a conversation stored on the company lead links to the lead of the person in it`: Elaine has her own lead, and the thread's earlier rows are on LD-1407.
  - `a message with two company people each with a lead links by sender, then To, then Cc`.
  - `domain-only mail from a person with no lead keeps today's rule (open, most recently updated company lead)`.
  - `an own-conversation link to a different company still wins (rule 1 unchanged there)`.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.** Before returning rule 1's stored links, check whether the message's person (by `personAddress`) is a saved contact of the same company who has their own lead; if so, return that lead, that contact and the company.
- [ ] **Step 4: Run** the matchMail tests and `test/syncMailbox.test.ts`, `test/leadTimeline.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat(mail): mail links to the lead of the person in it`.

### Task 4: The one-time `lead-split` and its runbook

**Files:**
- Create: `apps/api/src/leads/split.ts`
- Create: `apps/api/src/cli/lead-split.ts`
- Test: `apps/api/test/leadSplit.test.ts`
- Modify: `docs/DEPLOYMENT.md` (a new section "One lead per person: deploy runbook", plus entries under one-time steps)
- Modify: `docs/PENDING.md`

**Interfaces:**
- Consumes: `createLeadForPerson`, `mainLeadOf`, `markCustomer` (Task 1) and `personAddress` (Task 3).
- Produces:
  - `parseSplitArgs(argv)`, with the same contract as `parseDedupeArgs`
  - `SPLIT_USAGE`
  - `splitLeads(db, { apply, log }): Promise<{ companies: number; leads: number; contacted: number; emails: number; lines: number; tasks: number; quotations: number; recipients: number; customers: number }>`

- [ ] **Step 1: Write the failing tests** on a KPMG-like fixture: a main lead with Amanda; Elaine and Nicole as contacts without leads; Carlos's sent email to Elaine with its timeline line; Elaine's reply; an email follow-up task from Carlos's send (with its `sendUserEmail` audit row); a quotation to Nicole with its "Quotation sent" line; a Mailer recipient row for Elaine.
  - `creates one lead per person without a lead, keeping the main lead's created date and owner`: Elaine starts Contacted (a team email to her address exists), Nicole New, and each has a "Split from LD-…" first line dated now.
  - `moves each person's emails, their timeline lines and the follow-up task made from them`: Amanda's and company-only lines stay.
  - `moves quotations and Mailer recipients of the person with their timeline lines; projects and events stay`.
  - `marks the person of a Won lead a customer`.
  - `the dry run reports the same counts and writes nothing`: same rollback approach as `fillLeadMailTimeline`.
  - `a second run creates 0 and moves 0`.
  - `parseSplitArgs` cases.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.**
  - One transaction per company.
  - The log line is `lead-split: <dry run|applied> companies=N leads=N contacted=N emails=N lines=N tasks=N quotations=N recipients=N customers=N`.
  - The runbook, in this order:
    1. Backup `dait_crm-pre-lead-per-person.dump`.
    2. Check `migrate status` shows only migration 29 pending.
    3. Install.
    4. Check the backfills are idle.
    5. Dry run, then show the owner the counts (expected about 28 companies and 70 leads).
    6. `--apply`.
    7. Re-run shows 0.
    8. Check the KPMG lead list shows Elaine's lead with the conversation.
  - Rollback:
    1. Switch back to the lead-mail-timeline release (migration 29 adds only).
    2. The split leads stay. To undo them, restore the backup taken in step 1; that loses anything written since, so ask the owner first.
- [ ] **Step 4: Run** `npx vitest run test/leadSplit.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat(leads): lead-split gives each person their own lead with their history; runbook`.

### Task 5: Leads table columns and export

**Files:**
- Modify: `apps/web/src/pages/leads/LeadsList.tsx`
- Modify: the list sort keys in `packages/shared/src/leads.ts` (`LEAD_SORTS`) and the API list ordering in `apps/api/src/routes/leads.ts`
- Modify: `apps/api/src/routes/leads.ts` `/leads/export.xlsx` column names and order
- Modify: i18n keys
- Test: `apps/api/test/leads*.test.ts` (sorting by `createdBy`), `apps/web` unit test for the header order, and the parity spec for the Leads screen in `apps/web/e2e/parity/`

**Interfaces:**
- Consumes: the list payload's existing `contact`, `companyName` and `createdBy` (`ref`). Add `createdBy` to the list row if it is missing.

- [ ] **Step 1: Write the failing tests:**
  - `the leads table shows the columns in the owner's order`: exact header texts in en.
  - `sorting by Created by orders by the creator's name`.
  - `the export uses the same column names and order`, with Created by as a name.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.** The "Created" date column is replaced by "Created by"; the created-date filter stays. Take screenshots at 1440 and 1280 in en/es/fr and compare them with the current Leads screen for style.
- [ ] **Step 4: Run** the tests and the Leads parity spec. Expect PASS.
- [ ] **Step 5: Commit** `feat(leads): Leads table shows Lead Name, Company Name and Created by in the owner's order`.

### Task 6: Contacts open on Customers, with All people

**Files:**
- Modify: `apps/api/src/routes/contacts.ts` (GET `/contacts`: `customers=1` filter; `customerSince` in the summary)
- Modify: the contact list query schema in packages/shared
- Modify: `apps/web/src/pages/contacts/ContactsList.tsx`
- Modify: `apps/web/src/pages/companies/tabs/ContactsTab.tsx`
- Modify: i18n keys
- Test: `apps/api/test/contacts.test.ts`, web unit tests, and the parity specs for both screens

**Interfaces:**
- Consumes: Task 1's `customer_since`.

- [ ] **Step 1: Write the failing tests:**
  - `GET /contacts?customers=1 lists only customers`.
  - `the summary carries customerSince`.
  - `the Contacts screen opens on Customers and switches to All people`.
  - `a customer row shows the Customer badge`.
  - `every action (edit, make primary, move, deactivate) works in All people`.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.** The switch uses the existing chip or segmented style. The badge uses an existing badge class. Remember the last choice per viewer in localStorage, wrapped in try/catch. Take screenshots side by side with the current screens.
- [ ] **Step 4: Run** the tests and the parity specs. Expect PASS.
- [ ] **Step 5: Commit** `feat(contacts): Contacts open on Customers with an All people switch`.
