#!/usr/bin/env bash
# Pull a snapshot of the PRODUCTION D1 into the local miniflare DB. Shared by
# dev.sh and smoke.sh so local *always* runs against real prod schema + data;
# the worker then migrates that local copy on first request, exactly as a deploy
# applies migrations to prod. Reads prod only — never writes it.
#
# Auth: `wrangler login` locally, or CLOUDFLARE_API_TOKEN (with D1:Read) in CI.
# The dump holds real user rows (uids, and any nicknames users set); it's written
# under the system temp dir and must never be committed or shared.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../worker"

SNAP="${TMPDIR:-/tmp}/mimi-stats-snapshot.sql"

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
echo "Local D1 now mirrors prod."
