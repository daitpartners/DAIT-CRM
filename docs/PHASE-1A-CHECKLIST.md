# Release 1A owner checklist

Things to click through on the test site before 1A is accepted. Tick each one and note anything that looks wrong.

## Signing in

- [ ] Open the test site and choose **Sign in with Microsoft**. Sign in with your own DAIT Partners account. You land on the dashboard and the sidebar shows your name and role.
- [ ] Open a private window and sign in with a Microsoft account that is **not** registered in the CRM (for example a personal account). You see the "not registered" page, not the dashboard.
- [ ] Click **Sign out** in the sidebar. You return to the sign-in page, and going back in the browser does not show CRM pages.

## Users and settings

- [ ] Go to Settings, Administration, **Users**. Click **Add user**, add a colleague with a role, and check they appear in the list.
- [ ] Deactivate that user. A confirmation box appears; after confirming the status reads Inactive. Reactivate them.
- [ ] Go to Settings, **My settings**. Change the language to Español and Save. The menu and page text switch to Spanish. Change it back to English.

## System mailbox

- [ ] Go to Settings, Administration, **System mailbox** and connect the sending mailbox (hello@daitpartners.com) as described in `docs/setup/entra-app.md` step 8: if hello@ is a licensed mailbox, leave **Send as** empty and sign in as hello@; if it is a shared mailbox, type hello@daitpartners.com in **Send as** and sign in with your own account (you need Send-As rights on it). The page shows it as connected and, for a shared mailbox, "Sends as: hello@daitpartners.com".
- [ ] Click **Send test email**. Check that (a) a message confirms it was queued and **Waiting to send** goes up by one; (b) within a minute the worker sends it, so **Waiting to send** goes back down (refresh the page) and nothing appears under failed emails; (c) an email titled "DAIT CRM test email" arrives in your own (the signed-in administrator's) inbox; (d) the same email appears in the Sent items of the system mailbox (hello@) in Outlook.

## Phone view

- [ ] Open the site on a phone (or narrow the browser window to under 900 px). The sidebar is replaced by a top bar with a **Menu** button; tapping it opens the navigation, and choosing a page closes it.
