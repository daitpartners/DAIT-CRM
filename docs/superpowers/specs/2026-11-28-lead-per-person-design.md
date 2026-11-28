# One lead per person — design

Date: 28 Nov 2026. Owner: Deepak. Builds on the lead-mail-timeline branch (timeline lines per email, one copy per email,
lead panel shows the person in the email).

## Why

The owner: "Suppose I have 10 different leads under the same company, it shows one lead … but it should show all 10
leads as separate lead ID, and if any of the lead become our customer that can go to contacts." The team works people,
not companies: Carlos writes to Elaine, Nicole, Sam at KPMG one by one, and each conversation has its own owner, status
and follow-up. Today the KPMG import is one lead (LD-1407, main contact Amanda Soendoro) with 21 people stored as
company contacts, so the timeline, status and follow-up of every KPMG conversation pile onto Amanda's lead.

## Owner's decisions (28 Nov 2026)

1. Every person is their own lead with their own Lead ID, under their company. The people already saved as contacts
   without a lead of their own become leads (live: 70 people at 28 companies; KPMG 20 of them). The existing company
   lead stays as its main contact's lead (KPMG LD-1407 = Amanda).
2. **History is split to each person (approach A):** each new lead takes its own person's emails and their timeline
   lines; company-level history (created, assigned, transferred, notes, calls) stays on the original lead.
3. New leads get the same owner as the company's lead. Status **New**, except a person the team has already emailed
   (a sent email to their address exists), who starts as **Contacted**.
4. A lead becomes a customer when its status is set to **Won**: its person is then a customer and shows in Contacts.
   The lead stays in Leads as Won with its history.
5. Leads table columns, in this order: Lead ID · Lead Name · Company Name · Language · Type · Source · Status ·
   Country · Priority · Assigned to · Next follow-up · Created by. "Lead Name" is the person's name. "Created by" is
   the name of who created or imported the lead, instead of today's "Created" date and time.
6. After the split, adding a new person at a company (Add contact, or an import that adds a person) always creates
   their own lead at once: owner = the company lead's owner, status New.
7. Contacts (the Contacts screen and the company page's Contacts tab) list everyone, open on "Customers" with a
   Customer badge, with a switch to "All people" so every person can still be edited, made primary, moved or
   deactivated.

## Facts (live, 28 Nov)

- 432 leads, all type Prospect; statuses: 231 Not Contacted, 199 New, 1 Contacted, 1 Interested.
- 253 contacts; 70 have no lead of their own, at 28 companies. 249 leads have no contact (company-only prospects from
  the 22 Nov import; only 7 of them have an email). 1 lead without a contact sits at a company that has contacts.
- Every lead has `created_by_id`.
- The schema already allows many leads per company (`leads.company_id`, not unique); companies have a unique domain.
- Mail matching (`apps/api/src/mail/match.ts` `matchMail`) already prefers a contact's own lead (rule 3) over the
  company's lead (rule 4), but rule 1 keeps a conversation on the lead its earlier messages are on.

## Approaches considered

- **A. Split history to each person (chosen).** Correct timelines from day one; costs a one-time move with a dry run.
- B. New leads start empty; history stays on the company lead. Cheaper, but Elaine's lead would not show the
  conversation the owner asked about today. Rejected.
- C. Show people as rows under the company without separate leads. Rejected: the owner wants a Lead ID per person.

## Design

### 1. What a lead is

A lead is one person at one company: `leads.contact_id` is that person. A lead without a person stays allowed
(company-only prospects; "Lead Name" shows "No contact yet" as today). Two leads never share a person.
Creating a lead for a person at an existing company joins that company (no second company), as the existing
"choose company" path does.

### 2. Customers and Contacts

- New column `contacts.customer_since` (timestamptz, null). Set when a lead whose person it is moves to **Won**
  (`applyStatusChange`). A Won lead without a person but with a name or email on the lead creates the contact first;
  a company-only lead (no person, no email) makes no contact.
- Leaving Won does not clear `customer_since` (once a customer, the record stays; my call).
- **Contacts screen** (`/contacts`) and the company page's **Contacts tab** (decision 7) open on a "Customers" view
  (`customer_since` not null, each with a Customer badge) and switch to "All people"; every existing action (edit,
  make primary, move, deactivate) works in both views. Contact records of non-customers keep working everywhere
  they are picked today (lead page person, quotations, projects, Mailer).
- **Keeping one lead per person (decision 6):**
  - Add contact (Contacts screen, Contacts tab, the email panel's Add contact) creates the person's lead in the same
    transaction: company and lead fields from the company's main lead (as the split, section 3), owner = its owner,
    status New, created by = the user adding the person.
  - An import update row that adds a new person at an existing lead's company creates a new lead for that person
    instead of re-pointing the existing lead to them; an import that re-points a lead to a person who already has a
    lead is refused for that row (reported in the import result).
  - Switch contact on a lead offers only people of that company without a lead of their own (or none).
  - Moving a person to another company moves their lead with them (company, company name) when the lead has no other
    person; a lead that is Won keeps its company (my call: history of a closed deal stays where it happened).
- One-time: people whose lead is already Won (live: none today) get `customer_since` in the split run.

### 3. The one-time split (CLI `lead-split`, dry run by default, `--apply`)

Runs after the lead-mail-timeline CLIs. For each company, for each contact with no lead of its own:

- **New lead** copying from the company's main lead (its lead with that company and the lowest id, preferring an open
  one): company, company name, country, city, website, lead source, outreach language, type, priority, import batch,
  `created_by_id` (whoever imported or created the company lead); `contact_id` = the person; `business_email` = the
  person's business email; owner = the main lead's owner; no next follow-up. Status Contacted if any stored email from
  a team member to the person's address exists, else New. A first timeline line (system) "Split from LD-…" names the
  company lead; an assignment row records the owner (by: system, note "split from LD-…").
- **Mail moves:** each `email_messages` row linked to one of that company's leads moves to the person's lead when the
  person is in it, chosen like the lead panel's person rule: the sender if they are a company person with a lead,
  else the first To, else the first Cc. Rows where no company person has their own lead stay where they are.
  Contact links move with them (`contact_id` = that person).
- **Timeline lines move with their email:** an `email` line whose related row moved goes to the new lead. Status
  lines, transfers, notes, calls and tasks stay on the original lead, except a task created from a moved email
  (`origin` email follow-up whose email moved, found through the audit row the send writes,
  `after.emailMessageId`), which moves with it. (My call: the audit row is the only link a task has to its email.)
- **Other things that belong to the person follow them:** quotations and Mailer recipients whose `contact_id` is the
  person move to the person's lead (`lead_id`), with their timeline lines ("Quotation sent", etc. related to that
  quotation). Projects and calendar events stay on the original lead (company-level). (My call.)
- **Dates:** a split lead keeps the company lead's original `created_at`, so reports and the created-date filter do
  not show 70 new leads today; its first timeline line "Split from LD-…" is dated at the split. (My call.)
- Prints counts only: companies, leads to create, emails to move, lines to move, tasks to move, leads starting as
  Contacted. Re-running creates 0.

### 4. Mail from now on

- `matchMail` rule 1 (stored conversation) yields to a more specific match: when the message's company person has
  their own lead, the message links to that lead even if the conversation's earlier rows are on another lead of the
  same company. A conversation that genuinely involves two people of one company links each message to the person in
  it (same panel rule).
- Domain-only mail (a person of the company who has no lead and is not a saved contact) keeps today's rule: the
  company's open lead, most recently updated. (My call; the owner can later ask for "new person → new lead".)

### 5. Leads table

Columns and order as decision 5. "Lead Name" = the person's name (LinkedIn icon kept), sortable. "Created by" = the
creator's name, sortable by name; empty creator shows "—". Filters and the created-date filter stay. The CSV download
(`DownloadLeadsButton`) gets the same column names and order.

## Not in scope

- Automatic "new person emails us → new lead".
- Merging or deleting the 249 company-only leads.
- Allocation rules for split leads (they keep the company lead's owner).

## Left to the builder

Query shapes, batching, index needs, exact file layout; reuse `personInEmail` (lead panel, Task 5 of the timeline
branch) for the "person in this email" rule; keep translations (en/es/fr) for the new column names.
