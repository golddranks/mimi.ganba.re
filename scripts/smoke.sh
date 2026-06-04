#!/usr/bin/env bash
# Smoke-test the mimi-stats worker.
#
#   ./scripts/smoke.sh           snapshot prod -> boot local miniflare -> assert
#   ./scripts/smoke.sh <url>     assert against an already-running worker
#                                (e.g. production, post-deploy)
#
# Local mode always pulls a fresh prod snapshot first (via snapshot.sh), so it
# tests the code's migrations against the real prod schema + data. Never writes
# prod. The assertions live in worker/smoke.mjs (dependency-free, Node 18+).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_MJS="$HERE/../worker/smoke.mjs"

# Direct mode: just hit the given URL (no snapshot, no local boot).
if [ "${1:-}" ]; then
  exec node "$SMOKE_MJS" "$1"
fi

# Local mode: fresh prod snapshot, then boot the worker and smoke it.
bash "$HERE/snapshot.sh"

cd "$HERE/../worker"
PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"

# The worker imports the build-generated src/voicemap.js (gitignored); generate
# it before bundling, the same step the deploy workflow runs.
python3 "$HERE/voicemap.py" >/dev/null

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

node "$SMOKE_MJS" "$BASE"
