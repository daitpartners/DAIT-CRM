# Import leads + Data manager (design)

Owner, 23–24 Nov 2026: "Import Leads … create a page … Language selection (spanish / english leads), import file (there
will many different type of files, may be excel, pdf, words) all the data will be coming will be in scattered, and this
dashboard (import leads) will segregate and make a table on next step where engine will identify data as per
leads/company data structure, and AI engine will go one by one to research the data and try to collect missing details
from regular google web or claude code. once this process is filled, they will be ready to import in the database. Also
there will be data manager link on the same page where we can see how many data and by then it was imported or add
(some sort of import lead management system). can you mockup and get it approved before development."
Then: no defaults on language / import type ("people have to select else it will not go to next step and flash the
message"); remove the per-column mapping dropdowns, ask about unsure spreadsheet columns instead; "keep the theme as per
deployed, no other colour, font, style"; **"Approve for the leads import."** plus: "disqualified leads should have
provision to download with highlighted row or column, so that it could be fixed and upload later stage. If the company
already there, please update the contacts if it's new."

**Approved mockup:** `docs/superpowers/mockups/2026-11-24-import-leads.html` (built from the live app.css and real
component markup; published to the owner as https://claude.ai/artifact/WRbyBP4wcDLcvCa7ZBQm5U). Screens, wording and
layout follow it; only the live app's existing styles and components may be used.

Standing rules: build only what the mockup shows (+ the two owner additions below); check by side-by-side screenshots
before "done"; en/es/fr for all UI text; mail private to its owner; API keys/tokens never reach the browser; new npm
dependencies pinned exactly, published ≥ 2 weeks earlier; deploy only on the owner's "deploy".

## Intent
Sales staff get lead lists in every shape (trade-show Excel exports, exhibitor PDFs, Word notes with business cards).
Today only a strict CSV import exists (Leads → Import CSV). This page turns messy files into clean prospects/leads with
the missing details researched, lets a person check everything before it touches the database, and keeps a record of
every import so it can be traced, fixed and undone.

## Goals / non-goals / anti-goals
- Goals: Import leads page under Leads (breadcrumb "Leads / Import leads"; the Leads page's "Import CSV" button is
  replaced by "Import leads"), 4-step wizard (Upload → Sort the data → AI research → Review and import), Data manager
  tab (batches list, batch detail, download, undo), download of rows to fix as a highlighted Excel file.
- Non-goals: scanned/image-only PDFs (OCR) — flagged "Can't read scans yet"; contacts/people research beyond the lead's
  own fields; scheduled/automatic imports; importing into anything but leads/prospects + companies + contacts; email
  campaigns from the import.
- Anti-goals: anything saved to leads/companies/contacts before step 4's Import; overwriting existing company or
  contact data; an invented value presented as fact (research values carry source + confidence and follow the release-4
  golden rule); a default language or import type; spending on Claude beyond the owner's monthly run cap; files or
  extracted personal data readable by people without import rights.

## Approaches
1. **Chosen:** server-side staging. Upload → files stored per batch → a worker job extracts text and builds staged rows
   (spreadsheets by header matching; PDF/Word/text by Claude Code structured extraction over the text, when the Claude
   engine is on; otherwise a deterministic extractor for emails/phones/URLs/company lines) → research job per staged row
   through the existing release-4 providers (website reader, then Claude Code) → user reviews → one transaction imports.
   Every step is resumable; the batch is the record shown in the Data manager.
2. Browser-side parsing — rejected: PDFs/Word and AI extraction need the server; staging must survive a closed tab.
3. Extending the CSV modal — rejected: the flow needs four steps, research time and a history.

## Decided
**Access.** Administrators and Managers (a new right `import_leads`, granted to those roles). Batches and their files
are visible to users with that right only.

**Step 1 — Upload.** Outreach language (English leads / Spanish leads) and Import as (Prospects / Leads) as radio cards,
**nothing pre-selected**; continuing (or clicking a later step) without both shows the app's `.note.danger` alert
"Choose … before continuing." plus `.err-msg` under each missing group; the server refuses a batch without both.
Files: .xlsx .xls .csv .pdf .docx .txt, up to 10 files, 20 MB each; each file listed with what was read ("3 sheets ·
412 rows", "18 pages · text found", "images only, no text" → badge "Can't read scans yet", not processed). Allocation
uses the existing language allocation rules.

**Step 2 — Sort the data.** Rows in the CRM's lead/company/contact fields: Company, Website, Country, City, Contact,
Designation, Email, Phone, Industry, plus From (file · row/page) and Status: Ready (company + country + email or phone or
website), Missing details, Already in CRM (company matched by website domain or normalised name → shows CO-n), Not a
lead (headers, totals, blank lines). Tiles: Rows found / Ready / Missing details / Already in CRM / Not a lead. Cells are
editable (saved to the staged row). Include tick per row (Already in CRM and Not a lead unticked by default). No column
mapping dropdowns: when a spreadsheet column's meaning is uncertain, one `.note.warn` question at a time above the table
("Column "Firma" in Expo-Dubai-visitors.xlsx — is this the Company name?" + field select + Confirm), re-sorting that
file's rows on confirm. Country values are matched to the CRM country list; unknown ones are flagged.

**Step 3 — AI research.** For ticked rows with missing details, one row at a time on the existing research worker lane:
website reader (free; finds the site via the company's own website or, when Claude is on, Claude web search), then
Claude Code (structured output, WebSearch tool only, as release 4's Claude Code engine) for what is still missing. Each
found value records source URL + confidence; shown with the AI tag and a source line. Progress bar, tiles (Found
everything / Found some / Found nothing / Claude runs this month n / cap), Pause/Resume, activity log. Every row
researched by Claude counts toward the monthly run cap; when the cap or daily limit is reached, research stops with a
clear message and the rest stay "Missing details". If Claude Code is off, only the website reader runs (said on screen).
The user may go to step 4 while research continues.

**Step 4 — Review and import.** Tiles: Will be imported / New companies / Added to existing companies / Skipped.
"Before you import" rules list. **"Accept research values with confidence 80% or higher" starts unticked** (owner: no
defaults); unticked → research values go to the company's AI Intelligence suggestions (release-4 golden rule); ticked →
values ≥ 80 are written as accepted (recorded in ai_fields with source). "Rows that still need you": rows without email
or phone — Import them / Leave them out (no default; required before Import); unknown countries listed with "Add these
countries" (Administrators) or leave out. Import runs in one transaction per batch (or resumable chunks with the batch
status), creates companies / contacts / leads with source "Import · IMPORT-YYYY-MM-DD[-n]", allocation by language
rule, optional one notification per assignee.

**Existing companies (owner).** A row whose company exists: no new company; the lead is created on the existing
company; the contact is added as a **new contact on that company if it is new** (matched by email, else by normalised
full name within the company); existing company and contact fields are never overwritten; research values for that
company become suggestions (or accepted ≥ 80 per the tick, only into empty unverified fields).

**Download rows to fix (owner).** Button on step 4 and in the batch detail: an .xlsx of every row that will not be
imported or still needs attention (Not a lead, unticked, Missing details after research, unknown country, errors). Same
columns as step 2 plus "What to fix" (plain words, e.g. "Add an email or phone", "Country not in the CRM: Chile") and
"From". The whole row has a light fill; each problem cell is filled red (missing required) or amber (questionable /
unknown value); header row bold and frozen. The file re-imports cleanly through step 1 (its headers match the
spreadsheet header matcher; the "What to fix"/"From" columns are ignored on upload).

**Data manager tab.** Tiles: Imported this month / Waiting for review / Still being researched / Duplicates skipped.
Batches table (Batch id link, Date, By, Language, Files, Rows, Imported, New companies, Skipped, Research progress,
Status: Uploading · Sorting · Waiting for review · Researching · Importing · Imported · Undone · Failed) with Language /
Status filters and search. Batch detail: tabs Imported / Skipped / Errors / Original files (download originals), actions
Download rows (CSV), Download rows to fix (Excel), Open leads in Leads list (filtered by the batch source), Undo this
import… (Administrators): lists then removes leads, contacts and companies this batch created that nobody has worked on
(no emails, notes, tasks, quotations, projects, status changes beyond New, no edits); anything worked on stays and is
listed; contacts added to existing companies are removed only if untouched. A batch can be continued from the Data
manager while not yet imported.

**Data.** New tables (names indicative): `import_batches` (number, language, lead_type, status, created_by, counts,
research progress, timestamps, undo info), `import_files` (batch, name, type, size, storage path, pages/sheets, read
status), `import_rows` (batch, file, origin ref, fields JSON, field sources/confidence JSON, status, include flag,
problems JSON, created lead/company/contact ids). Uploaded files stored under the server's shared storage folder per
batch (outside the web root), deleted with the batch after 90 days (or kept — builder's call, documented). Leads get the
existing source mechanism value "Import · <batch>".

**Limits.** Daily research limit and Claude monthly run cap from release 4 apply. Max 5,000 rows per batch.

## Left to the builder
Parsing libraries (pinned, ≥ 2 weeks old) for xlsx/xls/docx/pdf text and xlsx writing; the deterministic extractor;
the Claude extraction prompt and schema; job design (reuse the job queue and research lane); API shapes; how the
"unsure column" questions are chosen; file retention; tests (extractors on fixture files, staging, existing-company
contact rule, import transaction, undo rules, Excel export highlighting); screenshot parity against the approved mockup
for every step and the Data manager.
