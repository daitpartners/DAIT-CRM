# Leads screens: exact prototype match (short design)

Owner, 21 Nov 2026, with screenshot `Reference/Screen1.png` (live LD-1178, an imported prospect without a contact):
"still leads design is not matching what I have given you the reference" → approved: "yes, go ahead and do it".
Builds on the prototype-parity release (`2026-11-21-prototype-parity-design.md`) and supersedes its recorded
deviations for the Leads screens.

## Intent

The sales team works almost entirely on imported prospects without a contact person. On those, the lead page drifts
furthest from the approved prototype (`prototype/index.html`, views-leads2.js `V.leads2` over views-lead-detail.js).
The owner wants the Leads screens to look like the prototype, not "the prototype plus our additions".

## Goals / non-goals / anti-goals

- Goals: lead page and Leads list reproduce the prototype view for both a lead with a contact (LD-2041) and a prospect
  without one (LD-2040); unbuilt features keep the prototype's look; every action that exists today stays reachable.
- Non-goals: building email sending (release 2), AI research (release 4), projects (release 3), enquiries (1D, parked).
- Anti-goals: losing Transfer / Claim / Unassign / Close with reason / Archive / Switch contact / Edit lead; changing any
  API rule; controls that look live but silently do nothing (a click on an unbuilt feature says which release brings it).

## Approaches

1. **Chosen (owner): copy the prototype exactly.** Unbuilt features drawn as in the prototype; clicking them shows
   "Coming in release N". Our additions move into prototype places or go.
2. Match the layout but keep the greyed "Available in release N" placeholder cards, removing only our additions.
   Rejected: the owner reads the greyed cards as a mismatch.

## Decided

**Lead page topbar:** title = lead number; line = "Lead created: … | Last contact: …" only. Buttons: **Email**
(full colour, `btn primary`; opens and focuses the Email tab) and **Edit profile**. No "Leads" crumb, Owner line,
Claim or More ▾. Archived leads keep the "Archived" badge and a Restore button (administrators/managers).

**Edit profile** (decided with the owner: Archive and Switch contact live here): with a contact it is today's profile
dialog; a footer row adds **Edit lead details** (today's LeadModal), **Switch contact** (when the lead has a company)
and **Archive** (confirm). Builder's call: for a lead without a contact the button still shows for users who may manage
the lead and opens the same dialog with only that footer row's actions (lead details, archive), since the prototype's
Add contact card covers the contact.

**Profile card:** prototype `.l2box` — no status stepper. The closed-lead banner stays inside the card (prototype
`closed-banner`), its text pointing to the Follow-up tab's Status.

**Composer:** tabs **Email** (first, default) / Call note / Meeting / Research note, Hide/Show as today. The Email panel
is the prototype form: To (contact email, placeholder "No email on file – add a contact"), Cc stakeholders (the
company's contacts with an email + DAIT users; chips, typed emails), Project (disabled, "available once the lead is
Won"), Template ("— blank —"), Subject and Message prefilled with the prototype's intro text (first name or company
name, signer = current user), "Set follow-up in [3 days]" switch, **Send email**. Send shows a toast "Sending email
arrives in release 2" and sends nothing; the draft stays. "Focus on email" folds the profile and opens the Email tab.

**Follow-up tab:** Next follow-up (date + badge), Priority, Type on the first row; **Owner** (decided with the owner):
current owner, with **Transfer** (transfer_leads; today's TransferModal), **Unassign** (view_all_leads, assigned
leads), **Claim** (claim_leads, unassigned) beside it; **Status** on its own row. No Tomorrow / +4 days / Next week or
Clear buttons (clearing = empty the date and leave the field; builder's call, behind a confirm as today). Picking Won
saves it (company becomes a client, as today); picking **Lost** or **Not Relevant** opens today's CloseLeadModal with
that status preselected and the reason required; choosing an open status on a closed lead reopens it. Open tasks and
"+ Task" as today. Emails tab: prototype empty state ("No emails yet") instead of a greyed card.

**Right column, in order:** without a contact, **"No contact yet" + Add contact** card (adds a contact to the lead's
company and makes it this lead's contact; opens ChooseCompany first when the lead has no company); company card with
the prototype AI line "No AI research yet. **Run research**" (click → "Coming in release 4"), verification, website,
other leads, Full profile; with a contact, Skills & languages; **Projects 0** as a normal card ("Projects unlock when a
lead at this company is marked **Won** or a quotation is accepted."); **Coming up** only when something is scheduled;
**Original enquiry** only when the lead has an enquiry (none until 1D).

**Leads list:** Lead ID cell is a purple link (`font-weight:600`, link colour); remove the Unassigned tab (the
Unassigned tile links to `?assignedTo=none`, and the Assigned filter offers "Unassigned") and the Priority filter
(Priority column stays sortable). Tabs: All leads / Leads / Prospects / My leads / Overdue follow-ups.

**Docs:** parity checklist "Deliberate differences" updated (entries removed for the lead page and list); a short
note in the parity design that this doc supersedes its Leads deviations.

## Left to the builder

Component split, CSS for the Cc chips (port prototype `.ccbox/.cchip`), test updates. Existing e2e specs that click
More ▾, the stepper or quick buttons move to the new places.
