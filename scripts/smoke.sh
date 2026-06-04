#!/usr/bin/env bash
# End-to-end tests for mimi.ganba.re.
#
#   ./scripts/smoke.sh           snapshot prod -> build site -> boot local worker
#                                -> run the full e2e suite (API + happy-dom DOM)
#   ./scripts/smoke.sh <url>     run the API gate against an already-running
#                                worker (e.g. production, post-deploy)
#
# Local mode refreshes the local DB from a prod snapshot (snapshot.sh, cached 6h),
# so the worker's migrations run against the real prod schema + data; never writes
# prod. The
# DOM suite drives the BUILT dist/ pages in happy-dom against the local worker:
# the app posts real events through the worker into D1, the dashboard reads them
# back. Tests live in worker/test/ (node:test; happy-dom for the DOM suite).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Direct mode: run against an already-running worker (e.g. prod, post-deploy).
# Build the site so the deployed DOM check can load the real dashboard, then run
# the prod-safe suite: the API migration gate + a dashboard e2e scoped to the
# excluded TestUser sentinel. (The app/admin DOM tests stay local-only — they'd
# write non-sentinel rows or need the local D1.)
if [ "${1:-}" ]; then
  python3 "$HERE/voicemap.py" >/dev/null
  python3 "$HERE/build.py"
  cd "$HERE/../worker"
  exec env BASE="${1%/}" node --test test/api.test.mjs test/deployed.test.mjs
fi

# Local mode: refresh prod snapshot (cached 6h), build the site, boot, run e2e.
bash "$HERE/snapshot.sh"

# The worker imports build-generated src/voicemap.js (gitignored); build.py
# needs it too. Build dist/ so the DOM suite can load the real pages.
python3 "$HERE/voicemap.py" >/dev/null
python3 "$HERE/build.py"

cd "$HERE/../worker"
PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"

npx wrangler dev --local --port "$PORT" >/tmp/wrangler-smoke.log 2>&1 &
DEV_PID=$!
trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

# Wait for the dev server to answer (any HTTP status means it's up).
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/" || true)
  [ "$code" != "000" ] && break
  sleep 1
done
if [ "${code:-000}" = "000" ]; then
  echo "wrangler dev did not come up; log:" >&2
  cat /tmp/wrangler-smoke.log >&2 || true
  exit 1
fi

BASE="$BASE" node --test test/api.test.mjs test/dom.test.mjs test/deployed.test.mjs
