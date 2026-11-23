#!/usr/bin/env bash
# Tests deploy/release.sh with fake pm2, npx and curl on PATH and a temporary RELEASE_ROOT.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/../release.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export RELEASE_ROOT="$T/root" HEALTH_TRIES=3 HEALTH_WAIT=0
BIN="$T/bin"; mkdir -p "$BIN" "$RELEASE_ROOT/test/shared" "$RELEASE_ROOT/test/releases" "$RELEASE_ROOT/live/shared"
echo "DATABASE_URL=postgresql://x" > "$RELEASE_ROOT/test/shared/.env"
export FAKE_LOG="$T/calls.log"; : > "$FAKE_LOG"
printf '#!/usr/bin/env bash\necho "pm2 $*" >> "$FAKE_LOG"\n' > "$BIN/pm2"
# fake node stands in for prisma generate/migrate deploy and the seed; FAKE_MIGRATE_FAIL=1 makes migrate fail
printf '#!/usr/bin/env bash\necho "node $*" >> "$FAKE_LOG"\nif [[ ${FAKE_MIGRATE_FAIL:-} == 1 && "$*" == *"migrate deploy"* ]]; then exit 1; fi\n' > "$BIN/node"
# fake curl answers like the health endpoint, with the release in $FAKE_RELEASE ("none" = never healthy)
printf '#!/usr/bin/env bash\nif [[ ${FAKE_RELEASE:-} == none ]]; then exit 22; fi\nif [[ ${FAKE_RELEASE:-} == "" ]]; then rel=$(cat "$RELEASE_ROOT/test/current/RELEASE"); else rel=$FAKE_RELEASE; fi\necho "{\\"ok\\":true,\\"release\\":\\"$rel\\"}"\n' > "$BIN/curl"
chmod +x "$BIN"/*
export PATH="$BIN:$PATH"

fail(){ echo "FAIL: $*" >&2; exit 1; }
make_tarball(){  # make_tarball <sha>: a minimal release bundle
  local d="$T/build-$1"; mkdir -p "$d/deploy" "$d/apps/api"
  echo "// ecosystem" > "$d/deploy/ecosystem.config.cjs"; echo "{}" > "$d/apps/api/package.json"
  tar czf "$T/$1.tgz" -C "$d" .
}

# 1. seven earlier releases exist; installing abc123 switches current and keeps five
for i in 1 2 3 4 5 6 7; do mkdir -p "$RELEASE_ROOT/test/releases/old$i"; echo "old$i" >> "$RELEASE_ROOT/test/releases.log"; done
make_tarball abc123
bash "$SCRIPT" install test "$T/abc123.tgz" abc123 > "$T/out1.log" 2>&1 || { cat "$T/out1.log"; fail "install abc123 exited non-zero"; }
[[ $(readlink "$RELEASE_ROOT/test/current") == "$RELEASE_ROOT/test/releases/abc123" ]] || fail "current does not point at releases/abc123"
[[ $(cat "$RELEASE_ROOT/test/releases/abc123/RELEASE") == abc123 ]] || fail "RELEASE file missing"
grep -q -- "pm2 startOrReload .*--only crm-test,crm-test-worker" "$FAKE_LOG" || fail "pm2 not called with --only crm-test,crm-test-worker"
grep -q -- "--update-env" "$FAKE_LOG" || fail "pm2 not called with --update-env"
grep -q "node --env-file=.*prisma.*migrate deploy" "$FAKE_LOG" || fail "prisma migrate deploy not run"
n=$(ls "$RELEASE_ROOT/test/releases" | wc -l | tr -d ' ')
[[ $n == 5 ]] || fail "expected 5 releases kept, found $n"
[[ -d "$RELEASE_ROOT/test/releases/abc123" ]] || fail "new release was pruned"
echo "ok: install, symlink, pm2 --only, keep 5"

# 2. a release that never reports itself healthy is rolled back
make_tarball bad456
if FAKE_RELEASE=none bash "$SCRIPT" install test "$T/bad456.tgz" bad456 > "$T/out2.log" 2>&1; then fail "unhealthy install should exit non-zero"; fi
[[ $(readlink "$RELEASE_ROOT/test/current") == "$RELEASE_ROOT/test/releases/abc123" ]] || fail "current was not rolled back to abc123"
grep -q "pm2 startOrReload $RELEASE_ROOT/test/releases/abc123/deploy/ecosystem.config.cjs" "$FAKE_LOG" || fail "pm2 not reloaded with the previous release path"
[[ $(grep -c "pm2 startOrReload $RELEASE_ROOT/test/releases/abc123/" "$FAKE_LOG") -ge 2 ]] || fail "expected a second reload of abc123"
grep -q "seed.js" "$FAKE_LOG" || fail "seed not run"
echo "ok: rollback on failed health check"

# 3. health body for a different release also counts as unhealthy
make_tarball def789
if FAKE_RELEASE=abc123 bash "$SCRIPT" install test "$T/def789.tgz" def789 > "$T/out3.log" 2>&1; then fail "wrong release in health body should fail"; fi
[[ $(readlink "$RELEASE_ROOT/test/current") == "$RELEASE_ROOT/test/releases/abc123" ]] || fail "current not rolled back after wrong release"
echo "ok: wrong release string rejected"

# 3b. reinstalling the running sha is refused and does not delete it
rc=0; bash "$SCRIPT" install test "$T/abc123.tgz" abc123 > "$T/out3b.log" 2>&1 || rc=$?
[[ $rc == 2 ]] || fail "same-sha reinstall should exit 2, got $rc"
[[ -f "$RELEASE_ROOT/test/releases/abc123/RELEASE" ]] || fail "running release was deleted"
echo "ok: same-sha reinstall refused"

# 3c. migration failure: current untouched, pm2 not called
: > "$FAKE_LOG"; make_tarball mig001
if FAKE_MIGRATE_FAIL=1 bash "$SCRIPT" install test "$T/mig001.tgz" mig001 > "$T/out3c.log" 2>&1; then fail "migrate failure should exit non-zero"; fi
[[ $(readlink "$RELEASE_ROOT/test/current") == "$RELEASE_ROOT/test/releases/abc123" ]] || fail "current changed after failed migrate"
! grep -q "^pm2" "$FAKE_LOG" || fail "pm2 was called after failed migrate"
echo "ok: migrate failure leaves current alone"

# 3d. first deploy with no previous release: failed health leaves current on the new one
rm -rf "$RELEASE_ROOT/live/current" "$RELEASE_ROOT/live/releases"; make_tarball first1
if FAKE_RELEASE=none bash "$SCRIPT" install live "$T/first1.tgz" first1 > "$T/out3d.log" 2>&1; then fail "first deploy unhealthy should exit non-zero"; fi
[[ $(readlink "$RELEASE_ROOT/live/current") == "$RELEASE_ROOT/live/releases/first1" ]] || fail "current should stay on first1"
grep -q "no previous release to put back" "$T/out3d.log" || fail "missing first-deploy message"
rm -rf "$RELEASE_ROOT/live/current" "$RELEASE_ROOT/live/releases"
echo "ok: first deploy failure message"

# 4. promote copies what test runs to live
echo "DATABASE_URL=postgresql://x" > "$RELEASE_ROOT/live/shared/.env"
bash "$SCRIPT" promote > "$T/out4.log" 2>&1 || { cat "$T/out4.log"; fail "promote exited non-zero"; }
[[ $(readlink "$RELEASE_ROOT/live/current") == "$RELEASE_ROOT/live/releases/abc123" ]] || fail "live current not abc123"
grep -q -- "--only crm-live,crm-live-worker" "$FAKE_LOG" || fail "pm2 not called for crm-live,crm-live-worker"
echo "ok: promote"

# 5. the CI release tarball carries every folder the API reads at run time (not only dist/): the quotation PDF logo
WORKFLOW="$HERE/../../.github/workflows/deploy-test.yml"
PACK=$(sed -n '/tar czf/,/deploy$/p' "$WORKFLOW" | tr -s ' \\\t' '\n\n\n')
for d in apps/api/dist apps/api/assets apps/worker/dist apps/web/dist packages/shared/dist prisma deploy; do
  grep -qx -- "$d" <<< "$PACK" || fail "deploy-test.yml does not pack $d"
done
echo "ok: release tarball contents"

# 6. the email-body worker thread (apps/api/src/mail/bodyWorker.ts) is loaded by file path at run time, not imported:
# the API build (run by `npm test` first, and packed as apps/api/dist above) must emit it next to mail/bodies.js.
API_DIST="$HERE/../../apps/api/dist"
[[ -f "$API_DIST/mail/bodies.js" ]] || fail "apps/api is not built (run npm run build -w apps/api)"
[[ -f "$API_DIST/mail/bodyWorker.js" ]] || fail "apps/api build does not emit mail/bodyWorker.js"
grep -q "bodyWorker.js" "$API_DIST/mail/bodies.js" || fail "mail/bodies.js does not load bodyWorker.js"
echo "ok: email-body worker in the API build"
echo "All release.sh tests passed"
