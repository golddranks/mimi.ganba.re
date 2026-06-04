#!/usr/bin/env bash
# Pull a snapshot of the PRODUCTION D1 into the local miniflare DB. Shared by
# dev.sh and smoke.sh. Reads prod only — never writes it; the worker then
# migrates that local copy on first request, exactly as a deploy migrates prod.
#
# The PROD export is cached for 6h, keyed off the dump file's age. The dump lives
# in the temp dir, independent of worker/.wrangler/state, so prod is hit at most
# every 6h no matter what happens to the local DB — wiping the local DB just
# re-imports the cached dump, it does NOT re-hit prod. Force a fresh pull by
# deleting the dump. CI containers are fresh (no dump), so they always pull.
#
# Auth: `wrangler login` locally, or CLOUDFLARE_API_TOKEN (with D1:Read) in CI.
# The dump holds real user rows (uids, and any nicknames users set); it lives
# under the system temp dir and must never be committed or shared.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../worker"

SNAP="${TMPDIR:-/tmp}/mimi-stats-snapshot.sql"
MAX_AGE_MIN=360   # 6 hours

# Re-export from prod only when the cached dump is missing or older than 6h.
# `find -mmin +N` is the portable (macOS + Linux) mtime test; it prints the dump
# only when it's stale.
exported=false
if [ ! -f "$SNAP" ] || [ -n "$(find "$SNAP" -mmin +$MAX_AGE_MIN 2>/dev/null)" ]; then
  echo "Exporting production D1 -> $SNAP"
  npx wrangler d1 export mimi-stats --remote --output "$SNAP"
  # A failed/empty export must never wipe local or leave a bad dump cached.
  if [ ! -s "$SNAP" ] || ! grep -q 'CREATE TABLE' "$SNAP"; then
    rm -f "$SNAP"
    echo "snapshot: export produced no usable dump; local DB left untouched" >&2
    exit 1
  fi
  exported=true
else
  echo "Cached prod snapshot is under 6h old — reusing it, not re-exporting."
fi

# (Re)import when we just pulled a fresh dump, or when the local DB is gone (e.g.
# .wrangler/state was wiped). Otherwise the local DB already mirrors the cached
# dump — reuse it as-is.
if [ "$exported" = true ] || [ ! -d .wrangler/state ]; then
  echo "Resetting local D1 and importing the snapshot…"
  rm -rf .wrangler/state
  npx wrangler d1 execute mimi-stats --local --file="$SNAP" >/dev/null
  echo "Local D1 now mirrors prod."
else
  echo "Local D1 already present and snapshot fresh — reusing it."
fi
