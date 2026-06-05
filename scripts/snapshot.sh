#!/usr/bin/env bash
# Pull PRODUCTION's D1 into a local SQL dump and print its path. Reads prod only —
# never writes it, and never touches any local .wrangler/state. The caller decides
# what to do with the dump: dev.sh imports it into the dev DB; e2e.sh --snapshot
# imports it into a throwaway DB.
#
# The export is cached for 6h (keyed off the dump's mtime), so repeated launches
# within 6h reuse it without re-hitting prod. Force a fresh pull by deleting the
# dump. CI containers are fresh (no dump), so they always pull. Progress goes to
# stderr; the dump path is the only thing on stdout.
#
# Auth: `wrangler login` locally, or CLOUDFLARE_API_TOKEN (with D1:Read) in CI.
# The dump holds real user rows (uids, and any nicknames users set); it lives
# under the system temp dir and must never be committed or shared.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../worker"

# Prefer the locally-installed wrangler binary; fall back to npx if deps aren't
# installed. npx adds ~1.2s of resolution overhead per call.
wrangler() {
  if [ -x node_modules/.bin/wrangler ]; then node_modules/.bin/wrangler "$@"
  else npx wrangler "$@"; fi
}

SNAP="${TMPDIR:-/tmp}/mimi-stats-snapshot.sql"
MAX_AGE_MIN=360   # 6 hours

# Re-export from prod only when the cached dump is missing or older than 6h.
# `find -mmin +N` is the portable (macOS + Linux) mtime test.
if [ ! -f "$SNAP" ] || [ -n "$(find "$SNAP" -mmin +$MAX_AGE_MIN 2>/dev/null)" ]; then
  echo "Exporting production D1 -> $SNAP" >&2
  wrangler d1 export mimi-stats --remote --output "$SNAP" >&2
  # A failed/empty export must never leave a bad dump cached.
  if [ ! -s "$SNAP" ] || ! grep -q 'CREATE TABLE' "$SNAP"; then
    rm -f "$SNAP"
    echo "snapshot: export produced no usable dump" >&2
    exit 1
  fi
else
  echo "Cached prod snapshot is under 6h old — reusing it, not re-exporting." >&2
fi

echo "$SNAP"
