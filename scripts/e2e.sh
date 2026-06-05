#!/usr/bin/env bash
# The e2e test runner — the one way to run the suite. Always ISOLATED: it boots a
# throwaway worker on a RANDOM port against a TEMP D1 state dir, builds dist/,
# runs the suite (or a command you pass), and tears it all down by PID. It never
# touches your dev environment's worker/.wrangler/state or :8787, so it's safe to
# run alongside a live ./scripts/dev.sh.
#
#   ./scripts/e2e.sh                  # empty-schema sandbox, full suite
#   ./scripts/e2e.sh --snapshot       # seed from a prod snapshot — the pre-deploy gate
#   ./scripts/e2e.sh node --test test/dom.test.mjs       # run a specific command
#   ./scripts/e2e.sh --snapshot node --test test/api.test.mjs   # snapshot + a command
#   ./scripts/e2e.sh https://mimi-stats.golddranks.workers.dev  # API gate vs a running worker (no boot)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../worker"

# Remote mode: don't boot anything; run the API migration gate against a URL.
case "${1:-}" in
  http://*|https://*) exec env BASE="${1%/}" node --test test/api.test.mjs ;;
esac

# --snapshot seeds the isolated DB from prod (the gate); default is empty schema.
SEED=schema
if [ "${1:-}" = "--snapshot" ]; then SEED=snapshot; shift; fi

PERSIST="$(mktemp -d)"
PORT=$(( 20000 + RANDOM % 20000 ))      # random high port — never 8787/8080
BASE="http://127.0.0.1:${PORT}"
DEV_PID=""
cleanup() { [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null || true; rm -rf "$PERSIST"; }
trap cleanup EXIT INT TERM

# Build the site so the DOM tests load the current dist/ pages.
python3 ../scripts/voicemap.py >/dev/null
python3 ../scripts/build.py >/dev/null

# Seed the isolated DB and boot, both pinned to the temp state dir. An empty
# schema is fast; a prod snapshot lets the worker's migrations run against the
# real prod schema + data, exactly as a deploy would — the pre-deploy gate.
if [ "$SEED" = snapshot ]; then
  SNAP="$(bash ../scripts/snapshot.sh)"
  npx wrangler d1 execute mimi-stats --local --persist-to "$PERSIST" --file="$SNAP" >/dev/null 2>&1
else
  npx wrangler d1 execute mimi-stats --local --persist-to "$PERSIST" --file=schema.sql >/dev/null 2>&1
fi
npx wrangler dev --local --persist-to "$PERSIST" --port "$PORT" >/tmp/e2e-wrangler.log 2>&1 &
DEV_PID=$!

for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/" || true)
  [ "$code" != "000" ] && break
  sleep 1
done
if [ "${code:-000}" = "000" ]; then
  echo "e2e: worker didn't come up; log:" >&2
  cat /tmp/e2e-wrangler.log >&2 || true
  exit 1
fi

echo "e2e: worker on ${BASE} (seed: ${SEED}, state: ${PERSIST})"
if [ "$#" -gt 0 ]; then
  WRANGLER_PERSIST="$PERSIST" BASE="$BASE" "$@"
else
  WRANGLER_PERSIST="$PERSIST" BASE="$BASE" node --test test/*.test.mjs
fi
