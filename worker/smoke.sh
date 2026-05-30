#!/usr/bin/env bash
# Boot the worker on the local miniflare D1, run smoke.mjs against it, tear down.
# Always local — never touches prod. Run `bash snapshot.sh` first to test against
# real prod schema + data; otherwise it runs on a schema.sql baseline (every
# column present), which catches code regressions but not a forgotten migration.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"

# Seed the baseline schema (idempotent; no-op on a snapshot-loaded DB).
npx wrangler d1 execute mimi-stats --local --file=schema.sql >/dev/null

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

node smoke.mjs "$BASE"
