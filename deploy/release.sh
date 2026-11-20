#!/usr/bin/env bash
# Installs a release of the CRM on the server, as user daitcrm.
#   release.sh install <test|live> <tarball> <sha>   unpack a CI build and switch to it
#   release.sh promote                                put exactly what the test site runs live
# Each release lives in ~/<env>/releases/<sha>; ~/<env>/current points at the one running.
# The CI tarball already holds production node_modules, so nothing is installed here.
# If the new release does not report itself healthy, the previous one is put back.
# Env: RELEASE_ROOT (default /home/daitcrm, tests override), HEALTH_TRIES (30), HEALTH_WAIT (1 s).
set -euo pipefail
# Over SSH the login profile may not run: load daitcrm's Node 24 and PM2 (skipped in tests, which set RELEASE_ROOT)
if [[ -z ${RELEASE_ROOT:-} && -s $HOME/.nvm/nvm.sh ]]; then . "$HOME/.nvm/nvm.sh" > /dev/null; fi
ROOT=${RELEASE_ROOT:-/home/daitcrm}
TRIES=${HEALTH_TRIES:-30}; WAIT=${HEALTH_WAIT:-1}; KEEP=5

port_of(){ case "$1" in live) echo 3090 ;; test) echo 3091 ;; *) echo "Unknown environment: $1 (use test or live)" >&2; exit 2 ;; esac; }

healthy(){   # healthy <port> <sha>: the running app answers ok with this release
  local i out
  for ((i = 0; i < TRIES; i++)); do
    out=$(curl -fsS --max-time 3 "http://127.0.0.1:$1/api/health" 2>/dev/null || true)
    [[ $out == *'"ok":true'* && $out == *"\"release\":\"$2\""* ]] && return 0
    sleep "$WAIT"
  done
  return 1
}

reload(){    # reload <env> <release dir>
  pm2 startOrReload "$2/deploy/ecosystem.config.cjs" --only "crm-$1,crm-$1-worker" --update-env
}

activate(){  # activate <env> <sha>: migrate, switch, check, roll back on failure
  local env=$1 sha=$2 port dir prev d
  port=$(port_of "$env"); dir="$ROOT/$env/releases/$sha"
  # Prisma's generated client is built for this machine here (not in CI), so the query engine matches the server OS.
  ( cd "$dir/apps/api"
    set -a; . "$ROOT/$env/shared/.env"; set +a
    npx prisma generate --schema ../../prisma/schema.prisma
    npx prisma migrate deploy --schema ../../prisma/schema.prisma )
  prev=$(readlink "$ROOT/$env/current" 2>/dev/null || true)
  ln -sfn "$dir" "$ROOT/$env/current"
  reload "$env" "$dir"
  if ! healthy "$port" "$sha"; then
    echo "Release $sha did not pass its health check on $env." >&2
    if [[ -n $prev ]]; then
      ln -sfn "$prev" "$ROOT/$env/current"; reload "$env" "$prev"; echo "Put back $(basename "$prev")." >&2
    fi
    exit 1
  fi
  # keep the newest releases, in the order they were installed
  echo "$sha" >> "$ROOT/$env/releases.log"
  tail -n "$KEEP" "$ROOT/$env/releases.log" > "$ROOT/$env/releases.keep"
  for d in "$ROOT/$env/releases"/*; do
    [[ -e $d ]] || continue
    grep -qx "$(basename "$d")" "$ROOT/$env/releases.keep" || rm -rf "$d"
  done
  mv "$ROOT/$env/releases.keep" "$ROOT/$env/releases.log"
  echo "$env is now running $sha."
}

case "${1:-}" in
  install)
    env=${2:?environment}; tarball=${3:?tarball}; sha=${4:?sha}
    port_of "$env" > /dev/null
    dir="$ROOT/$env/releases/$sha"
    rm -rf "$dir"; mkdir -p "$dir"
    tar xzf "$tarball" -C "$dir"
    echo "$sha" > "$dir/RELEASE"
    activate "$env" "$sha" ;;
  promote)
    src=$(readlink "$ROOT/test/current") || { echo "Nothing is running on test yet." >&2; exit 1; }
    sha=$(cat "$src/RELEASE")
    rm -rf "$ROOT/live/releases/$sha"; mkdir -p "$ROOT/live/releases"
    cp -a "$src" "$ROOT/live/releases/$sha"
    activate live "$sha" ;;
  *) echo "Usage: release.sh install <test|live> <tarball> <sha> | release.sh promote" >&2; exit 2 ;;
esac
