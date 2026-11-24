# Download all leads + update through Import leads (design)

Owner, 24 Nov 2026: "include a option on leads 'Download all leads', here we can download all leads so that missing
information can be added manually, and re-upload the same via import leads, same leads id and company id will be updated
with new records, missing informations remain same." Asked whether a file value may replace an existing CRM value:
owner chose **fill blanks only**, plus: "existing updated data should be highlighted and returned as error in the
excel, so after verifying, we can update manually on the leads page directly."

## Decided
1. **Download all leads** button on the Leads page (next to Import leads), for users with `import_leads`
   (Administrators and Managers — controller's call, the owner did not pick; same as import). Downloads an .xlsx of every
   lead the user can see that matches the Leads list's CURRENT filters/search (with no filter = all leads they can see;
   archived leads excluded unless the list shows them). Columns: Lead ID (LD-n), Company ID (CO-n), the import column set
   (Company, Website, Country, City, Contact, Designation, Email, Phone, Industry, …) plus read-only context columns
   (Status, Assigned to, Language, Lead type, Source) — headers in the downloader's language, bold frozen header,
   formula-injection guard on every cell, file name `leads-YYYY-MM-DD.xlsx`. Mail content is never exported.
2. **Re-upload through Import leads.** The spreadsheet matcher recognises Lead ID and Company ID columns (en/es/fr
   headers). A row with a Lead ID / Company ID the uploader can see is an **update row**, not a new lead:
   - status "Update" (new row status, own badge, en/es/fr); research is not run for update rows unless the user ticks
     them (default unticked); language / import type choice still required for the batch as today (applies only to new
     rows);
   - on Import, for each field: CRM empty and file has a value → filled (lead, its company, its contact — same field
     mapping as new imports); CRM has a value and the file value is the same (normalised) → nothing; CRM has a value and
     the file differs → NOT changed, recorded as a **conflict**;
   - verified fields (release-4 golden rule) are never touched, also counted as conflicts if they differ;
   - Status / Assigned to / Source and other read-only context columns are ignored on upload;
   - an unknown or not-visible Lead ID / Company ID → the row is an error ("Lead LD-n not found or not yours"), never a
     new lead; a Lead ID whose Company ID doesn't match → error;
   - updates are audited like a manual edit (fields filled, by the importer, source "Import · IMPORT-…"); Undo of a batch
     also reverts fields that the batch filled (only if untouched since).
3. **Conflicts in the rows-to-fix Excel** (and listed in step 4 + the Data manager batch detail as a "Conflicts" count):
   each conflicting cell highlighted (amber) with "What to fix": "CRM has <value>, file has <value> — update on the lead
   page if correct" (en/es/fr), and a link column to the lead page URL. Step 4 shows: N rows will update M empty fields;
   K values differ (not changed — see Download rows to fix).
4. Limits: same 5,000 rows per batch; download capped at 20,000 rows (message if more — narrow the filter).
5. Only live app styles; en/es/fr; Undo, Data manager counts include updates.

## Left to the builder
Export query + streaming, matcher additions, update planning in the existing planner/commit path, conflict storage on
import rows, tests (export content + guard + visibility; round trip: export → edit blanks + change a value → import →
blanks filled, changed value reported as conflict, nothing overwritten; unknown/not-visible IDs; verified field;
undo), e2e Leads → Download all leads → Import leads update round trip, screenshots.
