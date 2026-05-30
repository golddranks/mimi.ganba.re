#!/usr/bin/env bash
# Boots a local dev environment for mimi.ganba.re:
#   - Static site on http://localhost:8080/      (python http.server, dist/)
#   - Stats worker  on http://localhost:8787/    (wrangler dev, worker/)
#
# The worker runs against an isolated local miniflare D1 — it never touches
# prod. To work with real data, run worker/snapshot.sh first to load a copy of
# prod into the local DB; the dashboards then show that snapshot. No flags, no
# Cloudflare auth, fully offline.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Install the repo's git hooks (a pre-push worker smoke) on first run. Idempotent;
# bypass any hook with `git push --no-verify`.
if [ "$(git config --get core.hooksPath 2>/dev/null || true)" != ".githooks" ]; then
  git config core.hooksPath .githooks
  echo "Installed git hooks (core.hooksPath=.githooks)."
fi

# Build static site in four independent steps. Audio transcoding (ffmpeg)
# is the only step that needs anything beyond plain Python; once dist/audio/
# exists, transcode_audio.py is a no-op and dev.sh works outside nix-shell.
python3 scripts/voicemap.py

# Bail only when there's no way forward: no ffmpeg available AND no cached
# audio to reuse. Either of those means transcode_audio.py can do its work
# (or no work, if it's already up to date) and dev.sh continues normally.
if ! command -v ffmpeg >/dev/null 2>&1 && [ ! -d dist/audio ]; then
  cat <<'EOF' >&2

No audio data — dist/audio/ doesn't exist yet, and ffmpeg isn't on PATH.

Transcoding voices needs ffmpeg, which shell.nix provides. Bootstrap once with:
  nix-shell --run ./scripts/dev.sh

After that, ./scripts/dev.sh works outside nix-shell.
EOF
  exit 1
fi

python3 scripts/transcode_audio.py

# build.py minifies via esbuild (a single standalone binary). Fetch the pinned
# version into the repo root once if it isn't already there / on PATH. Keep
# this version in sync with scripts/build.py + .github/workflows/deploy.yml.
if [ ! -x ./esbuild ] && ! command -v esbuild >/dev/null 2>&1; then
  echo "Fetching esbuild 0.28.0…"
  curl -fsSL https://esbuild.github.io/dl/v0.28.0 | sh
fi

python3 scripts/build.py

# Seed the local miniflare D1 with the schema (idempotent — schema.sql uses
# CREATE TABLE IF NOT EXISTS, so this is a no-op on a snapshot-loaded DB).
echo "Applying schema to local D1…"
( cd worker && npx wrangler d1 execute mimi-stats --local --file=schema.sql ) > /dev/null 2>&1 \
  || echo "warning: local D1 init failed; first /v1/events POST may error. Run manually: (cd worker && npx wrangler d1 execute mimi-stats --local --file=schema.sql)"

# Kill the whole process group when this script exits so both children die.
trap 'kill 0 2>/dev/null || true' EXIT INT TERM

( cd worker && exec npx wrangler dev --local --port 8787 ) &
( cd dist   && exec python3 -m http.server 8080 ) &

cat <<EOF

=== mimi.ganba.re local dev ===
  site:   http://localhost:8080/
  worker: http://127.0.0.1:8787/
  admin:  http://localhost:8080/admin/?uid=<your-uid>

  Local D1 only — never touches prod. Run worker/snapshot.sh to load a copy
  of prod data into it.

Ctrl-C to stop both.

EOF

wait
