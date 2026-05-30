#!/usr/bin/env bash
# Pull a point-in-time snapshot of the PRODUCTION D1 into the local miniflare DB,
# so local dev and testing run against the real prod schema + data without ever
# touching prod. Needs `wrangler login` (read access to the prod DB).
#
# Typical loop:
#   bash snapshot.sh    # refresh the local copy from prod
#   bash smoke.sh       # or: ./scripts/dev.sh
#
# Because the worker migrates on first request, a snapshot taken before a
# migration is released lets you run that migration against prod-shaped data
# locally — the same thing the deploy will do, but reversible and offline.
#
# The dump holds real user rows (uids, and any nicknames users set), so it's
# written outside the repo (under /tmp). Don't commit or share it. For schema
# only, add --no-data to the export below.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

SNAP="/tmp/mimi-stats-snapshot.sql"

echo "Exporting production D1 -> $SNAP"
npx wrangler d1 export mimi-stats --remote --output "$SNAP"

# Reset the local miniflare state so the dump's CREATE TABLEs import cleanly,
# then load it. .wrangler/ is local-only dev state (gitignored), safe to drop.
echo "Resetting local D1 and importing the snapshot"
rm -rf .wrangler/state
npx wrangler d1 execute mimi-stats --local --file="$SNAP" >/dev/null

echo "Done — local D1 mirrors prod as of now."
echo "Test it without touching prod:  bash smoke.sh"
