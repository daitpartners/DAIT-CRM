# Environment variables

Every environment variable the CRM's code, deploy scripts and tests read (checked against `apps/api/src`, `apps/worker`,
`packages/shared`, `prisma/`, `deploy/` and the test configs on 23 Nov 2026). This file holds names and meanings only.
Never write a real value into the repository, a ticket or a chat.

## Where they live

- **Live:** `/home/daitcrm/live/shared/.env` (owner `daitcrm`, mode 600, one `KEY=value` per line; quote a value with
  spaces or `#`). PM2 starts both processes with `node --env-file=<that file>` (`deploy/ecosystem.config.cjs`), and
  `deploy/release.sh` runs `prisma migrate deploy` and the seed the same way. The shell never sources the file.
- After changing it: `sudo -iu daitcrm pm2 reload crm-live crm-live-worker --update-env` (both processes read it; the
  API and the worker each need the Microsoft, token and Claude values).
- Back up the file before editing (`cp .env .env.bak-<reason>`); the 23 Nov Claude change left `.env.bak-pre-claude-token`.

## Set by hand in `shared/.env`

| Name | Required? | Default | Purpose | Live / test |
|---|---|---|---|---|
| `DATABASE_URL` | Required | none | PostgreSQL connection string, e.g. `postgresql://<user>:<password>@localhost:5432/dait_crm`. Read by Prisma (`prisma/schema.prisma`). Percent-encode special characters in the password. | Both (test would use `dait_crm_test`) |
| `PUBLIC_URL` | Required when `NODE_ENV=production` | empty | The site's `https://` origin (`https://crm.daitpartners.com`). The API refuses to start in production without an `https://` value. Turns on Secure cookies; every browser POST / PUT / PATCH / DELETE must come from exactly this origin (CSRF guard in `apps/api/src/app.ts`). | Both |
| `SESSION_SECRET` | Required when `NODE_ENV=production` | random per start (development only) | Cookie-signing secret, at least 32 characters (`openssl rand -hex 32`). It signs the short-lived Microsoft sign-in state cookie; sessions themselves are random ids stored in the `sessions` table. Changing it only breaks sign-ins that are in progress at that moment. | Both |
| `TOKEN_ENCRYPTION_KEY` | Required once any mailbox is connected | none | 32 random bytes, base64 (`openssl rand -base64 32`). AES-256-GCM key for stored mailbox refresh tokens (`apps/api/src/crypto/tokens.ts`). If it changes, every stored token becomes unreadable (`token_unreadable`): every mailbox, system and personal, must be disconnected and reconnected. | Both |
| `MS_TENANT_ID` | All four or none | none | Microsoft Entra directory (tenant) ID. | Both |
| `MS_CLIENT_ID` | All four or none | none | Entra application (client) ID. When set, Microsoft sign-in is on and the other three must be set too, or the API fails at start. | Both |
| `MS_CLIENT_SECRET` | All four or none | none | Entra client secret value (it expires; see `docs/setup/entra-app.md`). | Both |
| `MS_REDIRECT_URI` | All four or none | none | `<PUBLIC_URL>/api/auth/microsoft/callback`; must match the Entra redirect URI exactly. | Both |
| `LOCAL_ADMIN_LOGIN` | Optional | off | `1` enables the break-glass local-administrator password sign-in (users made with `create-local-admin`). On live it should be off once everyone signs in with Microsoft; set it only for an emergency, then remove it and reload. | Both; live: remove when no longer needed |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional | none | Claude Code subscription token. With it, an executable `claude` binary, the Administrator switch on and a monthly run cap above 0, AI research adds Claude (intelligence fields, optional web search). Passed only to the `claude` child process, never logged; errors are scrubbed of it. Copied on 23 Nov 2026 from another app on the same server, with the owner's approval. | Live (set) |
| `CLAUDE_BIN` | Optional | `/root/.local/bin/claude` | Path of the server's existing Claude Code CLI (2.1.311 on 23 Nov 2026). The CRM never installs or updates it; it must be executable by `daitcrm`. | Live |
| `CLAUDE_MODEL` | Optional | `sonnet` | Claude Code model alias passed as `--model`; recorded on each run's engine line. | Live |
| `GOOGLE_PLACES_API_KEY` | Optional | none | Google Places API (New) key. With it, the Administrator switch on and a monthly call cap above 0, research also calls Place Details. Not set on live (paid; owner's choice). | Live (not set) |
| `SEED_SAMPLE_USERS` | Test only | off | `1` makes the seed (run by `release.sh` on every deploy) create sample users, companies, contacts and locations. **Never on live.** | Test only |

## Set by PM2 (`deploy/ecosystem.config.cjs`), not by hand

| Name | Value on live | Purpose |
|---|---|---|
| `NODE_ENV` | `production` | Makes `SESSION_SECRET` and an `https://` `PUBLIC_URL` mandatory and disables `TEST_LOGIN`. |
| `PORT` | `3090` (API only) | Port the API listens on; code default 3090. |
| `HOST` | `127.0.0.1` (API only) | Interface the API listens on; code default `127.0.0.1`. Never `0.0.0.0`: OpenLiteSpeed is the only way in. |
| `WEB_DIST` | `<release>/apps/web/dist` | When set, the API also serves the built web app (and `index.html` for unknown non-API paths). |
| `RELEASE` | the release's sha (from its `RELEASE` file) | Reported by `GET /api/health`; `dev` when unset. `release.sh` waits for it to show the new sha. |

## One-off commands

| Name | Read by | Purpose |
|---|---|---|
| `LOCAL_ADMIN_PASSWORD` | `apps/api/dist/cli/create-local-admin.js` | The password to set, instead of typing it at the prompt (for example from a password manager's CLI). Set it for that one command only. |

## Deploy and backup scripts

| Name | Read by | Default | Purpose |
|---|---|---|---|
| `RELEASE_ROOT` | `deploy/release.sh`, `deploy/ecosystem.config.cjs` | `/home/daitcrm` | Base folder; only the script tests (`deploy/test/release.test.sh`) change it. |
| `HEALTH_TRIES` | `deploy/release.sh` | `30` | Health-check attempts after a switch. |
| `HEALTH_WAIT` | `deploy/release.sh` | `1` | Seconds between attempts. |
| `BACKUP_DIR` | `deploy/backup.sh` | `~/backups` | Where dumps are written. |
| `BACKUP_HOST` | `deploy/backup.sh` | `localhost` | PostgreSQL host. |
| `BACKUP_KEEP_DAYS` | `deploy/backup.sh` | `14` | Dumps older than this are deleted. |
| `PGUSER` | `deploy/backup.sh` (via `pg_dump`) | the database name | PostgreSQL login for the dump. |
| `PGPASSWORD` | `pg_dump` | none | Password, if no `~/.pgpass` file is used (prefer `~/.pgpass`, mode 600). |

GitHub Actions secrets used by the (currently manual, test-copy) deploy workflows: `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`. They are not used by the manual live deploy in `docs/DEPLOYMENT.md`.

## Development and tests only (never on the server)

| Name | Read by | Purpose |
|---|---|---|
| `TEST_LOGIN` | `apps/api/src/app.ts` | `1` enables the passwordless test sign-in used by the unit and end-to-end tests. Ignored when `NODE_ENV=production`. |
| `RESEARCH_TEST_ALLOW_HOSTS` | `apps/api/src/research/safeFetch.ts` | Comma-separated hosts the website reader may fetch although private (the e2e fixture site on `127.0.0.1`). Honoured only when `NODE_ENV` is `test` or `e2e`. |
| `E2E_DATABASE_URL` | `apps/web/e2e/start-server.sh` | Database for the end-to-end run (default `postgresql://mac@localhost:5432/dait_crm_e2e`). |
| `DATABASE_URL` (tests) | `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`, `apps/api/test/global-setup.ts` | Unit-test database (default `postgresql://mac@localhost:5432/dait_crm_unit`). |
| `CI` | `apps/web/playwright.config.ts` | Adds the HTML report on GitHub Actions. |

The test configs set fixed, test-only `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` values; they are not secrets and are
never used outside tests.

## What the Claude child process gets

The research worker starts `claude -p` with only `HOME`, `PATH=/usr/bin:/bin`, `CLAUDE_CODE_OAUTH_TOKEN`, `TMPDIR` (a
fresh empty temp folder) and `DISABLE_AUTOUPDATER=1` (`apps/api/src/research/providers.ts`). It never receives
`DATABASE_URL` or any other CRM secret.
