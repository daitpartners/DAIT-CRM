# Release 4 — AI research — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The prototype's AI Intelligence and Research Sources tabs, Overview AI card and lead AI line, fed by a free website reader now, with Claude API and Google Places providers built but off until the owner adds keys and caps.

**Architecture:** Tables `enrichment_runs` (enrichment_history), `enrichment_suggestions`, `source_records`, single-row `enrichment_settings`; a worker job `research_company` runs providers in order (website reader → Places if on → Claude if on) and stores suggestions; API routes under `/api/companies/:id/research…` and `/api/settings/enrichment`; web replaces the AI/Sources placeholders.

**Tech Stack:** Fastify 5, Prisma/PostgreSQL, existing jobs queue + worker, one HTML parser dependency (pinned, ≥ 2 weeks old), `@anthropic-ai/sdk` (pinned, ≥ 2 weeks old) behind an interface, plain `fetch` for Google Places, React/Vite, TanStack Query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-23-release-4-ai-research-design.md`

## Global Constraints

- Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`); `TZ=Europe/London npm test`; rebuild shared after shared changes; e2e after `npm run build`; Prisma drift empty; `npm run i18n:check` clean (en/es/fr).
- Suggestions only for fields that are **empty and not verified**; nothing invented; every suggestion carries a source URL.
- A field a user saves by hand becomes verified (company PATCH). Verified fields: "Locked · verified", never suggested.
- No spending without a key and a cap: Claude needs env `ANTHROPIC_API_KEY` + monthly USD cap > 0 (default 0); Places needs env `GOOGLE_PLACES_API_KEY` + source on + monthly call cap > 0 (default 0). Keys never reach the browser.
- Website reader limits: home + up to 3 same-site About/Contact/Company pages; 1.5 MB per page; 10 s timeout; robots.txt respected; public http(s) only (private, loopback, link-local refused, redirects re-checked).
- Daily run limit 50 (Administrator setting); auto runs skipped when reached, manual refused with a message.
- Status values: `Not started | Pending | Processing | Completed | Failed` (new default Not started; backfill never-researched companies).
- Automatic runs only for leads/prospects created one at a time (New lead page, lead modal, lead from email) for a company with a website and status Not started; never for CSV/bulk import, conversion, clone.
- No real network calls in tests (local fixture server for the reader; fake Claude and Places clients).
- Screens match the prototype (`prototype/js/views-companies.js` ai / sources tabs, aiCard, engineCard; lead AI line); the last task is a screenshot parity check.
- Never push or deploy without the owner saying "deploy".

## Review Focus

1. A site redirecting to `http://127.0.0.1` / `169.254.169.254` / a private IP → refused, run Failed with a clear result, nothing fetched. (Task 2 test.)
2. A company whose description was imported → no description suggestion; a field verified after a run started → its pending suggestion can't be accepted (Locked). (Task 3 test.)
3. "Run research" twice quickly → one run; the second refused "Research is already running for this company". (Task 3 test.)
4. Claude cap reached mid-month / no key → run completes with the website reader only, engine shows "Website reader", no SDK call made. (Task 3 test.)
5. A 231-row CSV import → no research jobs queued. (Task 3 test.)

---

### Task 1: Data, settings, verified-on-edit

**Files:** `prisma/schema.prisma` + migration `prisma/migrations/20261204100000_ai_research/` (tables; `companies.ai_research_status` default `Not started` + backfill where `ai_last_research_at IS NULL`; single settings row seeded: dailyRunLimit 50, claudeEnabled false, claudeMonthlyCapUsd 0, placesEnabled false, placesMonthlyCallCap 0, webSearchEnabled false), `packages/shared/src/research.ts` (statuses, suggestion field list with labels, `RESEARCH_FIELDS`), `packages/shared/src/schemas/research.ts`, `apps/api/src/routes/companies.ts` (PATCH marks every changed field verified in `verified_fields`; the list's "AI queue" counts Pending + Processing only), `apps/web` status label "Not started" (en/es/fr); tests `packages/shared/test/research.test.ts`, `apps/api/test/companies.test.ts`.

**Interfaces — Produces:**
- Prisma `EnrichmentRun` (`enrichment_runs`: id, companyId, leadId?, trigger, engine, sources Json, result, appliedCount, status, error?, costUsd Decimal(10,4) default 0, placesCalls int default 0, startedAt?, finishedAt?, createdById?, createdAt), `EnrichmentSuggestion` (`enrichment_suggestions`: id, runId, companyId, field, label, value Json, display?, confidence int, sourceUrl, sourceLabel, decision `pending|accepted|rejected|superseded`, decidedById?, decidedAt?), `SourceRecord` (`source_records`: id, companyId, leadId?, title, url?, sourceType, collectedAt, collectedBy, fieldsPopulated, confidence, snapshot?), `EnrichmentSettings` (`enrichment_settings`, id 1).
- `RESEARCH_STATUSES = ['Not started','Pending','Processing','Completed','Failed']`; `RESEARCH_FIELDS: { field: keyof Company | 'aiPotentialServices'; label: string }[]` covering description, legalName, businessEmail, street, city, state, zip, yearEstablished, linkedinUrl, socialFacebook, socialInstagram, socialX, socialYoutube, websiteTechnology, lat, lng, mapsUrl, website, websiteAssessment, specialisation, employeeRange, aiPotentialServices.

- [ ] Failing tests: PATCH company marks changed fields verified (and only those); "AI queue" excludes Not started; shared field list labels; schemas.
- [ ] Migration + models + shared + PATCH change; build shared.
- [ ] Tests pass; drift empty. Commit `feat(research): tables, settings, Not started status, verified on edit`.

### Task 2: Website reader

**Files:** `apps/api/package.json` (+ HTML parser, exact version), `apps/api/src/research/safeFetch.ts` (public-host check incl. DNS resolution and every redirect, size and time limits, robots.txt), `apps/api/src/research/websiteReader.ts`, test fixtures `apps/api/test/fixtures/sites/*`, tests `apps/api/test/websiteReader.test.ts`, `apps/api/test/safeFetch.test.ts`.

**Interfaces — Produces:**
- `type Finding = { field: string; value: unknown; display?: string; confidence: number; sourceUrl: string; sourceLabel: string }`.
- `type PageRead = { url: string; title: string; text: string /* first 4000 visible chars */; fields: string[] }`.
- `readWebsite(url: string, opts?: { fetchImpl?: typeof fetch; resolve?: (host) => Promise<string[]> }): Promise<{ findings: Finding[]; pages: PageRead[]; phone?: string; error?: string }>`.
- Extraction and confidence exactly per spec "What the website reader reads": JSON-LD 90, meta 75, links/markers 85, inferred technology 70; business email only same domain; up to 3 extra same-site pages matched by About/Contact/Company link text or path.

- [ ] Failing tests against a local fixture HTTP server: JSON-LD org page → legal name, address parts, year, socials, description with the right confidences and source URLs; meta-only page → description 75; generator WordPress → technology; off-domain mailto ignored; About page followed, external links not; robots.txt Disallow respected; 2 MB page truncated/refused; timeout → error "Timeout fetching site"; redirect to 127.0.0.1 / 10.x / 169.254.x refused (Review Focus 1); non-http scheme refused.
- [ ] Implement. Tests pass. Commit `feat(research): free website reader with safe fetching`.

### Task 3: Research runs, providers, job, API

**Files:** `apps/api/src/research/providers.ts` (`ResearchProvider` interface; `websiteProvider`, `placesProvider` (fetch, fake-able), `claudeProvider` (@anthropic-ai/sdk, exact version, fake-able; model env `ANTHROPIC_MODEL`, structured output per spec; cost from token usage)), `apps/api/src/research/service.ts` (`startResearch`, `runResearch`, `decideSuggestion`, `acceptAllHigh`, `markProfileVerified`, `addManualSource`), `apps/api/src/jobs/types.ts` + `apps/api/src/jobs/handlers/researchCompany.ts` (job `research_company`), worker registration, lead creation hooks in `apps/api/src/routes/leads.ts` / `apps/api/src/routes/mail.ts` (single creates only), `apps/api/src/routes/research.ts` (new, registered), `apps/api/src/routes/settings.ts` (enrichment settings, Administrators; reports `claudeKeyPresent`, `placesKeyPresent`, `claudeSpentThisMonthUsd`, `placesCallsThisMonth`), tests `apps/api/test/research.test.ts`, `apps/api/test/researchProviders.test.ts`.

**Interfaces — Produces (HTTP):**
- `GET /api/companies/:id/research` → `{ company: { aiSummary, aiIndustry, aiBusinessCategory, aiPotentialServices, aiOpportunityScore, aiConfidence, aiResearchStatus, aiLastResearchAt, verificationStatus, verifiedFields }, pending: Suggestion[] (with currentValue, locked), runs: Run[], canEdit }`.
- `POST /api/companies/:id/research` → 202 `{ runId }`; 409 `research_running`; 429 `daily_limit`.
- `POST /api/research/suggestions/:id/accept|reject` (409 `locked` if the field became verified or filled); `POST /api/companies/:id/research/accept-high` → `{ accepted }`; `POST /api/companies/:id/verify-profile`.
- `GET /api/companies/:id/sources` → `{ items: SourceRecord[] }`; `POST /api/companies/:id/sources` (Title, URL, Type, Fields, Notes → type Manual research, by "<name> (manual)").
- `GET/PUT /api/settings/enrichment`.
- Run behaviour per spec: one run at a time; no website → Completed "No website on file"; providers in order reader → Places (only if key + on + calls under cap) → Claude (only if key + cap > spend); Claude writes `ai_*` columns directly, its services/assessment/specialisation/employee range become suggestions; new suggestion supersedes an older pending one for the same field; accepted values recorded in `ai_fields` and the field marked verified; notification "AI research completed · <company>" "n suggestions to review" to the lead owner else the starter; activity on the triggering lead "AI enrichment queued for <company>".

- [ ] Failing tests: run with fixture reader → suggestions only for empty unverified fields, source records per page with snapshot (Review Focus 2); accept writes the value + verified + appliedCount; reject; accept-high only ≥ 80; locked accept → 409; double start → 409 (Review Focus 3); daily limit → 429 and auto run skipped; no key / cap 0 / cap reached → no Claude call, engine "Website reader" (Review Focus 4); fake Claude → ai_* written, services suggestion, cost recorded; fake Places with cap → suggestions + call counted, refused at cap; CSV import queues nothing, single New lead with a researched-never company queues one (Review Focus 5); visibility: a user who can't see the company gets 404; settings only for Administrators and never return keys.
- [ ] Implement. Tests pass. Commit `feat(research): runs, providers (reader, Places, Claude — off by default), job and API`.

### Task 4: AI Intelligence tab, Sources tab, Overview card, lead line (web)

**Files:** `apps/web/src/api/research.ts`, `apps/web/src/pages/companies/tabs/AiTabs.tsx` (replace placeholders), new `apps/web/src/pages/companies/AiCard.tsx` (prototype aiCard, `big` variant), `apps/web/src/pages/companies/tabs/OverviewTab.tsx` (real card), `apps/web/src/pages/companies/EngineCard.tsx` (Administrators), `apps/web/src/pages/companies/AddSourceModal.tsx`, `apps/web/src/pages/leads/SideColumn.tsx` (AI line: status + Run research), locales; tests `apps/web/test/aiTab.test.tsx`, `apps/web/test/sourcesTab.test.tsx`, e2e `apps/web/e2e/research.spec.ts` (run against the e2e fixture site through an env-configurable allow-list for localhost in test only).

Copy texts exactly from `views-companies.js` lines 79–82: card heading "AI business intelligence", score ring, "Opportunity score not yet computed / n / 100", "Confidence … · Research <badge>", "Last research … · <verification badge>", summary note / "No AI summary yet. Run research to generate one.", buttons "Re-run research" / "Mark profile verified" (big) and "Review suggestions" / "Run research" (small), engine line; "Suggestions awaiting review" + count badge, hint, "Accept all ≥ 80%", columns Field / Current value / AI suggestion / Confidence / Source / Decision, NULL for empty, "Locked · verified", Reject / Accept, empty text; "Enrichment history" columns Run / Trigger / Engine / Sources / Result / Applied / Status, empty text; "AI classification" kv list; Sources tab heading, hint, "+ Add source manually", columns, foot text, snapshot card "Snapshot · <title>" "read only". Engine card per spec (website reader on; Claude / Google Places with key-missing hints, switches and caps, spent this month; Ollama and Apollo disabled). Toasts as prototype ("Enrichment job queued · running in background", "AI research completed · n suggestions").

- [ ] Failing component tests: empty states; suggestions table with locked row; accept/reject/accept-high calls; run button disabled while Pending/Processing; engine card hidden for non-admins, key-missing hints; add-source modal posts.
- [ ] Implement; poll the research query while a run is Pending/Processing. Tests pass. e2e: run research on a company whose website is the fixture site → suggestions appear → accept one → value shows on Overview as verified.
- [ ] Commit `feat(web): AI Intelligence and Research Sources tabs, AI card, engine settings, lead AI line`.

### Task 5: Visual parity, pending list, full verification

**Files:** `apps/web/e2e/parity/research.spec.ts`, `docs/PENDING.md` (Release 4 section: engine-card deviation, owner to-dos: ANTHROPIC_API_KEY + cap, GOOGLE_PLACES_API_KEY + billing account with budget alert + cap), screenshots to `~/Documents/DAIT-CRM/parity-screenshots-4-ai-research/` with `parity-report.md`.

- [ ] Capture app vs prototype (`#/companies/CO-0318/ai`, `#/companies/CO-0318/sources`, `#/companies/CO-0318`, `#/leads/LD-2041`): AI tab empty and with suggestions + history, Sources tab with snapshot, Overview card, engine card, lead AI line.
- [ ] Compare each pair; fix differences or list them with reasons.
- [ ] Full run: build, `TZ=Europe/London npm test`, e2e, i18n, drift — all green. Commit `test(parity): AI research screens match the prototype; pending list`.
