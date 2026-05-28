#!/usr/bin/env bash
# Boots a local dev environment for mimi.ganba.re:
#   - Static site on http://localhost:8080/      (python http.server, dist/)
#   - Stats worker  on http://localhost:8787/    (wrangler dev, worker/)
#
# By default the worker runs in --remote mode: code is hot-reloaded from the
# local files, but the runtime executes on Cloudflare's preview and its D1
# binding hits the production database. That way the dashboards show real
# data without a separate staging DB. Trade-off: events generated during dev
# practice are written to prod D1.
#
# To use an isolated local miniflare-backed D1 instead, pass --local (or set
# WRANGLER_MODE=--local). Local mode needs no Cloudflare auth and stays
# entirely offline.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Parse single positional flag (--local / --remote) or env override.
MODE="${WRANGLER_MODE:---remote}"
for arg in "$@"; do
  case "$arg" in
    --local|--remote) MODE="$arg" ;;
    *) echo "unknown arg: $arg (use --local or --remote)" >&2; exit 2 ;;
  esac
done

# Build static site in four independent steps. Audio transcoding is the
# slow one (ffmpeg) and idempotent — it skips files that already exist.
python3 scripts/voicemap.py
python3 scripts/transcode_audio.py
python3 scripts/minify.py
python3 scripts/build.py

# In --local mode, seed the miniflare D1 with the schema (idempotent —
# schema.sql uses CREATE TABLE IF NOT EXISTS). In --remote mode the schema
# is already deployed in the production DB; nothing to do.
if [ "$MODE" = "--local" ]; then
  echo "Applying schema to local D1…"
  ( cd worker && npx wrangler d1 execute mimi-stats --local --file=schema.sql ) > /dev/null 2>&1 \
    || echo "warning: local D1 init failed; first /v1/events POST may error. Run manually: (cd worker && npx wrangler d1 execute mimi-stats --local --file=schema.sql)"
fi

# Kill the whole process group when this script exits so both children die.
trap 'kill 0 2>/dev/null || true' EXIT INT TERM

( cd worker && exec npx wrangler dev --port 8787 "$MODE" ) &
( cd dist   && exec python3 -m http.server 8080 ) &

cat <<EOF

=== mimi.ganba.re local dev (mode: $MODE) ===
  site:   http://localhost:8080/
  worker: http://127.0.0.1:8787/
  admin:  http://localhost:8080/admin/?uid=<your-uid>
EOF

if [ "$MODE" = "--remote" ]; then
  cat <<EOF

  NOTE: --remote mode — worker bindings hit production D1.
  Events you generate while practicing will be written to the live DB.
  Pass --local for an isolated local DB.
EOF
fi

cat <<EOF

Ctrl-C to stop both.

EOF

wait
