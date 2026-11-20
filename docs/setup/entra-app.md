# Microsoft Entra app registration for the DAIT CRM

Done once by a **Global Administrator** of the DAIT Partners Microsoft 365 tenant. About ten minutes.
It lets staff sign in to the CRM with their Outlook / Microsoft 365 account and lets the CRM send and read mail
and calendar through Microsoft Graph. No passwords are ever stored in the CRM.

## Steps

1. Open https://entra.microsoft.com and sign in as the Global Administrator.
2. Left menu: **Identity → Applications → App registrations → + New registration**.
3. Fill in:
   - Name: `DAIT CRM`
   - Supported account types: **Accounts in this organizational directory only (single tenant)**
   - Redirect URI: platform **Web**, value `https://crm.daitpartners.com/api/auth/microsoft/callback`
   Click **Register**.
4. On the app's **Overview** page copy two values (you will put them in the server `.env`, never in chat or the repo):
   - **Application (client) ID** → `MS_CLIENT_ID`
   - **Directory (tenant) ID** → `MS_TENANT_ID`
5. **Authentication** (left menu of the app) → under Web redirect URIs click **Add URI** and add the test site:
   `https://crm-test.daitpartners.com/api/auth/microsoft/callback` → **Save**.
6. **Certificates & secrets → Client secrets → + New client secret**. Description `crm-server`, expiry **24 months**.
   Click Add, then copy the **Value** column immediately (it is shown only once) → `MS_CLIENT_SECRET`.
   Put a reminder in your calendar for the expiry date; a new secret must be issued before then.
7. **API permissions → + Add a permission → Microsoft Graph → Delegated permissions** and tick:
   `User.Read`, `offline_access`, `Mail.ReadWrite`, `Mail.Send`, `Mail.Send.Shared`, `Calendars.ReadWrite`.
   Click **Add permissions**, then **Grant admin consent for DAIT Partners** → Yes.
   All six rows must show a green tick under Status.
8. Decide which mailbox the CRM sends system email from (visitor confirmations, assignment and transfer notices),
   for example `hello@daitpartners.com`, and tell the builder the address. An administrator of the CRM connects it
   in the CRM under **Settings → Administration → System mailbox** by clicking **Connect mailbox** and signing in
   with Microsoft. Which account signs in depends on what kind of mailbox `hello@` is (Microsoft 365 admin center →
   Teams & groups → Shared mailboxes lists the shared ones):
   - **(a) `hello@` is a licensed user mailbox** (it has its own password): leave **Send as** empty, click
     **Connect mailbox** and sign in to Microsoft **as `hello@daitpartners.com`**. The CRM sends as that account.
   - **(b) `hello@` is a shared mailbox** (no password of its own): first, in the Microsoft 365 admin center,
     open the shared mailbox → **Manage mailbox permissions** → **Send as** and add the person who will connect it.
     Then that person types `hello@daitpartners.com` in **Send as (shared mailbox address)**, clicks
     **Connect mailbox** and signs in with **their own** account. The CRM sends as `hello@` through their
     Send-As right (this is what `Mail.Send.Shared` is for). If that person leaves or loses the right, connect
     again with someone who has it.

   Afterwards the page shows "Sends as: hello@daitpartners.com". Click **Send test email** to check it works.

## Hand to the builder

Three values go into `/home/daitcrm/<env>/shared/.env` on the server (you run the command; the builder supplies it):

```
MS_TENANT_ID=
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_REDIRECT_URI=https://crm.daitpartners.com/api/auth/microsoft/callback
```

Plus the system mailbox address from step 8. The CRM also needs a list of which staff may sign in: any user in the
tenant can authenticate, but only people an administrator has added under Settings → Users get in.
