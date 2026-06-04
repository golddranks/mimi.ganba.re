#!/usr/bin/env bash
# Pull a snapshot of the PRODUCTION D1 into the local miniflare DB. Shared by
# dev.sh and smoke.sh. Reads prod only — never writes it; the worker then
# migrates that local copy on first request, exactly as a deploy migrates prod.
#
# Cached to avoid hitting prod (and briefly locking its D1) on every launch: if
# the local DB was successfully snapshotted within the last 6h, this is a no-op.
# Force a fresh pull by deleting worker/.wrangler/state (e.g. `rm -rf`).
#
# Auth: `wrangler login` locally, or CLOUDFLARE_API_TOKEN (with D1:Read) in CI.
# The dump holds real user rows (uids, and any nicknames users set); it's written
# under the system temp dir and must never be committed or shared.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../worker"

SNAP="${TMPDIR:-/tmp}/mimi-stats-snapshot.sql"
STAMP=.wrangler/state/.snapshot-time   # touched only after a clean import
MAX_AGE_MIN=360                         # 6 hours

# Skip the prod export if the local DB was snapshotted < 6h ago. The stamp lives
# inside the state dir, so it vanishes whenever the local DB does and only exists
# after a successful import — present + fresh ⟺ local mirrors a recent prod pull.
# `find -mmin +N` is the portable (macOS + Linux) mtime test; it prints the stamp
# only when it's older than N minutes (CI containers are fresh, so always pull).
if [ -f "$STAMP" ] && [ -z "$(find "$STAMP" -mmin +$MAX_AGE_MIN 2>/dev/null)" ]; then
  echo "Local D1 snapshot is under 6h old — reusing it, skipping prod export."
  exit 0
fi

echo "Exporting production D1 -> $SNAP"
npx wrangler d1 export mimi-stats --remote --output "$SNAP"

# Guard the destructive reset: only wipe local if the export actually produced a
# real dump. A failed/empty export must never silently leave you with an empty
# local DB — that's the trap this whole script exists to avoid.
if [ ! -s "$SNAP" ] || ! grep -q 'CREATE TABLE' "$SNAP"; then
  echo "snapshot: export produced no usable dump; local DB left untouched" >&2
  exit 1
fi

echo "Resetting local D1 and importing the snapshot…"
rm -rf .wrangler/state
npx wrangler d1 execute mimi-stats --local --file="$SNAP" >/dev/null
touch "$STAMP"   # start the 6h reuse window from a successful import
echo "Local D1 now mirrors prod."
