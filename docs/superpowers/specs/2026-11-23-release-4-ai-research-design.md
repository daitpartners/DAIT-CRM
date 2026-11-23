# Release 4 — AI research (design)

Owner, 23 Nov 2026: "Next release" (dev plan Phase 4). On cost: "As I said earlier don't want to spend money at this
moment. Go as you advise." Standing rules: screens match `prototype/index.html` (company profile AI Intelligence and
Research Sources tabs and the Overview AI card in `views-companies.js` aiCard / engineCard; enrichment rules in
`store.js` runEnrichment / decideSuggestion / saveResearch; the lead page AI line), checked by side-by-side screenshots
before "done"; build only what the prototype shows; mail is private. Data shape: `docs/data-model.md`
`enrichment_history`, `source_records`, company `verified_fields` / `ai_fields` / `ai_*` columns (already in the
companies table).

## Intent

A salesperson opening a company should not have to research it by hand. The CRM reads public information about the
company, proposes values for empty or unconfirmed fields with the page they came from, and the user accepts or rejects
each one. Nothing a person confirmed is ever overwritten, and nothing is invented: what can't be found stays empty.
It must cost nothing to run today and be ready to use the Claude API when the owner decides to pay for it.

## Goals / non-goals / anti-goals

- Goals: AI Intelligence tab (AI business intelligence card, Suggestions awaiting review with Accept / Reject /
  "Accept all ≥ 80%", Enrichment history, AI classification, Enrichment engine card), Research Sources tab (table, "+ Add
  source manually", snapshot card), Overview AI card with "Review suggestions" / "Run research", "Mark profile
  verified", a free website reader that runs now, a Claude API provider that is built but off, a daily run limit and a
  monthly spending cap, research started by hand and automatically for a new lead's company, notification when a run
  finishes, lead page AI line.
- Non-goals: Apollo.io and public registries (shown as "not connected"); Ollama (shown as not installed on
  this server); research on contacts or people; scheduled re-research; reports changes; the parked Enquiries flow.
- Anti-goals: overwriting a verified field; a suggestion without a source; an invented value (a guess presented as
  fact); any spending without a key and a cap the owner set; the CRM server slowed down by fetching sites; fetching
  anything but public web pages (no logins, no private addresses); browser-side API keys.

## Approaches

1. **Chosen (owner: "go as you advise"):** a worker job runs research through pluggable providers. Provider 1, the
   **website reader**, is free: it fetches the company's own public site and reads facts the site states about itself.
   Provider 2, **Claude API**, adds the AI judgement fields (summary, industry, category, potential services,
   opportunity score, website assessment, specialisation) and web search; it is disabled until an
   `ANTHROPIC_API_KEY` is set on the server and an Administrator sets a monthly cap above 0.
2. Claude API only — rejected: costs money from the first run, which the owner does not want now.
3. Self-hosted Ollama — rejected: the shared server has no GPU and too little memory (dev plan Phase 4).

## Decided

**What the website reader reads (free).** For a company with a website: the home page plus up to 3 same-site pages
whose links look like About / Contact / Company (max 4 pages, 1.5 MB each, 10 s timeout each, robots.txt respected, a
CRM user-agent, public http(s) hosts only — private, loopback and link-local addresses refused, redirects re-checked).
It extracts only what the site itself states:
- schema.org JSON-LD `Organization` / `LocalBusiness`: legal name, telephone, email, address (street, city, state,
  zip, country), founding year, `sameAs` social links, description;
- meta description / og:description → description;
- `mailto:` → business email (same domain only); social links (LinkedIn, Facebook, Instagram, X, YouTube);
- website technology from the generator meta tag and well-known markers (WordPress, Shopify, Wix, Squarespace,
  Webflow, Drupal, Joomla, HubSpot, Cloudflare header).
Confidence: JSON-LD 90, meta tags 75, links / markers 85, inferred technology 70. Every suggestion's source is the page
URL. One source record per page read, with a read-only text snapshot (first 4,000 characters of visible text).

**What Claude adds (when switched on).** Sends the website reader's page text (and web search when the "Web search"
source is on) and asks for structured output: summary, industry, business category, potential services (from DAIT's
service list), opportunity score 0–100, confidence High / Medium / Low, website assessment, specialisation,
employee range — each with the source URL it relied on; values it cannot support are left out. Model: the latest
Claude model configured by env `ANTHROPIC_MODEL`. Cost is recorded per run from the API's token usage; a run is refused
before it starts when the month's spend has reached the cap.

**Suggestions and the golden rule (prototype store.js).** A run proposes a value only for a field that is empty and not
verified (builder's call below). Accepting writes the value to the company, records it in `ai_fields` (confidence,
source, run) and counts towards "Applied"; rejecting records the decision. "Accept all ≥ 80%" accepts every pending
suggestion with confidence ≥ 80. A field a user edits by hand, or that is accepted, becomes verified; verified fields
show "Locked · verified" and are never suggested again. "Mark profile verified" marks every filled field verified and
sets verification status Verified. AI classification fields (ai summary, ai industry, ai category, services, score,
confidence) are written by Claude directly to the `ai_*` columns (they are AI's own opinion, shown as such), never to
the user's fields.

**Runs.** `enrichment_history` row per run: trigger ("Manual · <user>" / "New lead LD-…"), engine ("Website reader" or
"Website reader + Claude <model>"), sources, result ("n suggestions", or the error such as "Timeout fetching site",
or "No website on file"), applied count, status Pending / Processing / Completed / Failed. Company `ai_research_status`
and `ai_last_research_at` follow the run. A company without a website: the run completes with "No website on file" and
no suggestions. One run at a time per company (a second request while one is pending is refused with a toast).

**Triggers and limits.** "Run research" / "Re-run research" (users who may edit the company). Automatic: when a new lead
is created with a company that has a website and has never been researched. Daily limit: 50 runs per day across the
CRM (Administrator setting), automatic runs skipped when reached, manual ones refused with a message. Claude monthly
cap: Administrator setting in USD, default 0 = Claude off.

**Notifications.** When a run finishes: the company's lead owner (prototype) or else the person who started it — "AI
research completed · <company>" "n suggestions to review" → AI Intelligence tab.

**Research Sources tab (prototype).** Table: Source (link), Type, Collected, By, Fields populated, Confidence; "+ Add
source manually" (Title, URL, Type, Fields, Notes — type Manual research, by "<user> (manual)"); side card "Snapshot ·
<title>" read only, for the newest record with a snapshot; foot text as the prototype.

**Enrichment engine card (Administrators, prototype layout).** Engine: "Website reader · built in, free" (always on);
"Claude API · intelligence + web search" (radio; disabled with "Add ANTHROPIC_API_KEY on the server to enable" when no
key, otherwise with the monthly cap field and "spent this month USD n"); "Ollama · not installed on this server"
(disabled). Sources: Public company website (on), Web search (needs Claude), Google Places API (disabled with "Add GOOGLE_PLACES_API_KEY on the server to enable" when no key, otherwise a switch and a monthly call cap), Apollo.io (disabled,
"not connected"). Daily run limit field. Text "Credentials live in server environment variables, never in the browser
or public site." Deviation from the prototype (Ollama/Places/Apollo selectable there) recorded for the owner.

**Overview AI card and lead page.** Overview side card as the prototype aiCard (score ring, confidence, research badge,
last research, verification badge, summary or "No AI summary yet. Run research to generate one.", Review suggestions /
Run research, engine line). Lead page side AI line: research status and "Run research" (as the existing placeholder).

**Who.** See: users who can see the company. Run, accept, reject, add source, mark verified: users who may edit the
company (existing company edit rights). Engine settings, limits and cap: Administrators.

**Languages.** UI in en / es / fr. Extracted values as found.

**Google Places (owner 23 Nov: "go-ahead with your plan" — built but off).** Provider 3, used only when env
`GOOGLE_PLACES_API_KEY` is set and an Administrator turns the "Google Places API" source on with a monthly call cap
(default 0 = off). Per run: one ID-only Text Search (name + city/country; free) then one Place Details request with the
field mask `formattedAddress, addressComponents, location, googleMapsUri, nationalPhoneNumber, websiteUri` (Enterprise
tier). Suggestions (empty fields only): street / city / state / zip, latitude / longitude, Maps URL, website; phone kept
in the snapshot as for the reader. Source record type "Google Places API" with the place id. Calls counted per month and
refused once the cap is reached. No real calls in tests (fake client). Apollo.io stays "not connected" (paid plan).

## Builder's calls (from the builder check, marked as such)

- *Only empty fields get suggestions.* Every live company has `verified_fields = {}` (178 imported, plus typed data),
  so "differs from the current value" would propose overwriting good data. Suggestions are made only for fields that
  are empty and not verified; filled fields are left alone. From this release, a field a user saves by hand is marked
  verified. No backfill needed.
- *Where reader facts go.* Address → the company's own street / city / state / zip; country only when it maps to the
  country lookup and the company's country is empty (it is required, so in practice never suggested). Phone: no company
  phone column exists, so the phone is kept in the source snapshot and "Fields populated", not suggested. No new
  columns, no location suggestions.
- *Never researched.* New status value "Not started" (migration: default and backfill for companies never researched;
  en/es/fr label); "Pending" means queued. The Companies list "AI queue" counts Pending and Processing only. Auto-trigger
  = status Not started.
- *Automatic runs* only for leads and prospects created one at a time (New lead page, lead modal, lead from an email);
  not for CSV / bulk imports, conversions or clones.
- *Claude's output:* summary, AI industry, AI category, opportunity score and confidence go straight to the `ai_*`
  columns (AI's own opinion, shown as such). Potential services, website assessment, specialisation and employee range
  are suggestions (empty fields only), as the prototype's suggestion rows; accepting services writes
  `ai_potential_services`. Claude never suggests the user's own industry or business category.
- *Re-runs:* a new suggestion for a field replaces an older undecided one (the old one is marked superseded), so a field
  has at most one pending suggestion.

## Left to the builder

HTML parsing approach (an established, pinned dependency ≥ 2 weeks old is fine; no headless browser), Claude SDK
usage and prompt, job queue details (follow existing jobs), API shapes, tests (website reader against local fixture
pages; Claude provider against a fake client — no real API calls in tests). Before calling it done: screenshot parity
of the AI Intelligence tab (empty, with suggestions, history), Research Sources tab, Overview card, engine card, lead AI
line against the prototype; differences fixed or listed for the owner.

## Addendum, 23 Nov 2026: Claude through the server's Claude Code instead of the API

Owner: "We have installed claude code on our server and authenticated, use instead of API"; "do not disturb other
projects"; "copy the token". Release 4 (fa12206) is live with Claude off.

**What the server has (checked read-only).** Claude Code 2.1.311 at `/root/.local/bin/claude` (world-executable; the
CRM user `daitcrm` can run it). Root's own saved login is expired; the working login is the subscription token
`CLAUDE_CODE_OAUTH_TOKEN`, which another project (the accounting app) passes to `claude -p` on every call. That token
line has been copied into the CRM's `/home/daitcrm/live/shared/.env` (owner approved). Probed as `daitcrm` from Node:
`claude -p` with a minimal env (HOME, PATH, the token), an empty temp cwd, `--tools ""`, `--strict-mcp-config`,
`--setting-sources ""`, `--no-session-persistence`, `--output-format json`, `--json-schema` → structured output in
~2.4 s on claude-sonnet-5-5.

**Decided.**
- The Claude provider's transport changes from the Anthropic SDK to a spawned `claude -p` run; prompt, output schema,
  zod validation, the golden rule and how findings map to fields/`ai_*` columns stay as built.
- Never disturb anything else: the binary is used as is (path from env `CLAUDE_BIN`, default
  `/root/.local/bin/claude`); nothing installed, updated or configured; root's `~/.claude`, settings, hooks and other
  projects' files are never read or written. The child runs as the worker's user (`daitcrm`) with ONLY `HOME`, `PATH`
  and `CLAUDE_CODE_OAUTH_TOKEN` in its environment (never DATABASE_URL or other CRM secrets), in a fresh empty temp
  directory removed afterwards, with user/project settings and MCP servers off and no session saved.
- No tools: website text is untrusted. `--tools ""`; when the Web search source is on, `--tools WebSearch` and
  `--allowedTools WebSearch` (the only tool it can ever get). Page text goes in on stdin, not argv.
- One call at a time (the research lane is serial), 120 s timeout per call inside the existing 5-minute step budget,
  killed on timeout/abort, output capped.
- Enabled only when `CLAUDE_CODE_OAUTH_TOKEN` is set, the binary is executable, the Administrator switch is on and the
  monthly run cap is above 0. The USD cap becomes a **monthly run cap** (runs that used Claude this calendar month,
  UTC; default 0 = off): a subscription has no per-call price. Migration replaces `claude_monthly_cap_usd` with
  `claude_monthly_run_cap` (live value is 0, nothing to carry).
- Model: env `CLAUDE_MODEL` (optional), default the `sonnet` alias, recorded on the run's engine line.
- "Not logged in" / expired token → the run's error "Claude Code is not logged in on the server"; other CLI failures →
  "Claude Code failed"; timeout → "Claude took too long".
- Engine card: "Claude Code on this server · intelligence + web search"; disabled text "Add CLAUDE_CODE_OAUTH_TOKEN on
  the server to enable"; cap field "Monthly run cap" with "used this month n". The Anthropic SDK dependency and the
  price table are removed (YAGNI); the API route can be rebuilt later if wanted.
- Tests: a fake runner for the provider; the spawn wrapper tested against a fake `claude` script (env passed, args,
  stdin, timeout, bad JSON, not-logged-in). No real Claude calls in tests.
