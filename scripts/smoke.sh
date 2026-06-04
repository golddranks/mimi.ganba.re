#!/usr/bin/env bash
# End-to-end tests for mimi.ganba.re.
#
#   ./scripts/smoke.sh           snapshot prod -> build site -> boot local worker
#                                -> run the full e2e suite (API + happy-dom DOM)
#   ./scripts/smoke.sh <url>     run the API gate against an already-running
#                                worker (e.g. production, post-deploy)
#
# Local mode pulls a fresh prod snapshot (snapshot.sh), so the worker's
# migrations run against the real prod schema + data; it never writes prod. The
# DOM suite drives the BUILT dist/ pages in happy-dom against the local worker:
# the app posts real events through the worker into D1, the dashboard reads them
# back. Tests live in worker/test/ (node:test; happy-dom for the DOM suite).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Direct mode: API gate only — there's no local frontend to drive against a
# remote worker, and post-deploy all we need is the migration/round-trip check.
if [ "${1:-}" ]; then
  cd "$HERE/../worker"
  exec env BASE="${1%/}" node --test test/api.test.mjs
fi

# Local mode: fresh prod snapshot, build the site, boot the worker, run e2e.
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

BASE="$BASE" node --test test/api.test.mjs test/dom.test.mjs
