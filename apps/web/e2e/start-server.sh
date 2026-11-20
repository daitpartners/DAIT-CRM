#!/usr/bin/env bash
# Seeds the e2e database, then runs the built API (which also serves apps/web/dist) on port 3097.
set -euo pipefail
cd "$(dirname "$0")/../../.."
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql://mac@localhost:5432/dait_crm_e2e}"
export PORT=3097
export PUBLIC_URL=http://localhost:3097
export NODE_ENV=test
export TEST_LOGIN=1
export SESSION_SECRET=e2e-session-secret-0123456789-abcdefghijklmnopqrstuv
export TOKEN_ENCRYPTION_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=
export WEB_DIST="$PWD/apps/web/dist"
npm run e2e:seed -w apps/api
exec node apps/api/dist/server.js
