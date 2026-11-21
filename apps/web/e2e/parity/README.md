# Prototype parity screenshots

Each screen in the prototype-parity release has a spec here (`<screen>.spec.ts`) that signs in as Maya, opens the
screen and calls `captureParity(page, '<screen>')` from `_shared.ts`. That writes
`out/<screen>-app.png` (1400×1000 viewport, full page). `out/` is gitignored and created on demand.

Run them with the rest of the e2e suite (`npm test -w apps/web`) or alone:

    npx playwright test e2e/parity            # from apps/web

## Capturing the prototype side

The prototype is static HTML and keeps its data in `localStorage`, so always use a fresh browser context.

1. Serve it: `cd prototype && python3 -m http.server 8765` (from the repo root).
2. In a fresh context with a 1400×1000 viewport, open the matching hash route, e.g.
   `http://127.0.0.1:8765/index.html#/leads/LD-2041`.
3. Take a full-page screenshot to `apps/web/e2e/parity/out/<screen>-proto.png`.

A quick way with Playwright from `apps/web`:

    node -e "const {chromium}=require('@playwright/test');(async()=>{const b=await chromium.launch();const p=await (await b.newContext({viewport:{width:1400,height:1000}})).newPage();await p.goto('http://127.0.0.1:8765/index.html#/leads/LD-2041');await p.waitForLoadState('networkidle');await p.screenshot({path:'e2e/parity/out/lead-page-proto.png',fullPage:true});await b.close();})()"

The task report then lists, section by section, prototype → app, with any deliberate deviation and its reason.
Reviewers compare section order, controls and empty states, not pixels.
