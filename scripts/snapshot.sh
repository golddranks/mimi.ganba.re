#!/usr/bin/env bash
# Make the local miniflare DB a faithful snapshot of PRODUCTION's D1. Shared by
# dev.sh and smoke.sh. Reads prod only — never writes it; the worker then
# migrates that local copy on first request, exactly as a deploy migrates prod.
#
# On every run the local DB is reset to the prod dump, so starting up always
# leaves local mirroring prod as of the last pull — no drift, no local-only
# leftovers. The only thing that touches prod is the export, which is cached for
# 6h (keyed off the dump file's age), so launching repeatedly within 6h re-imports
# the cached dump without re-hitting prod. Force a fresh pull by deleting the
# dump. CI containers are fresh (no dump), so they always pull.
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
if [ ! -f "$SNAP" ] || [ -n "$(find "$SNAP" -mmin +$MAX_AGE_MIN 2>/dev/null)" ]; then
  echo "Exporting production D1 -> $SNAP"
  npx wrangler d1 export mimi-stats --remote --output "$SNAP"
  # A failed/empty export must never wipe local or leave a bad dump cached.
  if [ ! -s "$SNAP" ] || ! grep -q 'CREATE TABLE' "$SNAP"; then
    rm -f "$SNAP"
    echo "snapshot: export produced no usable dump; local DB left untouched" >&2
    exit 1
  fi
else
  echo "Cached prod snapshot is under 6h old — reusing it, not re-exporting."
fi

# Always reset local to the dump, so the local DB faithfully mirrors prod (as of
# the last <=6h pull) every time.
echo "Resetting local D1 and importing the snapshot…"
rm -rf .wrangler/state
npx wrangler d1 execute mimi-stats --local --file="$SNAP" >/dev/null
echo "Local D1 now mirrors prod."
