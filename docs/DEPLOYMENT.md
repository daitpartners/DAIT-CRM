# Deployment

How the DAIT Partners CRM runs at https://crm.daitpartners.com, how a release goes live, how to roll back, back up and
restore. State as of 23 Nov 2026 (live release `08ee5da`). Companion documents: `docs/ENVIRONMENT.md` (every
environment variable), `docs/MIGRATIONS.md` (every database migration), `deploy/openlitespeed.md` (web server and DNS),
`docs/setup/entra-app.md` (Microsoft 365 app registration).

Commands marked `!` run in your own terminal. Replace the angle-bracket parts. Never paste a secret into chat, a ticket
or the repository.

## The shared-server rule

88.222.213.73 (AlmaLinux 9, CyberPanel, OpenLiteSpeed) also hosts about 30 other sites and apps. **Touch only the CRM:**
the Linux user `daitcrm`, its own PM2, its home folder, the `dait_crm` database and the `crm.daitpartners.com` vhost.
Never restart, reload or reconfigure root's PM2, other users' apps, PostgreSQL itself, or other vhosts; never install or
update system packages or the server's Claude Code for the CRM. An OpenLiteSpeed restart (`lswsctrl restart`) affects
every site; do it only when the CRM vhost really changed.

## What runs where

| | Live |
|---|---|
| Hostname | crm.daitpartners.com (Cloudflare DNS, grey cloud; Let's Encrypt certificate through CyberPanel) |
| Web server | OpenLiteSpeed vhost, proxy `context /` → `http://127.0.0.1:3090` (`deploy/openlitespeed.md` step 3) |
| Linux user | `daitcrm` (Node 24 via nvm, its own PM2 started at boot by the `pm2-daitcrm` systemd service) |
| PM2 apps | `crm-live` (API on 127.0.0.1:3090, also serves the built web app) and `crm-live-worker` (background jobs) |
| Database | PostgreSQL database `dait_crm` (owned by the app's own login role, named in `DATABASE_URL`) |
| Env file | `/home/daitcrm/live/shared/.env` (mode 600; see `docs/ENVIRONMENT.md`) |

**One API process (PM2 fork mode), on purpose.** Two things live in its memory: the Email reader's pause on asking
Microsoft for older message bodies (30 minutes after a refusal or three failures in a row, per mailbox) and the
worker thread that parses email bodies (one per process, in `crm-live` and in `crm-live-worker`, with a 3 s limit per
body). Running the API in cluster mode or with several instances would give each process its own pause (more Graph
calls while Microsoft is unhealthy) and its own parsing thread; nothing would break, but revisit this note first.

See the processes with `! ssh root@88.222.213.73 'sudo -iu daitcrm pm2 ls'`. (In a non-interactive `ssh daitcrm@…
'command'`, nvm is not loaded: prefix `source ~/.nvm/nvm.sh &&`. `sudo -iu daitcrm` runs a login shell, which loads it.)

**Folders in `/home/daitcrm`:**

| Path | What |
|---|---|
| `live/releases/<sha>/` | One folder per installed release (the newest 5 are kept, in install order from `live/releases.log`) |
| `live/current` | Symlink to the release that is running; PM2 runs from it |
| `live/shared/.env` | Environment file, shared by every release |
| `live/shared/storage/` | Created at setup; `STORAGE_DIR` for the api and worker (set in `deploy/ecosystem.config.cjs`). Import leads uploads live in `shared/storage/imports` (`imports/<batch>/<file>`, files 0600). Template uploads are not kept; the quotation PDF logo ships in `apps/api/assets` |
| `build/<sha>/` | Where a release is built on the server during a manual deploy |
| `incoming/<sha>.tgz` | The packed release that `release.sh` installs |
| `backups/` | Database dumps (see Backups) |
| `.pm2/logs/` | Process logs (see Logs) |

**Memory limits (PM2 `max_memory_restart`, `deploy/ecosystem.config.cjs`):** the api restarts at 400M, the worker at 1G. The worker reads each Import leads file in a separate child process with a 2-minute timeout and a 512 MB V8 heap limit. That limit covers the JavaScript heap only: Buffers (the uploaded file, up to 20 MB, and the inflated entries of an .xlsx / .docx, capped at 100 MB in total) come on top, so one read can use roughly 650 MB at worst. PM2 measures the worker process itself, not that child; the worker's 1G is headroom for holding the upload next to mail and research (the server has 32 GB). A read that runs out of memory only ends the child (the file is Failed "too large").

**There is no test copy on the server.** `~/test`, the `crm-test` / `crm-test-worker` apps, the `dait_crm_test`
database and crm-test.daitpartners.com were planned but never set up (see "If you later want a test copy" at the end).
Every release so far was checked locally (unit, API, end-to-end and prototype-parity screenshots) and then deployed
straight to live by hand.

## GitHub workflows

- **CI** (`.github/workflows/ci.yml`) runs on every push: `npm ci`, typecheck, unit, API and end-to-end tests, the
  deploy-script test.
- **Deploy to test** (`deploy-test.yml`) is manual-only since `c01e562` (23 Nov 2026), because there is no test copy;
  it would fail if run.
- **Deploy to live** (`deploy-live.yml`) runs `release.sh promote`, which copies what the test copy runs; with no test
  copy it has nothing to promote. **Do not use it.** Live is deployed by hand as below.

## Deploying a release to live (manual)

Only when the owner has said "deploy". Pick the commit (`<sha>`, the short form is fine; use the same spelling
throughout, because it names the release folder and must equal what `/api/health` reports). CI must be green on it.

1. **Back up the database** (as root on the server; the file name records which release it precedes):

   ```
   ! ssh root@88.222.213.73
   sudo -u postgres pg_dump -Fc dait_crm > /home/daitcrm/backups/dait_crm-pre-<release-name>.dump
   chown daitcrm:daitcrm /home/daitcrm/backups/dait_crm-pre-<release-name>.dump
   ls -l /home/daitcrm/backups/
   ```

   The redirect is done by root's shell, so `postgres` does not need access to `/home/daitcrm`. Check the file is not
   tiny (a few hundred KB or more today).

2. **Send the source to the server** (from your Mac, in the repository):

   ```
   ! git archive --format=tar.gz -o /tmp/crm-<sha>.tar.gz <sha>
   ! scp /tmp/crm-<sha>.tar.gz root@88.222.213.73:/tmp/
   ```

   then on the server as root: `chown daitcrm /tmp/crm-<sha>.tar.gz`.

3. **Build it as `daitcrm`:**

   ```
   sudo -iu daitcrm
   mkdir -p ~/build/<sha> ~/incoming && tar xzf /tmp/crm-<sha>.tar.gz -C ~/build/<sha> && cd ~/build/<sha>
   npm ci
   npm run build
   npm ci --omit=dev
   tar czf ~/incoming/<sha>.tgz package.json package-lock.json node_modules packages/shared apps/api apps/worker apps/web/dist prisma deploy
   ```

   `npm ci --omit=dev` leaves only production dependencies in `node_modules`, so the release carries them and the live
   folder never runs `npm`. `apps/api` is packed whole, so `apps/api/assets` (the logo printed on quotation PDFs) is
   included. Anything the API reads from disk at run time must sit inside one of the packed paths.

4. **Install and switch:**

   ```
   bash ~/build/<sha>/deploy/release.sh install live ~/incoming/<sha>.tgz <sha>
   ```

   The last line must read `live is now running <sha>.` What `release.sh install live` does, in order:

   1. Refuses (exit 2) if `<sha>` is the release already running, so the running folder is never overwritten.
   2. Unpacks the tarball into `~/live/releases/<sha>/` and writes `<sha>` into its `RELEASE` file.
   3. With `node --env-file=~/live/shared/.env`: `prisma generate` (the query engine must match the server's OS),
      `prisma migrate deploy` (applies new migrations to `dait_crm`), then the compiled seed `apps/api/dist/cli/seed.js`
      (lookup values; idempotent). **If any of these fail, it stops: `current` and PM2 are not touched**, but a
      migration that did apply stays applied.
   4. Points `~/live/current` at the new folder and runs
      `pm2 startOrReload <release>/deploy/ecosystem.config.cjs --only crm-live,crm-live-worker --update-env`.
   5. Polls `http://127.0.0.1:3090/api/health` (30 tries, 1 s apart) for `"ok":true` and `"release":"<sha>"`.
   6. **If the health check never passes:** points `current` back at the previous release, reloads PM2 on it, prints
      `Put back <previous>` and exits 1. Database migrations are not undone (they are written so the previous release
      still works against them).
   7. On success: appends `<sha>` to `~/live/releases.log` and deletes release folders older than the newest 5.

5. **Check from outside:**

   ```
   ! curl -s https://crm.daitpartners.com/api/health
   ```

   must show `{"ok":true,"release":"<sha>"}`. Then `sudo -iu daitcrm pm2 ls` (both apps `online`, restarts not
   climbing) and sign in once to look at the changed screens.

6. **One-time steps**, if the release notes list any (see "One-time steps after a release").

7. **Tidy up** (optional): `rm -rf ~/build/<sha> ~/incoming/<sha>.tgz` as `daitcrm`, `rm /tmp/crm-<sha>.tar.gz` as root
   and on the Mac. Keep the pre-release dump.

`release.sh promote` (copy the test copy's running release to live) exists for the two-copy setup and cannot be used
while there is no test copy.

## Rolling back

`release.sh` already rolls back automatically when a new release fails its health check. To go back by hand (the new
release is healthy but wrong), as `daitcrm`:

```
sudo -iu daitcrm
ls -t ~/live/releases          # the newest 5; cat ~/live/releases.log for install order
ln -sfn ~/live/releases/<previous-sha> ~/live/current
pm2 startOrReload ~/live/current/deploy/ecosystem.config.cjs --only crm-live,crm-live-worker --update-env
curl -s http://127.0.0.1:3090/api/health      # shows <previous-sha>
```

A rollback does not undo database migrations. Every migration so far only adds tables or columns, so the previous
release runs against the newer schema. If the data itself must go back, restore the pre-release dump (below).

## Logs

- **PM2 logs:** `/home/daitcrm/.pm2/logs/crm-live-out.log`, `crm-live-error.log`, `crm-live-worker-out.log`,
  `crm-live-worker-error.log`, rotated by the `pm2-logrotate` module. Read them with
  `sudo -iu daitcrm pm2 logs crm-live --lines 100` (or `crm-live-worker`).
- The API writes one JSON line per request (Pino); query strings are stripped so OAuth codes never reach the log. The
  worker logs `worker: started`, job warnings and `worker: stopped`.
- **Web server:** OpenLiteSpeed's own logs for the vhost (CyberPanel → Websites → crm.daitpartners.com → Logs).
- **Background jobs:** Settings → Administration in the CRM shows queued and failed system-mailbox jobs.

## Health check

`GET /api/health` → `{"ok":true,"release":"<sha>"}` (no sign-in needed). From the server:
`curl -s http://127.0.0.1:3090/api/health`; from outside: `curl -s https://crm.daitpartners.com/api/health`.

## Backups

**Before every deploy:** the pre-release dump in step 1 above. The dumps made so far are in `/home/daitcrm/backups/`,
named `dait_crm-pre-<release>.dump` (for example `dait_crm-pre-release-2a.dump`, `dait_crm-pre-outreach-language.dump`,
`dait_crm-pre-release-2b1.dump`, `dait_crm-pre-release-2c.dump`).

**Daily:** `deploy/backup.sh` writes `pg_dump -Fc` dumps to `~/backups/<db>-<YYYYmmdd-HHMM>.dump`, deletes `.dump`
files older than 14 days (`BACKUP_KEEP_DAYS`; note this also removes old pre-release dumps), and copies the folder to
OneDrive with rclone if a remote named `onedrive-crm:` exists. It connects as a PostgreSQL login named like the database
unless `PGUSER` is set, with the password from `~/.pgpass` (mode 600, a line `localhost:5432:dait_crm:<user>:<password>`)
or `PGPASSWORD`. With no arguments it dumps `dait_crm` **and** `dait_crm_test`; since the test database does not exist,
always pass the database: `backup.sh dait_crm`. Cron line for `daitcrm` (`crontab -e`), daily at 02:30:

```
30 2 * * * PGUSER=<db-user> /home/daitcrm/live/current/deploy/backup.sh dait_crm >> /home/daitcrm/backups/backup.log 2>&1
```

**What actually runs (set up 23 Nov 2026, owner approved):** `deploy/backup.sh` above is NOT used on the server (no
`~/.pgpass`, no rclone). Instead a root-owned script `/usr/local/sbin/dait-crm-backup.sh`, run nightly at 02:30 server
time (UTC) by `/etc/cron.d/dait-crm-backup`, dumps `dait_crm` through the `postgres` user (peer auth, no password
stored) to `~/backups/dait_crm-daily-<YYYYmmdd-HHMM>.dump` (owner `daitcrm`, mode 640) and deletes daily dumps older
than 14 days; the hand-made `dait_crm-pre-*.dump` files are never deleted. Log: `/var/log/dait-crm-backup.log`. The
script is root-owned so the `daitcrm` user cannot change what root runs. Both files belong to the CRM only; remove them
to stop it. Every dump still sits on this one server — an off-server copy (e.g. rclone to OneDrive) needs the owner to
sign in once and is not set up. The database `dait_crm` is owned by the PostgreSQL role `dait_crm`. Check with
`tail /var/log/dait-crm-backup.log` and `ls -l /home/daitcrm/backups`.

## Restoring

Always rehearse in a scratch database first. All commands as root on the server; `<dump>` is the full path of a file in
`/home/daitcrm/backups/`. pg_restore reads the dump from standard input, which root's shell opens.

**1. Check the dump in a scratch database** (live is untouched):

```
sudo -u postgres createdb dait_crm_restore_check
sudo -u postgres pg_restore --no-owner -d dait_crm_restore_check < <dump>
sudo -u postgres psql -d dait_crm_restore_check -c "SELECT (SELECT count(*) FROM companies) AS companies, (SELECT count(*) FROM leads) AS leads, (SELECT max(finished_at) FROM _prisma_migrations) AS last_migration;"
sudo -u postgres dropdb dait_crm_restore_check
```

**2. Replace live with the dump** (only after the check, and with the owner's agreement; everything written since the
dump is lost from the live database, though it stays in the set-aside copy):

```
sudo -u postgres psql -Atc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'dait_crm';"   # the owner role, <db-owner>
sudo -iu daitcrm pm2 stop crm-live crm-live-worker
sudo -u postgres psql -c "ALTER DATABASE dait_crm RENAME TO dait_crm_before_restore_<YYYYmmdd>;"
sudo -u postgres createdb -O <db-owner> dait_crm
sudo -u postgres pg_restore -d dait_crm < <dump>
```

Restoring into a new, empty database (rather than `pg_restore --clean` over the old one) matters: tables added by a
newer migration would otherwise survive next to an older `_prisma_migrations` table and make the next deploy fail.
Without `--no-owner`, the restored objects keep their original owner (the app's role), so the app can use them.

Then make the code match the data: a pre-release dump has the schema of the release before it, so point `current` at
that release (see Rolling back) and start the apps:

```
sudo -iu daitcrm pm2 startOrReload ~/live/current/deploy/ecosystem.config.cjs --only crm-live,crm-live-worker --update-env
curl -s https://crm.daitpartners.com/api/health
```

When everything checks out, drop the set-aside copy: `sudo -u postgres dropdb dait_crm_before_restore_<YYYYmmdd>`.

## Claude Code engine (AI research)

AI research always uses the free Website reader. It can add Claude through the server's existing Claude Code CLI:

- Binary: `/root/.local/bin/claude` (Claude Code 2.1.311 on 23 Nov 2026), world-executable, so `daitcrm` can run it.
  The CRM never installs, updates or configures it (another app on the server uses it too); a different path can be
  given with `CLAUDE_BIN`.
- Login: `CLAUDE_CODE_OAUTH_TOKEN` in `~/live/shared/.env`, copied on 23 Nov 2026 from another app on this server with
  the owner's approval (backup of the file before the change: `.env.bak-pre-claude-token`). Root's own Claude login is
  expired; that does not matter, the CRM uses only the token.
- Optional: `CLAUDE_MODEL` (default `sonnet`).
- Each run spawns `claude -p` as `daitcrm` with only `HOME`, `PATH`, the token, a fresh empty temp folder and the
  auto-updater off; no tools unless the Web search source is on (then only `WebSearch`); 120 s per call; one run at a
  time (the worker's research lane).
- It is used only when the token is set, the binary is executable, and an Administrator has switched Claude Code on in
  a company's AI Intelligence tab → Enrichment engine with a monthly run cap above 0 (cap 0 = off). The engine card
  shows whether the token and binary were found.
- If the token expires, runs fail with "Claude Code is not logged in on the server": put a fresh token in the `.env`
  (back the file up first) and `pm2 reload crm-live crm-live-worker --update-env`.

Google Places is built but off: it needs `GOOGLE_PLACES_API_KEY` in the `.env` plus the switch and a monthly call cap.

## Creating a local administrator

`create-local-admin` creates (or updates) a user with the **Administrator** role and a local password. Use the
person's DAIT Partners Microsoft 365 email, so they can also sign in with Microsoft (users are matched by email). The
password works only while `LOCAL_ADMIN_LOGIN=1` is in the `.env`. As `daitcrm` (`-t` gives a terminal for the hidden
password prompt, at least 12 characters):

```
! ssh -t root@88.222.213.73 'sudo -iu daitcrm bash -lc "cd ~/live/current/apps/api && node --env-file=\$HOME/live/shared/.env dist/cli/create-local-admin.js --email you@daitpartners.com --name \"Your Name\""'
```

Or set `LOCAL_ADMIN_PASSWORD` for that one command instead of typing it. Running it again for the same email resets
the password. For a break-glass sign-in (Microsoft sign-in broken): add `LOCAL_ADMIN_LOGIN=1`, reload with
`--update-env`, sign in, then remove it and reload again.

## Release 5 (Import leads): checks and notes

- **Build:** `npm ci` on the server needs `cdn.sheetjs.com` reachable; the `xlsx` package is installed from its tarball
  there (not from the npm registry).
- **After the deploy:** upload one 20 MB file (Leads → Import leads) through OpenLiteSpeed on live, to confirm the proxy
  passes a body that size.
- **One lane:** file reads and imports share the worker's `import` lane. A 5,000-row import takes about 100 s (more on
  live), and other uploads wait at "Reading" until it finishes.
- **Rollback:** the `company_name_normalise` migration (number 20 on this branch, 21 after `email-reader-html`)
  rewrites the derived `companies.name_normalised` keys. A rolled-back release runs its older normaliser against the
  rewritten keys, so duplicate matching by company name is weaker until the next deploy; no data is lost. The few
  seconds between `migrate deploy` and the reload behave the same way.

## Web mail release 1: deploy runbook

Only after the owner says "deploy". Follow "Deploying a release to live" with these additions, in this order:

1. **Back up first** (step 1 above), named `dait_crm-pre-web-mail-r1.dump`. This dump is the only way back for the
   mail rows the clean-up removes.
2. **Check the migration state before installing** (after step 3, as `daitcrm` in `~/build/<sha>`; read only):

   ```
   node --env-file=$HOME/live/shared/.env node_modules/prisma/build/index.js migrate status --schema prisma/schema.prisma
   ```

   The only migration listed as not yet applied must be `20261212100000_web_mail_lead_only` (number 26); anything
   else (a failed or unknown migration, or 1–25 missing) means stop and ask. To rehearse it, restore the new dump into a
   scratch database (as "Check the dump in a scratch database" under Restoring) and run `migrate deploy` against that
   copy before installing.
3. **Install and check** (steps 4–5 above).
4. **Clean-up: dry run, owner sees the counts, then the real run** (details under "One-time steps after a release").
   Run it with `--dry-run` and send the owner the per-user `checked, kept, removed` counts (counts only). Run it for real
   only after the owner agrees. If it refuses because lead-delete audit entries record no addresses, do not add
   `--accept-unrecorded-deletes` unless the owner explicitly OKs it.
5. **Watch the backfill** with `mail-backfill.js --status` (see "One-time steps") until `queued` and `running` are 0
   (several hours). Look at `failed` and `skipped` rows; `--retry` queues them again.
6. **Check two Graph details once on live, while the backfill runs:**
   - **Paging past 250:** Outlook search used to stop at 250 results. Check that at least one address with a lot of mail
     shows `found` above 250 in the `--status` totals (or compare with the same search in Outlook). If no search goes
     past 250 although Outlook shows more, tell the developer before relying on long results.
   - **Date filter is UTC:** the search asks for `received>=` the date 12 months ago, written as a UTC date
     (`YYYY-MM-DD`). Compare one address's oldest stored message with Outlook: mail from the start day itself should be
     there. If Outlook reads the date in the mailbox's time zone instead, the edge moves by at most one day; note it for
     the developer (no action needed on live).
7. **After a mailbox reconnects:** a mailbox that needed reconnecting has its rows skipped (`mailbox_needs_reconnect`):
   run `mail-backfill.js --retry` after the reconnect. A mailbox connected for the first time after the release
   backfill was queued gets its 12-month search with `mail-backfill.js --mailbox <email account id>` (id from
   `SELECT id, address FROM email_accounts`).

## One-time steps after a release

All of these have already been run on live; they are kept for reference and for a rebuild.

- **Release 1C:** import of the 21 Nov 2026 prospects (`leads_pending_1C.csv`) with
  `apps/api/dist/cli/import-prospects-2026-11-21.js --file <csv> --owners "Deepak=<email>,Carlos=<email>"`, first with
  `--dry-run` (expected: rows 189, would create 178, already imported 0, skipped (owner) 11, unknown company 0,
  errors 0), then without it. Run from `~/live/current/apps/api` with `node --env-file=$HOME/live/shared/.env`. Running
  it again skips rows already imported.
- **Prototype parity:** none (its migration only adds nullable and defaulted contact columns).
- **Release 2C (Mailer):** fill empty company time zones from their addresses (only companies whose address resolves
  to one zone; safe to re-run): `cd ~/live/current/apps/api && node --env-file=$HOME/live/shared/.env
  dist/cli/fill-company-timezones.js`.
- **Outreach language:** the live allocation rules were set in Settings → Lead allocation rules ("Spanish market
  (Español)", any country + es → Carlos and Sebastian, priority 1; "English market (US and Canada)", US/CA + en →
  Deepak and Lakshita, priority 2).
- **Web mail release 1 — clean-up** (not yet run on live; run after the release is live, so sync no longer stores
  non-lead mail): remove the stored mail that is not lead mail, for every user. First
  `cd ~/live/current/apps/api && node --env-file=$HOME/live/shared/.env dist/cli/mail-cleanup.js --dry-run` and check
  the per-user counts (`checked, kept, removed`) look sane; it prints counts only, never subjects or addresses. Then run
  it again without `--dry-run`. Lead-linked mail, mail of deleted leads (marked, or found through the lead-delete audit
  entries), queued or sending mail, Mailer, quotation and project-tagged mail, and mail in a lead conversation are kept.
  If it refuses because lead-delete audit entries record no addresses (leads deleted on live before this release), the
  mail of those leads cannot be recognised: check with the owner, then add `--accept-unrecorded-deletes` to go ahead.
  Safe to run again (removes 0). The mail stays in Outlook; restoring the CRM copy means the pre-release dump.
- **Web mail release 1 — backfill** (nothing to start by hand): it starts by itself within a minute of the worker
  starting: one 12-month search per lead/contact address per connected mailbox (Sync mail on, active user), one short
  job every 10 s, so several hours. Watch it with
  `cd ~/live/current/apps/api && node --env-file=$HOME/live/shared/.env dist/cli/mail-backfill.js --status` (counts by
  status and per mailbox; mailbox addresses only) and `pm2 logs crm-live-worker --lines 50 | grep mail_backfill`. It
  is finished when `queued` and `running` are 0. `--retry` queues failed and skipped rows again (e.g. after a mailbox
  reconnect: rows of a mailbox that needed reconnecting are skipped with `mailbox_needs_reconnect`). A mailbox that was
  not connected when the release backfill was queued and is connected later gets the 12-month search for the existing
  addresses with `--mailbox <email account id>` (id from `SELECT id, address FROM email_accounts`). New leads and
  contacts are searched for the same way within a minute of being added. Check once on live that a long search
  continues past 250 results (an address with a lot of mail shows `found` above 250 in `--status` totals) before
  trusting long results (F6).

## Setting the server up from scratch (reference)

Needed only for a rebuild on a new server. As root: create the database login and database
(`sudo -u postgres psql -c "CREATE ROLE <db-user> LOGIN PASSWORD '<password>';"`,
`sudo -u postgres psql -c "CREATE DATABASE dait_crm OWNER <db-user>;"`); create the `daitcrm` user with Node 24 via nvm,
PM2 and its `pm2-daitcrm` systemd service (`pm2 startup`, `pm2 save`) and `pm2 install pm2-logrotate`; as `daitcrm`,
`mkdir -p ~/incoming ~/build ~/backups ~/live/{releases,shared/storage}`. DNS, the CyberPanel website, SSL and the
proxy config: `deploy/openlitespeed.md`. Write `~/live/shared/.env` (`umask 077`; values per `docs/ENVIRONMENT.md`;
generate `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` on the server with `openssl rand`). Deploy a release as above (the
first install has no previous release to fall back to: if its health check fails, `current` stays on it; read
`pm2 logs crm-live --lines 100`). Create the first administrator with `create-local-admin` and `LOCAL_ADMIN_LOGIN=1`,
have the Global Administrator follow `docs/setup/entra-app.md`, add the four `MS_*` values, reload, sign in with
Microsoft, connect the system mailbox in Settings, then remove `LOCAL_ADMIN_LOGIN`. Restore data from a dump if moving
an existing CRM (Restoring, step 2, into the new database).

## If you later want a test copy (not set up)

**None of this exists on the server today.** The release script, PM2 config and workflows already support a second
copy, as originally designed:

| | Test | Live |
|---|---|---|
| Hostname | crm-test.daitpartners.com (basic auth at the proxy) | crm.daitpartners.com |
| PM2 apps | `crm-test`, `crm-test-worker` | `crm-live`, `crm-live-worker` |
| Port | 3091 | 3090 |
| Folder | `~/test` | `~/live` |
| Database | `dait_crm_test` | `dait_crm` |
| Env file | `~/test/shared/.env` | `~/live/shared/.env` |

To set it up:

1. As root: `CREATE ROLE <test-db-user> LOGIN PASSWORD '<password>'` and `CREATE DATABASE dait_crm_test OWNER
   <test-db-user>` (as for live above). As `daitcrm`: `mkdir -p ~/test/{releases,shared/storage}`.
2. DNS, CyberPanel site, SSL and the test vhost with basic auth: `deploy/openlitespeed.md` (test sections).
3. `~/test/shared/.env` as for live but with the test database, `PUBLIC_URL=https://crm-test.daitpartners.com`,
   `MS_REDIRECT_URI=https://crm-test.daitpartners.com/api/auth/microsoft/callback` (also added as a redirect URI on the
   Entra app), and optionally `SEED_SAMPLE_USERS=1` (sample users, companies, contacts and locations; **never on live**)
   and `LOCAL_ADMIN_LOGIN=1`. Use different `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` values from live.
4. GitHub secrets (repo → Settings → Secrets and variables → Actions): `DEPLOY_HOST` (88.222.213.73), `DEPLOY_USER`
   (`daitcrm`), `DEPLOY_SSH_KEY` (private half of a key whose public half is in `daitcrm`'s `~/.ssh/authorized_keys`
   with `restrict`), `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 88.222.213.73`).
5. Deploy to test: Actions → "Deploy to test" → Run workflow with the full 40-character sha of a commit CI passed on. It
   builds on GitHub, packs only each workspace's `package.json` and `dist` (plus `node_modules`, `apps/api/assets`,
   `apps/web/dist`, `prisma`, `deploy`; see the workflow's tar list), uploads to `~/incoming/<sha>.tgz` and runs
   `release.sh install test` (health check on port 3091, same rollback). To make it automatic again, restore the
   `workflow_run` trigger on CI in `deploy-test.yml`.
6. Promote to live: Actions → "Deploy to live" → type `deploy-live` (optionally the expected sha). It runs
   `release.sh promote`, which copies exactly the release test runs into `~/live/releases/` and activates it with the
   same migrate, switch, health check and rollback. Nothing is rebuilt, so live runs the bytes that were tested.
7. Add `dait_crm_test` to the backup cron (`backup.sh dait_crm dait_crm_test`, with a `~/.pgpass` line for it).
