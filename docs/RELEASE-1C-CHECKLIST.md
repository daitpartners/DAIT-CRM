# Release 1C owner checklist

Things to click through before Leads & Tasks (release 1C) is accepted. Tick each one and note anything that looks wrong.

You need at least one company from release 1B (with a contact) and a second user. Leads can be archived afterwards; they are never deleted.

## Leads

- [ ] In the sidebar, under Modules, click **Leads**. The list opens with the tiles (Follow-ups due today, Overdue follow-ups, New this week, Waiting to be claimed) and the views All leads, My leads, Unassigned and Prospects.
- [ ] Click **New lead**. Type the name of a company you already have and choose its country. A note under the form names the existing company and offers **Link to CO-…**. Click it: the lead is linked to that company instead of creating a new one. Save. The lead appears with a number such as LD-1001.
- [ ] Open the lead. Its page shows the status steps, the company and contact on the right, and a timeline starting with "Lead created".

## Log a call and follow up

- [ ] On the lead page click **Log call**. Choose an outcome (for example Connected), add a note, choose a **Status after call** (for example Contacted) and set a **Next follow-up** date. Save.
- [ ] The status steps move to the new status, the timeline shows the call and the status change, and **Tasks** (sidebar) lists a follow-up task for that lead on that date.

## Transfer

- [ ] On the lead page click **Transfer**, choose your colleague and type a note for them. Save. The lead now shows them as the assignee and the timeline records the transfer with your note.
- [ ] Sign in as the colleague. **Notifications** in the sidebar shows a new notification for the transferred lead with your note. Click it: the lead opens. **Mark all read** clears the unread count.

## Close a lead

- [ ] On a lead click **Close lead**, choose **Lost** and enter a reason. Save. The lead reads Lost, the follow-up date is cleared, its open tasks are closed, and the timeline shows the reason.
- [ ] Closing a lead as **Won** marks its company as a client (the company profile shows a **Client** badge).

## CSV import

- [ ] On the Leads list click **Import CSV**. Choose a small CSV file with a header row (company name, country, website, contact name and email). Map the columns, check the preview and click **Import … rows**. The summary says how many leads were created and how many were linked to existing companies.
- [ ] Include one row whose company name is close to, but not exactly, a company you already have. That lead is imported without a company and its page says it "may match one that already exists".
- [ ] On that lead click **Link company**, choose the existing company (or **Create new company**) and save. The lead now shows the company and its primary contact.

## Sales representative (Carlos)

- [ ] In Settings, Administration, **Users**, make sure Carlos Torres (`carlos.torres@daitpartners.com`) exists with the role **Sales Representative**.
- [ ] Sign in as Carlos. **Leads** lists only the leads assigned to him and the unassigned ones; leads assigned to other people are not shown.
- [ ] Open an unassigned lead and click **Claim**. A message says it is now his; the lead moves to **My leads** and the tile "Waiting to be claimed" goes down by one.

## Tasks

- [ ] Click **Tasks** in the sidebar. The tabs Today, Overdue, Upcoming and Done list your tasks; each links to its lead.
- [ ] Tick a task's box: it moves to **Done** ("Task done"). Untick it in Done: it comes back.
- [ ] Click **Snooze** on a task (Move to tomorrow): it moves to tomorrow and the lead's next follow-up moves with it.

## Notifications

- [ ] Click **Notifications** in the sidebar. New assignments and transferred leads are listed newest first; the sidebar shows the unread count and **Mark all read** clears it.

## Contacts: deactivate and move

- [ ] Open a company with two or more contacts, **Contacts** tab. Click **Deactivate** on a contact that is not primary and confirm. It disappears from the list. Tick **Show inactive**: it is listed again with a grey **Inactive** badge. It is no longer offered when you choose the contact person of a lead (New lead, Switch contact).
- [ ] Try **Deactivate** on the primary contact while other active contacts exist: a message says a company must keep one primary contact. Make another contact primary first, then deactivate.
- [ ] Click **Reactivate** on the inactive contact and confirm: it is back in the list.
- [ ] Click **Move…** on a contact, choose another company and click **Move**. The contact now appears on the other company. If it was the primary contact, it stops being primary at the old company (which may then have no primary until you make one) and becomes primary at the new company only if that company had none. Leads of other companies that named this contact lose it, with a note "Contact moved to …" on their timeline.

## Client flag

- [ ] As an administrator or manager, open a company, click **Edit** and tick **Client (an existing customer)**. Save. The profile and the Companies list show the **Client** badge. Untick it and save: the badge goes.
- [ ] As Carlos (Sales Representative), edit one of his companies: the Client box is not shown.

## Spanish labels

- [ ] Go to Settings, **My settings**, change the language to Español and save. The sidebar reads **Leads**, **Tareas** and **Notificaciones**; on the Leads list the buttons read **Nuevo lead** and **Importar CSV**, a lead page shows **Registrar llamada**, **Transferencia** and **Cerrar lead**, an unassigned lead shows **Tomar**, and Tasks shows **Posponer**. On a company's contacts, **Mostrar inactivos** and **Mover…** appear. Change the language back to English.
