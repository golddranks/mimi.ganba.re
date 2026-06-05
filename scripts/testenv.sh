#!/usr/bin/env bash
# Isolated e2e runner — the ONLY way the assistant should run a local worker.
# Boots a throwaway worker on a RANDOM port against a TEMP D1 state dir, builds
# dist/, runs the test suite (or a command passed as args) against it, and tears
# everything down by PID. It never touches the user's worker/.wrangler/state or
# their :8787 dev worker, so testing can't disturb a running ./scripts/dev.sh.
#
#   ./scripts/testenv.sh                 # run the full node:test suite, isolated
#   ./scripts/testenv.sh node --test test/dom.test.mjs   # run a specific command
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../worker"

PERSIST="$(mktemp -d)"
PORT=$(( 20000 + RANDOM % 20000 ))      # random high port — never 8787/8799/8080
BASE="http://127.0.0.1:${PORT}"
DEV_PID=""
cleanup() { [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null || true; rm -rf "$PERSIST"; }
trap cleanup EXIT INT TERM

# Build the site so the DOM tests load the current dist/ pages.
python3 ../scripts/voicemap.py >/dev/null
python3 ../scripts/build.py >/dev/null

# Seed schema + boot, both pinned to the isolated state dir.
npx wrangler d1 execute mimi-stats --local --persist-to "$PERSIST" --file=schema.sql >/dev/null 2>&1
npx wrangler dev --local --persist-to "$PERSIST" --port "$PORT" >/tmp/testenv-wrangler.log 2>&1 &
DEV_PID=$!

for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/" || true)
  [ "$code" != "000" ] && break
  sleep 1
done
if [ "${code:-000}" = "000" ]; then
  echo "testenv: worker didn't come up; log:" >&2
  cat /tmp/testenv-wrangler.log >&2 || true
  exit 1
fi

echo "testenv: worker on ${BASE} (state: ${PERSIST})"
if [ "$#" -gt 0 ]; then
  WRANGLER_PERSIST="$PERSIST" BASE="$BASE" "$@"
else
  WRANGLER_PERSIST="$PERSIST" BASE="$BASE" node --test test/confusion.test.mjs test/push.test.mjs test/api.test.mjs test/dom.test.mjs
fi
