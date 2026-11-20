# Deployment

The CRM runs on 88.222.213.73 (AlmaLinux 9, CyberPanel, OpenLiteSpeed) as Linux user `daitcrm`, under PM2, behind OpenLiteSpeed.

| | Test | Live |
|---|---|---|
| Hostname | crm-test.daitpartners.com | crm.daitpartners.com |
| PM2 apps | `crm-test`, `crm-test-worker` | `crm-live`, `crm-live-worker` |
| Port | 3091 | 3090 |
| Folder | `~/test` | `~/live` |
| Database | `dait_crm_test` | `dait_crm` |
| Env file | `~/test/shared/.env` | `~/live/shared/.env` |

Each folder holds `releases/<sha>/`, `current` (symlink to the running release) and `shared/` (`.env`, `storage/`).

## How a release flows

1. Push to `main`: the **CI** workflow (`.github/workflows/ci.yml`) runs first: `npm ci`, typecheck and every test (unit, end-to-end, deploy script). Only when CI is green does `.github/workflows/deploy-test.yml` ("Deploy to test", triggered by `workflow_run` on CI) start; a red CI run deploys nothing. Deploy to test checks out exactly the commit CI tested, runs `npm ci`, the build, then `npm ci --omit=dev` (it does not re-run the tests) and packs one tarball: `package.json`, `package-lock.json`, `node_modules` (production only), `packages/shared`, `apps/api`, `apps/worker`, `apps/web/dist`, `prisma/`, `deploy/`. It uploads it to `~/incoming/<sha>.tgz` and runs `release.sh install test` (taken from the tarball itself, so the very first deploy works before `~/test/current` exists). GitHub only fires `workflow_run` for workflow files that are on the default branch, so the first deploy happens once `deploy-test.yml` is on `main`.
2. `deploy/release.sh install` unpacks to `~/test/releases/<sha>`, writes `RELEASE`, runs `prisma generate`, `prisma migrate deploy` and the compiled seed `dist/cli/seed.js` (lookup values only, idempotent; sample users only when `SEED_SAMPLE_USERS=1`, i.e. test), all through `node --env-file=~/test/shared/.env` (the env file is never sourced by the shell). If migrate or seed fails, nothing is switched and PM2 is not touched, switches `current`, runs `pm2 startOrReload ... --only crm-test,crm-test-worker --update-env`, and polls `http://127.0.0.1:3091/api/health` for `"ok":true` and the new `"release":"<sha>"` (30 tries, 1 s apart). If it never answers, `current` is switched back to the previous release, PM2 reloads it, and the job fails. The newest 5 releases are kept. Re-installing the sha that is already running is refused (exit 2) so the live release is never deleted.

   First deploy only: there is no previous release, so if the health check fails `current` stays on the broken release (the script says so). Inspect with `source ~/.nvm/nvm.sh && pm2 logs crm-test --lines 100`, fix the cause (usually a missing or wrong `.env` value), and push again.
3. When test looks right: GitHub, Actions, "Deploy to live", Run workflow, type `deploy-live` in `confirm` (optionally the `sha` you expect). It runs `release.sh promote` on the server, which copies exactly what test runs into `~/live/releases/` and activates it the same way (same health check, same rollback). Nothing is rebuilt, so live runs the bytes you tested.

Design choices: production `node_modules` ship in the tarball so the server never runs `npm ci`. Prisma's client is generated on the server by `release.sh` (the `prisma` CLI is a production dependency of `apps/api` for that reason) because the query engine must match the server's OS (RHEL-family), not the GitHub runner's Ubuntu. Migrations run before the switch; write them backward-compatible so a rollback of the code still works against the migrated database.

## Environment variables

Set in `~/<env>/shared/.env` (mode 600, `KEY=value`, one per line; quote values containing spaces or `#`). PM2 loads the file with `node --env-file`. Never commit it.

| Name | Meaning | How to get it |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://<user>:<password>@localhost:5432/dait_crm` (live) or `dait_crm_test` (test); percent-encode special characters in the password |
| `PUBLIC_URL` | Public origin, e.g. `https://crm.daitpartners.com`; `https://` turns on Secure cookies | Hostname of the site |
| `SESSION_SECRET` | Signs auth cookies. Required when `NODE_ENV=production` | `openssl rand -hex 32` |
| `TOKEN_ENCRYPTION_KEY` | Encrypts stored mailbox refresh tokens (AES-256-GCM). Changing it disconnects every mailbox | `openssl rand -base64 32` |
| `MS_TENANT_ID` | Microsoft Entra directory (tenant) ID | From the Entra app, see below |
| `MS_CLIENT_ID` | Entra application (client) ID | From the Entra app |
| `MS_CLIENT_SECRET` | Entra client secret value | From the Entra app |
| `MS_REDIRECT_URI` | `<PUBLIC_URL>/api/auth/microsoft/callback` | Must match the Entra redirect URI exactly |
| `LOCAL_ADMIN_LOGIN` | `1` enables the break-glass local-admin password login | Test: `1` until Microsoft sign-in works; live: leave unset unless needed |
| `HOST` | Interface the API listens on; default `127.0.0.1` (loopback only, reached through OpenLiteSpeed) | Leave unset: PM2 already sets `127.0.0.1`. Never `0.0.0.0` on the server |
| `SEED_SAMPLE_USERS` | `1` makes the seed create sample users | Test only; never on live |

Not set by hand (PM2 sets them in `deploy/ecosystem.config.cjs`): `NODE_ENV=production`, `PORT` (3090 live, 3091 test), `HOST` (`127.0.0.1`: the API listens on loopback only, OpenLiteSpeed is the only way in; the default is also `127.0.0.1` when unset), `WEB_DIST` (the release's `apps/web/dist`), `RELEASE` (the release's sha, from its `RELEASE` file).

**`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and `MS_REDIRECT_URI` are all-or-none.** Leave all four empty (Microsoft sign-in off) or fill all four; the app fails fast at start if only some are set, and PM2 then shows the app crashing.

**Why `NODE_ENV=production` matters:** it makes `SESSION_SECRET` mandatory (the app refuses to start without it) and disables the passwordless `TEST_LOGIN`, so a production host cannot be signed into by accident. Never set `TEST_LOGIN` on the server.

## First deployment checklist

Commands marked `!` run in your terminal. Replace the angle-bracket parts; generate secrets on the server so they never travel through chat.

**Remote commands and Node:** a non-interactive `ssh host 'command'` does not load nvm, so `node` and `pm2` are not found. Prefix such commands with `source ~/.nvm/nvm.sh &&` (the examples below do). In an interactive `ssh daitcrm@...` session nvm is already loaded.

0. Prerequisites on the server (already done on 88.222.213.73; needed again for a rebuild). As root (or a sudoer):

   ```
   ! ssh root@88.222.213.73
   sudo -u postgres psql -c "CREATE ROLE crm_live LOGIN PASSWORD '<live-db-password>';"
   sudo -u postgres psql -c "CREATE DATABASE dait_crm OWNER crm_live;"
   sudo -u postgres psql -c "CREATE ROLE crm_test LOGIN PASSWORD '<test-db-password>';"
   sudo -u postgres psql -c "CREATE DATABASE dait_crm_test OWNER crm_test;"
   ```

   Then as `daitcrm`:

   ```
   mkdir -p ~/incoming ~/backups ~/test/{releases,shared/storage} ~/live/{releases,shared/storage}
   ```

   Also needed: Node 24 via nvm, PM2 with the `pm2-daitcrm` systemd service (`pm2 startup`, `pm2 save`), and the deploy public key in `~/.ssh/authorized_keys` with `restrict`. The database logins `crm_live` and `crm_test` are example names; use whatever you created in `DATABASE_URL` and as `PGUSER` for backups. Lookup values (statuses, countries and so on) are seeded by the release script on every deploy; there is no separate seed step.

1. DNS and sites: follow `deploy/openlitespeed.md` steps 1 and 2 (Cloudflare A records, CyberPanel sites, SSL). Do step 3 (proxy config) once the first release is deployed, or now; a 503 until then is normal.
2. Env files. Log in as `daitcrm` and create the two files (the folders already exist):

   ```
   ! ssh daitcrm@88.222.213.73
   ```

   then, on the server (shows the pattern for test; repeat for live with `~/live`, `dait_crm`, port-less values, and without `SEED_SAMPLE_USERS`):

   ```
   umask 077
   cat > ~/test/shared/.env <<EOF
   DATABASE_URL=postgresql://<db-user>:<db-password>@localhost:5432/dait_crm_test
   PUBLIC_URL=https://crm-test.daitpartners.com
   SESSION_SECRET=$(openssl rand -hex 32)
   TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
   LOCAL_ADMIN_LOGIN=1
   SEED_SAMPLE_USERS=1
   EOF
   chmod 600 ~/test/shared/.env
   ```

   Edit the `<...>` values with `nano ~/test/shared/.env`. The four `MS_*` keys stay out until step 9.
3. GitHub secrets (repo, Settings, Secrets and variables, Actions): `DEPLOY_HOST` (88.222.213.73), `DEPLOY_USER` (`daitcrm`), `DEPLOY_SSH_KEY` (the private half of the key whose public half is in `~/.ssh/authorized_keys` with `restrict`), `DEPLOY_KNOWN_HOSTS` (output of `! ssh-keyscan -t ed25519 88.222.213.73`).
4. Push to `main` and watch the Actions tab: "CI" runs first, and "Deploy to test" starts only after CI succeeds. The deploy run must end with "test is now running <sha>". If CI fails, nothing is deployed; fix it and push again.
5. Check on the server (`! ssh daitcrm@88.222.213.73 'source ~/.nvm/nvm.sh && pm2 status && curl -s http://127.0.0.1:3091/api/health'`): `pm2 status` shows `crm-test` and `crm-test-worker` online; the health call shows `{"ok":true,"release":"<sha>"}`.
6. Create the first administrator on the server (see the next section), then sign in at https://crm-test.daitpartners.com with that email and password.
7. In the CRM, add the other users.
8. Entra: hand `docs/setup/entra-app.md` to the Microsoft 365 Global Administrator. They return the tenant ID, client ID, client secret value and confirm the two redirect URIs; paste them on the server, never into chat.
9. Add `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and `MS_REDIRECT_URI` (`https://crm-test.daitpartners.com/api/auth/microsoft/callback`) to `~/test/shared/.env`, then `source ~/.nvm/nvm.sh && pm2 reload crm-test crm-test-worker --update-env`. Sign in with Microsoft, then connect the system mailbox in the CRM's mailbox settings.
10. Repeat steps 2 and 9 for live (`~/live/shared/.env`, `dait_crm`, `https://crm.daitpartners.com`), run the "Deploy to live" workflow, create the live administrator, and set up the cron backup below.

## Creating a local administrator

On the server (the script is compiled; it needs no tsx). `-t` lets it ask for the password (at least 12 characters), which is not echoed into the shell history:

```
! ssh -t daitcrm@88.222.213.73 'source ~/.nvm/nvm.sh && cd ~/test/current/apps/api && node --env-file=$HOME/test/shared/.env dist/cli/create-local-admin.js --email you@daitpartners.com --name "Your Name"'
```

Use `~/live/...` for live. Running it again for the same email resets that user's password. Local login only works while `LOCAL_ADMIN_LOGIN=1` in that environment's `.env`.

## Day to day

- On the server over non-interactive SSH, start every command with `source ~/.nvm/nvm.sh &&` so `node` and `pm2` are found.
- Logs: `pm2 logs crm-test`, `pm2 logs crm-test-worker` (same with `live`); `pm2 status`. PM2 starts at boot through the `pm2-daitcrm` systemd service.
- Current release: `curl -s http://127.0.0.1:3091/api/health` (3090 for live), or `cat ~/test/current/RELEASE`.
- Rollback by hand (the script already does this when a new release fails its health check):

  ```
  source ~/.nvm/nvm.sh
  ls ~/live/releases
  ln -sfn ~/live/releases/<previous-sha> ~/live/current
  pm2 startOrReload ~/live/current/deploy/ecosystem.config.cjs --only crm-live,crm-live-worker --update-env
  ```

  A rollback does not undo database migrations.

## Backups

`deploy/backup.sh` writes `pg_dump -Fc` dumps of `dait_crm` and `dait_crm_test` to `~/backups/<db>-<YYYYmmdd-HHMM>.dump`, deletes dumps older than 14 days, and, only if `rclone listremotes` includes `onedrive-crm:`, runs `rclone copy ~/backups onedrive-crm:DAIT-CRM-backups`. It connects as a PostgreSQL user named like the database (override with `PGUSER`); give it the password with `PGPASSWORD` or, better, a `~/.pgpass` file (`chmod 600`) with one line per database: `localhost:5432:<db>:<user>:<password>`. Choose databases with arguments: `backup.sh dait_crm`.

Cron (as `daitcrm`, `crontab -e`), daily at 02:30:

```
30 2 * * * /home/daitcrm/live/current/deploy/backup.sh >> /home/daitcrm/backups/backup.log 2>&1
```

Test it once by hand: `bash ~/live/current/deploy/backup.sh`, then check `ls -l ~/backups`.

Restore (replaces the database's contents; stop the apps first, and prefer restoring into `dait_crm_test` to rehearse):

```
source ~/.nvm/nvm.sh
pm2 stop crm-live crm-live-worker
pg_restore -Fc --clean --if-exists --no-owner -h localhost -U <db-user> -d dait_crm ~/backups/dait_crm-<stamp>.dump
pm2 start crm-live crm-live-worker
```
