#!/usr/bin/env bash
# Seeds the e2e database, then runs the built API (which also serves apps/web/dist) on port 3097.
set -euo pipefail
cd "$(dirname "$0")/../../.."
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql://mac@localhost:5432/dait_crm_e2e}"
export PORT=3097
export PUBLIC_URL=http://localhost:3097
export NODE_ENV=test
# AI research (release 4): the website reader may fetch the e2e fixture site on 127.0.0.1 (honoured only under NODE_ENV test/e2e)
export RESEARCH_TEST_ALLOW_HOSTS=127.0.0.1
# test-only values, not secrets
export TEST_LOGIN=1
export SESSION_SECRET=e2e-session-secret-0123456789-abcdefghijklmnopqrstuv
export TOKEN_ENCRYPTION_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=
export WEB_DIST="$PWD/apps/web/dist"
# Import leads uploads go to a folder emptied on every run; apps/api/test/e2e-import-jobs.ts reads the same one
export STORAGE_DIR="${E2E_STORAGE_DIR:-${TMPDIR:-/tmp}/dait-crm-e2e-storage}"
rm -rf "$STORAGE_DIR"
mkdir -p "$STORAGE_DIR"
npm run e2e:seed -w apps/api
exec node apps/api/dist/server.js
