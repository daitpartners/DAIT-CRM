# Prototype parity owner checklist

Things to click through before the prototype parity release is accepted. Each screen of the CRM should now look and read like the matching view of the prototype: same sections in the same order, same headings, buttons and empty texts. Compare layout and wording, not pixels or sample data. Tick each one and note anything that looks wrong.

Differences that were made on purpose are listed at the end; they are not faults.

## Before you start

- [ ] Open the prototype next to the CRM. From the repository root run `cd prototype && python3 -m http.server 8765`, then open `http://127.0.0.1:8765/index.html#/dashboard` in a private (incognito) window. The prototype keeps its sample data in the browser, so a private window always starts from the same data.
- [ ] In a second window, sign in to the CRM (test server or a local `npm run dev`). Use a user who has a few leads, tasks and notifications assigned to them, and at least one company with contacts.
- [ ] For each screen below, open the prototype address (`http://127.0.0.1:8765/index.html` followed by the part starting with `#/`) and the CRM page side by side.

## Dashboard

Prototype `#/dashboard` · CRM `/`

- [ ] The title greets you ("Good morning / afternoon / evening, {first name}") and the line under it shows today's date and "everything assigned to you…". A bell with the unread count and **New lead** sit on the right.
- [ ] Four tiles: My open leads (with "n new since yesterday"), Follow-ups due today (with the overdue count in red), Meetings today and Quotes awaiting response (both show "—" and "Available in release 3").
- [ ] Cards: Tasks & follow-ups (first six tasks with tick boxes and "View all n tasks"), Today's agenda (placeholder, release 3), Notifications (latest five), My pipeline by status (bars, with "Won: n · Lost: n" under them).

## Leads list

Prototype `#/leads` · CRM `/leads`

- [ ] Title "Leads" with "Inbound leads and researched prospects, one module"; search, **Import CSV** and **New lead** on the right.
- [ ] Tiles New this week, Follow-ups due today, Unassigned.
- [ ] Tabs All leads, Leads, Prospects, My leads, Overdue follow-ups (red count), and **Unassigned** (CRM only, see below).
- [ ] Filters in the order Status, Source, Country, Assigned, Lead type, Created (Any time, Last 7/30/90 days, Custom range…), then Priority and Clear; "Showing n of m" on the right.
- [ ] The columns match. The pager at the bottom offers 25, 50 or 100 rows and First, Prev, Page n of m, Next, Last.

## New lead

Prototype `#/leads/new` (and `#/leads/new?company=CO-0318`) · CRM `/leads/new` (**New lead** on the Leads list or the Dashboard) and `/leads/new?company=…` (**New lead** on a company profile or its Leads & Prospects tab)

- [ ] Title "Create lead or prospect", "Leads / New" above it and "Lead ID will be generated on save" on the right. The prototype also shows the next number; the CRM gives the number on save.
- [ ] Main column cards in order: **Lead type** (Lead / Prospect cards with their descriptions), **Company**, **Source**, **Assignment & follow-up**, then **Cancel** and **Create lead**.
- [ ] **Company**: Company name, the duplicate check under it, Company (existing record) with "Create new company on save" when empty, Contact person ("— none yet —"), Company website, Business email, Phone number, Country, City. Type an existing company's website (for example `https://northwindlogistics.in`): "Possible duplicate: 1 existing company matches" lists name · domain · country · contacts · open leads, "Matched on … · confidence …", with **View** and **Use existing company**. Use it: the note turns green ("Linked to existing company CO-…"), the primary contact is chosen and its email filled in. A new name says "No duplicate found… A new company record will be created on save."
- [ ] **Source**: Lead source (Manual Entry by default), Source URL, "Import batch: —" with "Set automatically for CSV and Google Places imports."
- [ ] **Assignment & follow-up**: Assigned to starts with "Leave unassigned · allocation rules decide" and defaults to you; Lead priority (Medium); Lead status (New, greyed); Next follow-up date (two days ahead); Lead notes.
- [ ] Right column: **What happens on save** (five steps; AI enrichment shows "Available in release 4") and **Linked company preview** (no company: "A new company record will be created on save, unless a duplicate is found above"; with a company: initials, name, industry · city, country · size, Contacts, Open leads, Verification).
- [ ] From a company profile, **New lead** opens the page with that company, its contact, website, country and city filled in.
- [ ] **Create lead** shows "LD-… created" and opens the new lead. **Cancel** returns to Leads. Edit lead (lead page, More ▾) is still a dialog.

## Lead page

Prototype `#/leads/LD-2041` · CRM `/leads/LD-…` (open any lead)

- [ ] Title is the lead number; the line under it reads "Lead created: … | Last contact: … | Owner: …". Buttons **Email** (greyed out, release 2), **Edit profile** and **More ▾** (Edit lead, Transfer, Close lead, Switch contact, Unassign, Archive).
- [ ] PROFILE card: collapses with the chevron and shows a one-line summary when closed; contact name and badges, headline, company · department · location, LinkedIn / mobile / email / office, the completeness ring, the eight facts (Lead source … Time zone), the status steps, About, and the EXPERIENCE column. **Focus on email** is greyed out (release 2).
- [ ] Compose panel: Email (greyed out, release 2), Call note, Meeting, Research note, and Hide/Show. Save a call note, a meeting and a research note: each appears in the timeline.
- [ ] Tabs Follow-up, Emails (placeholder, release 2), Calls. Follow-up has the date with **Tomorrow / +4 days / Next week**, Clear, priority, type, status and open tasks with **+ Task**. Calls shows the timeline.
- [ ] Right column: company card (AI summary placeholder, release 4; verification badge; website; other open leads; Full profile →), Skills & languages with **Edit**, Projects (placeholder, release 3), Coming up, Original enquiry (placeholder, release 1D).
- [ ] **Edit profile**: change the headline, location, about, an experience row, an education row, skills and languages. Save: the profile card shows them.

## Companies list

Prototype `#/companies` · CRM `/companies`

- [ ] Title, search and **New company**. Tiles Total companies, Verified profiles, AI research queue ("—" and "Available in release 4"), Possible duplicates.
- [ ] Tabs All companies, Clients, With open leads, Needs verification, Duplicate review (red count). Filters Industry, Country, Company size, Status, Verification with "Showing n of m".
- [ ] Columns Company name (with Client badge and CO- number), Website, Industry, Country, City, Company size, Contacts, Leads, Verification, Status.

## Company profile and its tabs

Prototype `#/companies/CO-0318` (add `/contacts`, `/locations`, `/leads`, `/activities`, `/ai`, `/sources` for each tab) · CRM `/companies/CO-…` and its tabs

- [ ] Header: logo initials, "Companies / CO-…", name with status, verification and Client badges, the facts line, and the buttons Run AI research (greyed, release 4), Add contact, New lead, New quotation (greyed, release 3), Create project (clients only, greyed, release 3), Edit profile.
- [ ] Tabs Overview, Contacts n, Locations n, Leads & Prospects n, Activities n, AI Intelligence, Research Sources.
- [ ] **Overview**: legend line, sections A to E (overview, address, size & financial, products & services, digital presence) on the left; AI business intelligence (placeholder), Projects (placeholder), Leads & prospects and Contacts on the right.
- [ ] **Contacts**: "Contacts at {name}" with its note; columns Contact, Designation, Department, Business email, Phone, Mobile, Contact type, Primary; Show inactive, Make primary, Move and Deactivate still work.
- [ ] **Locations**: "Office & branch locations" and one card per site.
- [ ] **Leads & Prospects**: the lead table, **+ New lead for this company**, and on the right Pipeline at this company and Rules enforced here.
- [ ] **Activities**: "All interactions with this company", with Activity summary (Calls, Emails, Meetings, Quotations, Last touch) and Where this comes from on the right.
- [ ] **AI Intelligence** and **Research Sources**: greyed placeholder cards, "Available in release 4", with no buttons.

## Contacts

No prototype view · CRM `/contacts`

- [ ] The page is kept (see below). Its header and filters look like the other lists: search, "Contact type: Any", Clear and "Showing n contacts".

## Tasks

Prototype `#/tasks` · CRM `/tasks`

- [ ] Title and subtitle match; **My tasks** / **Team** buttons (Team only for managers and administrators) and **New task**.
- [ ] Main card with Overdue (red count), Due today (purple count) and Upcoming, each with tick boxes; "None." when empty. Completed and "How tasks get here" sit in the right column.
- [ ] Tick a task: it moves to Completed. Snooze still moves it to tomorrow.

## Notifications

Prototype `#/notifications` · CRM `/notifications`

- [ ] Title with **Mark all as read**; the attention strip shows overdue and due-today open tasks; tabs All and Unread (red count); "Showing n of m"; rows grouped Today, Yesterday, Earlier with an unread dot.
- [ ] Click a row: it is marked read and the lead opens.

## Settings and its tabs

Prototype `#/settings` (one long page) · CRM `/settings` and its tabs

- [ ] Title "Settings" with "Configuration the CRM reads at runtime; nothing here is hard-coded in forms".
- [ ] One tab per prototype card, in the prototype's order: **Preferences** (`/settings`: Language, Date format, Time zone, Save), **Email & calendar connections** (`/settings/connections`: placeholder, release 2; administrators also see the system mailbox), **Email templates** (`/settings/templates`: placeholder, release 2), **Dropdown configuration** (`/settings/lookups`), **Lead allocation rules** (`/settings/allocation`), **Users** (`/settings/users`, where the prototype shows Roles).
- [ ] Signed in as a Sales Representative, only Preferences, Email & calendar connections and Email templates are offered.

## Spanish and French labels

- [ ] In Settings, Preferences, switch to Español and save. Walk the Dashboard, Leads, a lead page and Settings: no English words left on buttons, tabs or headings. Repeat with Français, then switch back to English.

## Deliberate differences

These differ from the prototype on purpose:

- **Contacts page kept.** The prototype has no Contacts page; the CRM keeps the 1B page, styled like the other lists.
- **Unassigned tab kept** on the Leads list. Sales representatives claim leads from it.
- **Priority filter kept** after Created on the Leads list (a 1C filter).
- **Clone lead omitted.** Ruled out in release 1C.
- **Later modules are not in the sidebar.** Email, Mailer, Calendar, Quotations, Projects and Enquiries stay out of the sidebar until their release ships. Where a page in the prototype shows them, the CRM shows a greyed placeholder card or button with "Available in release …" and no controls.
- **Release numbers on placeholders:** email, mailer and email templates release 2; calendar, quotations and projects release 3; AI research and research sources release 4; enquiries release 1D.
- **Greeting by your time zone.** The Dashboard says good morning, afternoon or evening by the hour in the time zone chosen in your Preferences, not the computer's clock.
- **Preferences preview line omitted.** The prototype's "Preview · a call logged at 14:05…" line under the time zone is not shown; settings save with an explicit **Save** button.
- **Tabbed Settings.** The prototype stacks every card on one page; the CRM keeps one tab per card so each has its own address and access rights. Users sits where the prototype shows its static Roles table; the prototype's "Prototype data" and "Hosting" cards are left out.
- **Status steps and quick follow-up buttons kept** on the lead page, and **Owner** is shown in the line under the title, so status, follow-up and owner stay one click away.
- **Meeting note without a calendar.** The Meeting tab saves a note on the timeline (title, date, time, notes); length, place and invitations come with the calendar in release 3.
- **Notifications have no type chips**, and Projects is not a company tab (release 3).
- **Contacts in the sidebar.** The sidebar has a Contacts entry below Companies; the prototype has no Contacts page, so no entry.
- **Tasks show the first 100 of each group.** Overdue, Due today and Upcoming each list at most 100 tasks; a longer group ends with "Showing the first n of total." The prototype lists everything.
- **New lead number on save.** The New lead page says "Lead ID will be generated on save" without predicting the number, and the AI enrichment step reads "Available in release 4". Edit lead stays a dialog on the lead page.
- **AI research queue tile shows "—"** with "Available in release 4" until AI research exists; the prototype shows a count of queued jobs.
