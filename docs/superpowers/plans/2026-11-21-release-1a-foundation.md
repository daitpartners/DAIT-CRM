# Release 1A — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable CRM skeleton on the test site: monorepo, PostgreSQL schema for users/config/jobs, Microsoft sign-in, roles, Settings (users, dropdown values, allocation rules, preferences), the app shell in the approved brand, system-mailbox email via Graph, worker, audit log, CI and deploy. Later plans (1B Companies & Contacts, 1C Leads & Tasks, 1D Enquiries & public form, 1E Dashboard/Reports/polish) add the business modules on top.

**Architecture:** npm workspaces: `packages/shared` (types, Zod schemas, roles, lookup groups, i18n helpers), `apps/api` (Fastify 5 + Prisma 6 on PostgreSQL; serves `/api/*` and the built web app), `apps/worker` (same codebase, polls a `jobs` table), `apps/web` (React 18 + Vite + TypeScript, the prototype's stylesheet ported). Sessions are server-side rows referenced by an httpOnly cookie. Every rule is enforced in the API; the web only renders.

**Tech Stack:** Node 24, TypeScript 5.9, Fastify 5.12, @fastify/cookie 11, @fastify/rate-limit 10, @fastify/static 8, Prisma 6.19.3, Zod 3.25, @azure/msal-node 3.8, pino (Fastify's logger), React 18.3, Vite 7.3, React Router 7, TanStack Query 5, Vitest 3, Playwright 1.65, GitHub Actions, PM2.

**Spec:** `docs/superpowers/specs/2026-11-21-dait-crm-fresh-build-design.md` (sections 3, 5, 7, 8). Companion: `docs/DAIT-CRM-Specification-v2.md` §2, §3, §13, §14; `docs/data-model.md` "Shared / configuration"; prototype `js/data.js` (users, config), `css/app.css`, `js/app.js` (sidebar), `js/ui.js` (`enhanceSelects`, toast, modal); `docs/setup/entra-app.md`.

## Global Constraints

- Node `>=24`; every new npm dependency pinned to an exact version published ≥ 14 days before the task adds it (check with `npm view <pkg> time`). The versions listed in Tech Stack are known to satisfy this.
- Brand tokens verbatim from spec §3: ink `#1F0249`, purple `#6811CF`, purple-light `#812BE1`, orange `#BA5425`, orange-dark `#AB4C21`, peach `#F09044`, background `#F5F1FC`, primary-action gradient `#BA5326 → #822CDB`; Montserrat 400/500/600/700/800 from Google Fonts.
- Roles, exactly these labels: `Administrator`, `Manager`, `Sales Representative`, `Data Research User`.
- Languages `en` (default), `es`, `fr`; UI strings keyed by the English phrase in `apps/web/src/locales/{en,es,fr}.json`.
- Every dropdown with ≥ 8 options is the shared searchable combobox (`role="combobox"` + listbox, type to filter, arrows, Enter, Escape).
- Every rendered value is escaped (React default; never `dangerouslySetInnerHTML`). URLs rendered as links only if scheme is http, https, mailto or tel (`safeUrl` in shared).
- Secrets only in `.env` files (gitignored) and `/home/daitcrm/<env>/shared/.env` on the server. Nothing secret in the repo, logs or browser.
- `npm test` at the root runs shared + API Vitest (database `dait_crm_unit`) + Playwright (database `dait_crm_e2e`); all green before every commit that claims a task done.
- Ports: API dev 3090, test site 3091 on the server, live 3090 on the server. Test database on the server `dait_crm_test`, live `dait_crm`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Test-only sign-in (`TEST_LOGIN=1`) and the local admin (`LOCAL_ADMIN_LOGIN=1`) must refuse to work when `NODE_ENV=production` unless the flag is explicitly set in that environment's `.env`; `TEST_LOGIN` is never set on the server.

## Review Focus

1. A Microsoft account that exists in the tenant but has not been added under Settings → Users must be refused with a clear page, not a 500 and not an auto-created user. (Task 4 test `rejects unknown microsoft identity`.)
2. A deactivated user with a live session must be locked out on the next request, not at next sign-in. (Task 4 test `deactivated user loses session`.)
3. Session cookie must be `HttpOnly; Secure; SameSite=Lax` in production and survive an API restart (rows, not memory). (Task 4 test `session survives restart` using a second Fastify instance.)
4. Lookup value deactivation must not delete history: records referencing a deactivated value still render it; forms no longer offer it. (Task 6 test `inactive value hidden from options but readable`.)
5. A Graph send that fails (expired token, 429) must retry with backoff and surface as "pending/failed" on the Administration page, never be silently dropped. (Task 8 tests `retries with backoff` and `marks failed after max attempts`.)

---

### Task 1: Monorepo scaffold, CI, prototype moved aside

**Files:**
- Create: `package.json` (root), `tsconfig.base.json`, `.nvmrc` (`24`), `.env.example`, `.gitignore` (add `.env`, `dist/`, `node_modules/`, `apps/api/uploads/`, `test-results/`, `playwright-report/`)
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts,src/roles.ts,src/safeUrl.ts,test/safeUrl.test.ts}`
- Create: `apps/api/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,src/server.ts,src/app.ts,src/routes/health.ts,test/health.test.ts}`
- Create: `apps/worker/{package.json,tsconfig.json,src/main.ts}` (logs "worker idle" every 30 s for now)
- Create: `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.tsx,src/App.tsx}`
- Create: `.github/workflows/ci.yml`
- Move: `index.html, css/, js/, assets/, public/, build.py, dait-crm.html, contact-form.html, screenshots/` → `prototype/` (git mv; fix `build.py` ROOT stays relative so it still works inside `prototype/`)
- Modify: `README.md` (new top section: what the repo is, how to run; keep the prototype section under "Prototype (reference)")

**Interfaces:**
- Produces: `packages/shared` exports `ROLES: readonly ['Administrator','Manager','Sales Representative','Data Research User']`, `type Role = typeof ROLES[number]`, `safeUrl(input: string | null | undefined): string | null` (returns the trimmed URL if scheme ∈ {http, https, mailto, tel}, else null; bare `example.com` → `https://example.com`).
- Produces: `apps/api/src/app.ts` exports `buildApp(opts?: { logger?: boolean }): Promise<FastifyInstance>`; `GET /api/health` → `{ ok: true, release: string }` where release is `process.env.RELEASE ?? 'dev'`.
- Produces: root scripts `build`, `test`, `typecheck`, `db:migrate`, `db:seed`, with `pretest`/`pretypecheck`/`prebuild` building `packages/shared` first (as Version 1 did).

- [ ] **Step 1: `git mv` the prototype files into `prototype/`, run `python3 prototype/build.py`, confirm it still prints `built dait-crm.html` and the two output files are byte-identical to the moved ones. Commit `chore: move prototype under prototype/`.**
- [ ] **Step 2: Write `packages/shared/test/safeUrl.test.ts`:**

```ts
import { safeUrl } from '../src/safeUrl';
test.each([
  ['https://a.com/x', 'https://a.com/x'], ['http://a.com', 'http://a.com'], ['mailto:x@a.com', 'mailto:x@a.com'],
  ['tel:+441234', 'tel:+441234'], ['  example.com ', 'https://example.com'], ['javascript:alert(1)', null],
  ['data:text/html,x', null], ['', null], [null, null],
])('safeUrl(%j) -> %j', (i, o) => expect(safeUrl(i as any)).toBe(o));
```
- [ ] **Step 3: Run `npm test -w packages/shared`, expect FAIL (module missing).**
- [ ] **Step 4: Implement `safeUrl` and `roles.ts`; shared builds to `dist/` with `tsc`.**
- [ ] **Step 5: Run shared tests, expect 9 PASS.**
- [ ] **Step 6: Write `apps/api/test/health.test.ts`: `buildApp()` then `inject GET /api/health` → 200, body `{ ok: true, release: 'dev' }`. Run, expect FAIL. Implement `app.ts` (registers `@fastify/cookie`, routes under `/api`) and `server.ts` (listens on `PORT`, serves `WEB_DIST` with `@fastify/static` when set, SPA fallback to `index.html` for non-`/api` GETs). Run, expect PASS.**
- [ ] **Step 7: `apps/web`: Vite React app that renders `<h1>DAIT Partners CRM</h1>`; `npm run build -w apps/web` produces `apps/web/dist/index.html`. Vite dev proxy `/api` → `http://localhost:3090`.**
- [ ] **Step 8: `.github/workflows/ci.yml`: on push/PR, Node 24, PostgreSQL 16 service, `npm ci`, `npm run typecheck`, `npm test` (Playwright step added in Task 10; leave a commented placeholder).**
- [ ] **Step 9: Root `npm test` green; `npm run build` green. Commit `feat: monorepo scaffold with shared, api, worker, web and CI`.**

---

### Task 2: Database schema (foundation tables), migrations, seed

**Files:**
- Create: `prisma/schema.prisma`, `prisma/migrations/<ts>_foundation/migration.sql` (generated), `prisma/seed.ts`, `prisma/seed-data/lookups.ts`
- Create: `apps/api/src/db.ts` (Prisma client singleton), `apps/api/test/helpers.ts` (`resetDb()` truncates all tables; `seedLookups()`), `apps/api/test/global-setup.ts` (runs `prisma migrate deploy` against `DATABASE_URL` = `postgresql://localhost/dait_crm_unit`)
- Modify: `apps/api/package.json` (prisma config pointing at `../../prisma/schema.prisma`, seed via `tsx`), `apps/api/vitest.config.ts` (globalSetup, `fileParallelism: false`)

**Interfaces:**
- Produces Prisma models (snake_case tables via `@@map`, columns via `@map`):
  - `User { id Int @id autoincrement; email String @unique (lowercased); name String; role Role enum(ADMINISTRATOR, MANAGER, SALES_REPRESENTATIVE, DATA_RESEARCH_USER); language String @default("en"); timezone String @default("Europe/London"); dateFormat String @default("DD MMM YYYY"); isActive Boolean @default(true); microsoftOid String? @unique; lastLoginAt DateTime?; createdAt; updatedAt }`
  - `Session { id String @id (random 32 bytes base64url); userId Int FK; expiresAt DateTime; createdAt; lastSeenAt }` index on `expiresAt`
  - `LookupValue { id Int; group String; value String; label String; labelEs String?; labelFr String?; sortOrder Int; isActive Boolean @default(true) } @@unique([group, value])`
  - `AllocationRule { id Int; name String; matchCountries Json (string[] or ["*"]); assignTo Json (number | number[]); roundRobinPos Int @default(0); priority Int; isActive Boolean @default(true) }`
  - `EmailAccount { id Int; userId Int? FK; address String @unique; provider String ("microsoft"); kind String ("user" | "system"); refreshTokenEnc String; tokenExpiresAt DateTime?; status String ("connected"|"error"); lastError String?; createdAt; updatedAt }`
  - `Job { id Int; type String; payload Json; runAt DateTime; attempts Int @default(0); maxAttempts Int @default(8); status String ("queued"|"running"|"done"|"failed"); lastError String?; lockedAt DateTime?; createdAt; updatedAt }` index on `(status, runAt)`
  - `Notification { id Int; userId Int FK; text String; detail String?; link String?; isRead Boolean @default(false); createdAt }` index `(userId, isRead)`
  - `AuditLog { id Int; entityType String; entityId String; action String ("create"|"update"|"delete"|"merge"|"verify"); userId Int? FK; before Json?; after Json?; at DateTime @default(now()) }` index `(entityType, entityId)`
- Role mapping helper in shared: `roleLabel(r: RoleEnum): Role` and `roleEnum(label: Role): RoleEnum` (DB enum ↔ display label).
- Seed: lookup groups and values copied exactly from `prototype/js/data.js` `config` (`lead_source`, `lead_status`, `lead_type`, `priority`, `country`, `industry`, `business_category`, `business_type`, `employee_range`, `revenue_range`, `ownership_type`, `contact_type`, `location_type`, `quote_status`, `currency`), `sortOrder` = array index. Spanish/French labels for `lead_status`, `priority`, `lead_type`, `contact_type` filled in (builder translates; others null). Seeding is idempotent (upsert on `(group, value)`). The four prototype users are seeded **only when `SEED_SAMPLE_USERS=1`** (used on the test site and in e2e), never by default.

- [ ] **Step 1: Write `apps/api/test/db.test.ts`: after `resetDb(); seedLookups()`, `prisma.lookupValue.count({ where: { group: 'lead_status' } })` is 10 and the first by sortOrder has value `New`; `prisma.user.count()` is 0; running `seedLookups()` twice leaves the counts unchanged. Run, expect FAIL.**
- [ ] **Step 2: Write `schema.prisma` as above; `npx prisma migrate dev --name foundation` against `dait_crm_unit`; write `seed.ts`.**
- [ ] **Step 3: Run API tests, expect PASS. Commit `feat(db): foundation schema, migrations and lookup seed`.**

---

### Task 3: Shared validation, rights and i18n helpers

**Files:**
- Create: `packages/shared/src/schemas/user.ts`, `src/schemas/lookup.ts`, `src/schemas/allocation.ts`, `src/rights.ts`, `src/i18n.ts`, tests in `packages/shared/test/`

**Interfaces:**
- Produces Zod schemas: `UserCreate { email: email lowercased, name: 1..120, role: Role, language: 'en'|'es'|'fr' = 'en', timezone: IANA string = 'Europe/London' }`, `UserUpdate = UserCreate.partial() + { isActive?: boolean }`, `PreferencesUpdate { language, timezone, dateFormat: 'DD MMM YYYY'|'DD/MM/YYYY'|'MM/DD/YYYY' }`, `LookupValueCreate { group: one of the 15 group names, value: 1..100, label: 1..100, labelEs?, labelFr?, sortOrder?: int }`, `LookupValueUpdate`, `AllocationRuleCreate { name 1..100, matchCountries: string[] nonempty | ['*'], assignTo: number | number[] nonempty, priority: int ≥ 0 }`.
- Produces `rights.ts`: `can(role: Role, action: Action): boolean` with `Action = 'manage_users' | 'manage_lookups' | 'manage_allocation' | 'view_all_leads' | 'transfer_leads' | 'manage_quotes' | 'use_email' | 'manage_prospects' | 'view_admin_settings'`. Matrix from design §5: Administrator all; Manager all except `manage_users`, `manage_lookups`; Sales Representative `use_email`, `manage_quotes` only; Data Research User `manage_prospects` only.
- Produces `i18n.ts`: `t(dict: Record<string,string>, phrase: string, vars?: Record<string, string|number>): string` (returns the phrase itself when missing; `{name}` interpolation), `formatDate(d: Date|string, opts: { locale: 'en'|'es'|'fr', timezone: string, dateFormat: string }): string`, `lookupLabel(v: { label: string; labelEs?: string|null; labelFr?: string|null }, lang): string` (falls back to `label`).

- [ ] **Step 1: Write tests: `can('Manager','manage_users')` false, `can('Administrator','manage_users')` true, `can('Sales Representative','view_all_leads')` false, `can('Data Research User','manage_prospects')` true; `UserCreate.parse({ email: ' A@B.com ', name: 'A', role: 'Manager' }).email === 'a@b.com'`; `AllocationRuleCreate` rejects `matchCountries: []` and `assignTo: []`; `t({ 'Hello {name}': 'Hola {name}' }, 'Hello {name}', { name: 'Ana' }) === 'Hola Ana'`; `formatDate('2026-11-21T10:00:00Z', { locale:'en', timezone:'Asia/Kolkata', dateFormat:'DD MMM YYYY' }) === '21 Nov 2026'`; `lookupLabel({label:'New', labelEs:'Nuevo'}, 'fr') === 'New'`. Run, expect FAIL.**
- [ ] **Step 2: Implement. Run shared tests, expect PASS. Commit `feat(shared): schemas, rights matrix and i18n helpers`.**

---

### Task 4: Authentication — Microsoft sign-in, sessions, local admin, test login

**Files:**
- Create: `apps/api/src/auth/session.ts`, `src/auth/microsoft.ts`, `src/auth/local.ts`, `src/routes/auth.ts`, `src/plugins/auth.ts` (decorates `request.user`, `requireUser`, `requireRight(action)` hooks), `src/cli/create-local-admin.ts`
- Create: `apps/api/test/auth.test.ts`, `apps/api/test/factory.ts` (`makeUser(overrides)`, `signIn(app, user)` → cookie string via `TEST_LOGIN`)
- Modify: `apps/api/src/app.ts` (register plugins/routes), `.env.example` (add `MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI, SESSION_SECRET, TOKEN_ENCRYPTION_KEY, LOCAL_ADMIN_LOGIN, TEST_LOGIN, PUBLIC_URL`)
- Modify: `prisma/schema.prisma` + migration: `User.passwordHash String?` (local admin only), `User.isLocalAdmin Boolean @default(false)`

**Interfaces:**
- Produces routes: `GET /api/auth/microsoft` → 302 to Microsoft authorize URL (PKCE, state stored in a short-lived signed cookie `ms_state`, scopes `openid profile email offline_access User.Read`); `GET /api/auth/microsoft/callback?code&state` → exchange, look up `User` by `preferred_username`/`email` lowercased (first match on `microsoftOid`, else email, then store oid); **unknown or inactive → 302 `/sign-in?error=not-registered`** with no session; success → create `Session` (30 days, sliding; `lastSeenAt` updated at most once per 5 min), set cookie `crm_session` (HttpOnly, SameSite=Lax, Secure when `PUBLIC_URL` starts with https, path `/`), 302 `/`. `POST /api/auth/logout` deletes the session row, clears cookie, 204. `GET /api/me` → `{ id, email, name, role (label), language, timezone, dateFormat, rights: Action[] }` or 401.
- `POST /api/auth/local` `{ email, password }` → only when `LOCAL_ADMIN_LOGIN=1`, only for users with `isLocalAdmin`, argon2id verify (`argon2` package, pinned), else 404 (route not registered at all when flag unset). Rate-limited 5/min per IP.
- `POST /api/auth/test-login` `{ email }` → only when `TEST_LOGIN=1` and `NODE_ENV !== 'production'`; creates a session for that existing user; 404 otherwise.
- CLI: `npm run create-local-admin -w apps/api -- --email x --name y` prompts for a password (or reads `LOCAL_ADMIN_PASSWORD`), upserts an Administrator with `isLocalAdmin=true`.
- Plugin: `app.addHook('onRequest')` resolves session from cookie → `request.user` (null if none/expired/inactive; **inactive users' sessions are deleted on sight**). `requireUser` replies 401 `{ error: 'unauthenticated' }`; `requireRight('manage_users')` replies 403 `{ error: 'forbidden' }`. Every `/api/*` route except `/api/health`, `/api/auth/*`, and (later) `/api/public/*` uses `requireUser`.
- MSAL: `@azure/msal-node` `ConfidentialClientApplication`; `microsoft.ts` exports `getAuthUrl(state, verifier)`, `redeemCode(code, verifier)` → `{ oid, email, name, refreshToken?, expiresOn }`. Isolated behind an interface `MicrosoftClient` so tests inject a fake.

- [ ] **Step 1: Write `auth.test.ts` with a fake `MicrosoftClient`:** `callback creates session for registered user` (user exists → 302 `/`, cookie set, `GET /api/me` 200 with rights for role); `rejects unknown microsoft identity` (no user → 302 `/sign-in?error=not-registered`, no cookie, `User.count` unchanged); `rejects inactive user`; `deactivated user loses session` (sign in, set `isActive=false`, next `/api/me` 401, session row gone); `session survives restart` (sign in on app A, `buildApp()` again as B, same cookie → 200); `logout clears session`; `test-login refused when TEST_LOGIN unset`; `local login refused when flag unset` (404) and `local login works for local admin` (flag set); `requireRight blocks manager from manage_users` (403). Run, expect FAIL.
- [ ] **Step 2: Implement session.ts (create/find/touch/delete), plugin, routes, microsoft.ts, local.ts, CLI.**
- [ ] **Step 3: Run API tests, expect PASS. Commit `feat(api): microsoft sign-in, sessions, roles guard, local admin and test login`.**

---

### Task 5: Users API and preferences

**Files:**
- Create: `apps/api/src/routes/users.ts`, `src/routes/me.ts`, `src/audit.ts`, `apps/api/test/users.test.ts`, `test/audit.test.ts`

**Interfaces:**
- Produces `audit.ts`: `audit(tx, { entityType, entityId, action, userId, before?, after? })` writes `AuditLog`; `withAudit` helper not required.
- Routes (all `requireUser`): `GET /api/users` → `{ items: UserSummary[] }` (any signed-in user; needed for assignee pickers; inactive included with `isActive:false`); `POST /api/users` (`manage_users`) body `UserCreate` → 201 user; duplicate email → 409 `{ error: 'email_taken' }`; `PATCH /api/users/:id` (`manage_users`) body `UserUpdate` → 200; an admin cannot deactivate themselves → 400 `{ error: 'cannot_deactivate_self' }`; cannot demote the last active Administrator → 400 `{ error: 'last_administrator' }`. `PATCH /api/me/preferences` body `PreferencesUpdate` → 200 me. All writes audited (`entityType: 'user'`).

- [ ] **Step 1: Write tests for each bullet above (including `audit row written on create with after.email`). Run, expect FAIL.**
- [ ] **Step 2: Implement. Run, expect PASS. Commit `feat(api): users management, preferences and audit log`.**

---

### Task 6: Lookup values and allocation rules API

**Files:**
- Create: `apps/api/src/routes/lookups.ts`, `src/routes/allocation.ts`, tests `lookups.test.ts`, `allocation.test.ts`

**Interfaces:**
- `GET /api/lookups?group=lead_status&all=1` → `{ items: LookupValue[] }` ordered by sortOrder; without `all`, only active. Without `group` returns every group as `{ groups: Record<string, LookupValue[]> }` (the web loads this once at start).
- `POST /api/lookups` (`manage_lookups`) `LookupValueCreate` → 201; duplicate `(group,value)` → 409. `PATCH /api/lookups/:id` (label*, sortOrder, isActive). `DELETE` is **not** provided (deactivate instead). `PUT /api/lookups/:group/order` body `{ ids: number[] }` renumbers sortOrder.
- `GET /api/allocation-rules` (`view_admin_settings`), `POST` / `PATCH /:id` / `DELETE /:id` (`manage_allocation`), audited. Validation: every `assignTo` id must be an active user → else 400 `{ error: 'unknown_user' }`.
- Produces for plan 1C: `pickAssignee(tx, country: string): Promise<number | null>` in `apps/api/src/allocation/pick.ts`: active rules by priority asc; first whose `matchCountries` contains the country or is `['*']`; single id → that id; list → `list[roundRobinPos % list.length]` then increments `roundRobinPos` in the same transaction; none → null.

- [ ] **Step 1: Tests:** `inactive value hidden from options but readable` (deactivate `Negotiation`; `GET ?group=lead_status` lacks it; `?all=1` has it with isActive false); `duplicate value 409`; `reorder renumbers`; `manager cannot create lookup` 403; allocation: `single assignee`, `round robin starts at first and advances` (rule `[u1,u2]`, three picks → u1,u2,u1 and `roundRobinPos` 3), `wildcard last by priority`, `no rule → null`, `unknown user 400`. Run, expect FAIL.
- [ ] **Step 2: Implement. Run, expect PASS. Commit `feat(api): lookup values, allocation rules and assignee picker`.**

---

### Task 7: Web shell — brand stylesheet, sign-in, sidebar, router, i18n, combobox, Settings pages

**Files:**
- Create: `apps/web/src/styles/app.css` (ported from `prototype/css/app.css`: tokens, Shell, Components, combobox, modal+toast, accessibility sections; drop email/calendar/quotes/mailer sections until their releases), `src/api/client.ts` (fetch wrapper: JSON, credentials include, 401 → redirect `/sign-in`), `src/api/queries.ts` (TanStack Query hooks `useMe`, `useLookups`, `useUsers`, `useAllocationRules`), `src/i18n/{index.tsx,useT.ts}`, `src/locales/{en,es,fr}.json`, `src/components/{Shell.tsx,Sidebar.tsx,Topbar.tsx,Combobox.tsx,ConfirmDialog.tsx,Toast.tsx,Modal.tsx,Table.tsx,FormField.tsx}`, `src/pages/{SignIn.tsx,Dashboard.tsx (placeholder "Coming in release 1E"),NotFound.tsx}`, `src/pages/settings/{SettingsLayout.tsx,MySettings.tsx,Users.tsx,Lookups.tsx,AllocationRules.tsx}`, `src/router.tsx`
- Create: `apps/web/test/combobox.test.tsx` (Vitest + @testing-library/react, jsdom) — the only unit-tested web component in this plan.
- Modify: `apps/web/index.html` (Montserrat link, `<title>DAIT Partners CRM</title>`, favicon from `prototype/assets/logo-mark.svg` copied to `apps/web/public/`)

**Interfaces:**
- Routes: `/sign-in` (logo, "Sign in with Microsoft" button → `/api/auth/microsoft`; shows "Your Microsoft account is not registered for this CRM. Ask an administrator." when `?error=not-registered`; a local-password form only when `GET /api/auth/options` says `localLogin: true` — add that tiny route to Task 4's `auth.ts`: `{ localLogin: boolean }`), `/` → Dashboard, `/settings` → My settings, `/settings/users`, `/settings/lookups`, `/settings/allocation` (Administration tab visible only with `view_admin_settings`), `*` → NotFound. Unauthenticated → `/sign-in`.
- Sidebar as the prototype's (`js/app.js sidebar()`): brand block, "Modules" section with Leads and Companies (links present, pages say "Coming in release 1B/1C"), "Work" section Tasks, Notifications, Reports (placeholders), Settings pinned to the bottom, user card with initials, name, role and a Sign out button (replaces the prototype's "Act as" switcher). **Below 900 px the sidebar becomes a top bar with a menu button** (UX report H3).
- `Combobox` props: `{ id, label, options: { value: string; label: string }[], value: string | null, onChange, placeholder?, required? }`. Renders a plain `<select>` when `options.length < 8`; otherwise an input with `role="combobox"`, `aria-expanded`, `aria-controls`, listbox with `role="option"`, `aria-selected`; filter is case-insensitive substring with the match wrapped in `<mark>`; ArrowDown/Up move, Enter picks, Escape closes, Tab closes and keeps the typed-exact match if any.
- `ConfirmDialog` promise helper `confirm({ title, body, confirmLabel, danger? }): Promise<boolean>`; used by every destructive action from now on.
- Settings → Users: table (name, email, role, language, status, last sign-in), "Add user" modal (`UserCreate` fields; role is a plain select; language select), edit modal, Deactivate/Reactivate with confirm. Lookups: group tabs (combobox over the 15 groups), rows editable inline (label, ES, FR), drag or up/down to reorder, Deactivate with confirm, "Add value". Allocation: table from the prototype's Settings (Rule, Countries, Assign to [user or round-robin list], Priority, Active), add/edit modal with a countries combobox (multi) and users multi-select, delete with confirm. My settings: language, timezone (combobox over `Intl.supportedValuesOf('timeZone')`), date format; saving re-renders the UI in the new language immediately.
- i18n: `I18nProvider` loads `locales/<me.language>.json`; `useT()` returns `t(phrase, vars?)`. Every user-visible string in the web goes through `t`. `es.json` and `fr.json` contain translations for every phrase in the pages this plan builds (builder writes them; `scripts/i18n-check.ts` fails CI if a phrase used in `t('...')` is missing from es or fr).

- [ ] **Step 1: Write `combobox.test.tsx`:** renders `<select>` for 7 options; for 12 options renders `role="combobox"`, typing `ger` shows only `Germany` with `<mark>ger</mark>`… ArrowDown+Enter calls `onChange('Germany')`, Escape closes the listbox. Run, expect FAIL.
- [ ] **Step 2: Build the stylesheet port, Shell/Sidebar/Topbar, router, client, i18n, Combobox. Run combobox tests, expect PASS. Commit `feat(web): app shell, brand styles, router, i18n and combobox`.**
- [ ] **Step 3: Build SignIn and the four Settings pages against the Task 5/6 APIs; write `scripts/i18n-check.ts` and wire into root `typecheck`. Manually run `npm run dev` in api (with `TEST_LOGIN=1`, seeded sample users) and web; sign in as Maya Pillai via a dev-only button on the sign-in page that appears when `GET /api/auth/options.testLogin` is true; check each page at 1440 px and 390 px.**
- [ ] **Step 4: Commit `feat(web): sign-in and settings pages (users, lookups, allocation, preferences)`.**

---

### Task 8: Graph token store, system mailbox, email jobs and the worker

**Files:**
- Create: `apps/api/src/crypto/tokens.ts` (`encrypt(plain): string`, `decrypt(enc): string`, AES-256-GCM with `TOKEN_ENCRYPTION_KEY` (32 bytes base64), output `iv.tag.ciphertext` base64), `src/graph/client.ts` (`GraphClient` interface: `sendMail(account, { to, cc?, subject, html, text }): Promise<void>`; real impl uses msal `acquireTokenByRefreshToken` + `POST https://graph.microsoft.com/v1.0/me/sendMail`; stores rotated refresh token), `src/graph/accounts.ts` (connect flow), `src/jobs/{queue.ts,types.ts}`, `src/routes/{mailboxes.ts,jobs.ts}`, `apps/worker/src/{main.ts,runner.ts,handlers/sendEmail.ts}`, tests `tokens.test.ts`, `jobs.test.ts`, `sendEmail.test.ts`, `mailboxes.test.ts`
- Modify: `apps/api/src/auth/microsoft.ts` (add `getConnectUrl(state, verifier, mode:'user'|'system')` requesting `Mail.Send Mail.ReadWrite Calendars.ReadWrite offline_access User.Read`), routes `GET /api/auth/microsoft/connect?mode=system`, callback distinguishes sign-in vs connect by the state cookie's `mode`.

**Interfaces:**
- `queue.ts`: `enqueue(tx | prisma, type: JobType, payload, opts?: { runAt?: Date; maxAttempts?: number }): Promise<Job>`; `claimNext(types: JobType[]): Promise<Job | null>` using `UPDATE jobs SET status='running', locked_at=now() WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_at <= now() AND type = ANY($1) ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`; `complete(id)`, `fail(id, err)`: attempts+1; if attempts < maxAttempts → `status='queued', runAt = now + min(2^attempts, 60) minutes`, else `status='failed'`. `JobType = 'send_email'` (more later).
- `types.ts`: `SendEmailPayload { to: string[]; cc?: string[]; subject: string; html: string; text: string; relatedTo?: { entityType: string; entityId: string } }`.
- `sendEmail.ts` handler: finds the `EmailAccount` with `kind='system'` and `status='connected'`; none → `fail` with `no_system_mailbox` (so it retries later and shows as pending); else `graph.sendMail`.
- Helper for later plans: `apps/api/src/email/system.ts` `sendSystemEmail(tx, payload: SendEmailPayload)` = `enqueue('send_email', payload)`.
- Routes: `GET /api/mailboxes/system` (`view_admin_settings`) → `{ account: { address, status, lastError, updatedAt } | null, pendingJobs: number, failedJobs: number }`; `POST /api/mailboxes/system/disconnect` (`manage_users`) deletes the account; `GET /api/jobs?status=failed|queued&type=send_email` (`view_admin_settings`) → list with `attempts`, `lastError`, `runAt`; `POST /api/jobs/:id/retry` sets queued, attempts 0, runAt now.
- Worker `runner.ts`: `runForever({ types, handlers, pollMs = 2000 })`; `main.ts` loads `.env` via `--env-file` (PM2) and runs. Graceful stop on SIGTERM (finish current job).
- Web: Administration → "System mailbox" card (connect button → `/api/auth/microsoft/connect?mode=system`, status, last error, pending/failed counts, failed list with Retry; copy "Emails wait here until the mailbox is connected").

- [ ] **Step 1: Tests:** `tokens`: round trip, tampered ciphertext throws; `jobs`: `claimNext` returns null when empty; claimed job not returned to a second claimer; `fail` requeues with `runAt ≈ now + 2 min` after first failure (`retries with backoff`), `marks failed after max attempts` (maxAttempts 2 → status failed on second fail); `sendEmail`: with a fake `GraphClient` recording calls and a connected system account, handler calls `sendMail` once with the payload; with no account, job is failed-and-requeued with `lastError 'no_system_mailbox'`; `mailboxes`: `GET system` as Manager returns 200, as Sales Representative 403; connect callback with `mode=system` upserts `EmailAccount kind='system'` with an encrypted token (stored value ≠ raw token, `decrypt` returns raw). Run, expect FAIL.
- [ ] **Step 2: Implement API side. Run, expect PASS. Commit `feat(api): encrypted graph tokens, system mailbox and email job queue`.**
- [ ] **Step 3: Implement worker runner + handler; `npm test -w apps/worker` runs a runner test with an in-process handler against `dait_crm_unit` (`runOnce()` variant). Commit `feat(worker): job runner and send_email handler`.**
- [ ] **Step 4: Web Administration → System mailbox card. Commit `feat(web): system mailbox administration`.**

---

### Task 9: Deployment — PM2, release script, GitHub Actions, OpenLiteSpeed steps, backups

**Files:**
- Create: `deploy/ecosystem.config.cjs` (apps `crm-live` :3090, `crm-live-worker`, `crm-test` :3091, `crm-test-worker`; cwd `/home/daitcrm/<env>/current`; `node_args --env-file=/home/daitcrm/<env>/shared/.env`; `WEB_DIST`, `RELEASE` from the `RELEASE` file; `max_memory_restart 400M`), `deploy/release.sh` (args: env, release dir; `npm ci --omit=dev` already done in CI bundle → just `prisma migrate deploy`, symlink `current`, `pm2 startOrReload ecosystem.config.cjs --only crm-<env>,crm-<env>-worker`, curl `/api/health` on the port, keep last 5 releases), `deploy/backup.sh` (`pg_dump -Fc` both DBs to `~/backups/<db>-<date>.dump`, delete > 14 days, `rclone copy` to `onedrive-crm:DAIT-CRM-backups` when the remote exists), `deploy/openlitespeed.md` (for Deepak: create sites crm-test.daitpartners.com and crm.daitpartners.com in CyberPanel, LE cert, vhost `extprocessor` + `context /` proxy to `127.0.0.1:3091`/`3090`, basic auth on the test site, Cloudflare A records), `.github/workflows/deploy-test.yml` (on push to `main`: build, test, tar `apps/*/dist`, `packages/shared/dist`, `prisma/`, `node_modules` after `npm ci --omit=dev`, `package.json` files, `deploy/`; scp to `~/test/releases/<sha>`; ssh `release.sh test <sha>`), `.github/workflows/deploy-live.yml` (`workflow_dispatch` with input `sha`, same to `live`), `docs/DEPLOYMENT.md` (env vars list with meaning, where logs are `pm2 logs crm-test`, rollback = `ln -sfn releases/<prev> current && pm2 reload`, backup/restore commands, how to add the first administrator with `create-local-admin`, how to connect the system mailbox)
- Modify: `README.md` (link to DEPLOYMENT.md)

**Interfaces:**
- GitHub secrets expected: `DEPLOY_HOST`, `DEPLOY_USER` (`daitcrm`), `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`. Server env file keys: `DATABASE_URL, PUBLIC_URL, SESSION_SECRET, TOKEN_ENCRYPTION_KEY, MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI, LOCAL_ADMIN_LOGIN (test only, 1 until Microsoft works), SEED_SAMPLE_USERS (test only)`.

- [ ] **Step 1: Write `deploy/test/release.test.sh` (bash, run by `npm run test:deploy`): creates a temp `RELEASE_ROOT`, fakes `pm2`, `npx` and `curl` on PATH, runs `release.sh test abc123`, asserts `current` → `releases/abc123`, the fake pm2 was called with `--only crm-test,crm-test-worker`, and that with 7 releases only 5 remain. Run, expect FAIL.**
- [ ] **Step 2: Write the scripts and workflows. Run, expect PASS. `node -e "require('./deploy/ecosystem.config.cjs')"` prints four apps.**
- [ ] **Step 3: Write `deploy/openlitespeed.md` and `docs/DEPLOYMENT.md`. Commit `feat(deploy): pm2, release script, actions workflows, backups and deployment notes`.**
- [ ] **Step 4: Hand Deepak the list of server steps (DNS, CyberPanel sites, env files, GitHub secrets, `create-local-admin`) as `!` commands, one message, no secrets in chat. Deployment to the test site happens when he has run them; the plan is complete without it.**

---

### Task 10: End-to-end tests (Playwright) and CI wiring

**Files:**
- Create: `apps/web/playwright.config.ts` (webServer: api built on port 3097 with `DATABASE_URL=…/dait_crm_e2e TEST_LOGIN=1 SEED_SAMPLE_USERS=1 WEB_DIST=apps/web/dist`; baseURL `http://localhost:3097`), `apps/web/e2e/{fixtures.ts (signInAs(page, email) via POST /api/auth/test-login),auth.spec.ts,settings.spec.ts,shell.spec.ts}`, `apps/api/test/e2e-seed.ts` (migrate deploy + seed lookups + four sample users + a connected fake system mailbox row)
- Modify: `.github/workflows/ci.yml` (install Playwright chromium, run `npm test -w apps/web`), root `package.json` test script order: shared → api → worker → web.

- [ ] **Step 1: Specs:** `auth`: unauthenticated `/settings` redirects to `/sign-in`; sign in as Maya (Administrator) → sidebar shows her name and "Administrator"; Sign out returns to `/sign-in`; `settings`: as Maya add user "Test Person" (Manager) → appears in table; deactivate with confirm dialog → status "Inactive"; as Arjun (Sales Representative) `/settings/users` shows "You do not have access" and the Administration tab is absent; change Maya's language to Español → sidebar reads "Configuración"; lookups: add value "Pilot" to lead_status → listed; `shell`: at 390×844 the sidebar is hidden and a menu button opens it. Run, expect FAIL until pages exist (they do by now); fix any defect found.
- [ ] **Step 2: Run full `npm test` at the root, expect all green (shared, api, worker, web). Commit `test(e2e): sign-in, settings and responsive shell`.**
- [ ] **Step 3: Push `main`; CI green. Update `docs/PHASE-1A-CHECKLIST.md` (owner checklist: things Deepak clicks on the test site: sign in with Microsoft, see not-registered page with another account, add a user, change language, connect system mailbox, see a pending email). Commit.**

---

## Self-review notes

- Spec coverage for 1A (design §5 stack, sign-in, outbound email, hosting; §7 builder items; UX H3/H4/M8/M9 shell parts): Tasks 1–10. Lead/company/enquiry rules deliberately deferred to 1B–1D; `pickAssignee` built here because allocation rules live in Settings.
- Names used consistently: `buildApp`, `requireUser`, `requireRight`, `can`, `enqueue`, `claimNext`, `sendSystemEmail`, `pickAssignee`, `Combobox`, `confirm`.
- Review Focus items 1–5 each have a named test in Tasks 4, 6 and 8.
