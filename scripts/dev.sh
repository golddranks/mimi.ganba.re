#!/usr/bin/env bash
# Boots a local dev environment for mimi.ganba.re:
#   - Static site on http://localhost:8080/      (python http.server, dist/)
#   - Stats worker  on http://localhost:8787/    (wrangler dev, worker/)
#
# The worker runs against a snapshot of PROD's D1 in an isolated local miniflare
# DB, refreshed from prod when the local copy is >6h old (reads prod, never
# writes it). The worker
# then migrates that local copy on first request, so you develop against real
# data with the schema the code expects. Needs `wrangler login`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --fresh re-seeds the local D1 from the snapshot even when it's already current
# (the default skips that ~7s import — see below).
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    *) echo "dev.sh: unknown argument: $arg (only --fresh)" >&2; exit 2 ;;
  esac
done

# Prefer the locally-installed wrangler binary over `npx wrangler`, which adds
# ~1.2s of resolution overhead to every call. Install deps once if they're missing.
WRANGLER="$ROOT/worker/node_modules/.bin/wrangler"
if [ ! -x "$WRANGLER" ]; then
  echo "Installing worker dependencies (one-time)…"
  ( cd worker && npm install )
fi

# Install the repo's git hooks (a pre-push worker smoke) on first run. Idempotent;
# bypass any hook with `git push --no-verify`.
if [ "$(git config --get core.hooksPath 2>/dev/null || true)" != ".githooks" ]; then
  git config core.hooksPath .githooks
  echo "Installed git hooks (core.hooksPath=.githooks)."
fi

# voicemap.py writes worker/src/voicemap.js (the worker imports it at boot) and
# build/voices.json (build.py reads it), so it precedes BOTH the worker and the
# static build below.
python3 scripts/voicemap.py

# Static-build preconditions, checked up front so a missing tool fails fast (the
# build itself runs later, overlapping the worker boot). Audio transcoding
# (ffmpeg) is the only step needing more than plain Python; once dist/audio/
# exists, transcode is a no-op and dev.sh runs outside nix-shell. Bail only when
# there's no way forward: no ffmpeg AND no cached audio to reuse.
if ! command -v ffmpeg >/dev/null 2>&1 && [ ! -d dist/audio ]; then
  cat <<'EOF' >&2

No audio data — dist/audio/ doesn't exist yet, and ffmpeg isn't on PATH.

Transcoding voices needs ffmpeg, which shell.nix provides. Bootstrap once with:
  nix-shell --run ./scripts/dev.sh

After that, ./scripts/dev.sh works outside nix-shell.
EOF
  exit 1
fi

# build.py minifies via esbuild (a single standalone binary). Fetch the pinned
# version into the repo root once if it isn't already there / on PATH. Keep
# this version in sync with scripts/build.py + .github/workflows/deploy.yml.
if [ ! -x ./esbuild ] && ! command -v esbuild >/dev/null 2>&1; then
  echo "Fetching esbuild 0.28.0…"
  curl -fsSL https://esbuild.github.io/dl/v0.28.0 | sh
fi

# Reset the local dev D1 to a prod snapshot so local mirrors prod. snapshot.sh
# pulls (cached 6h, reads prod only) and prints the dump path; this is the one
# place that owns worker/.wrangler/state, and the worker migrates the copy on
# first request.
#
# The ~7s import is the slowest part of launch, so skip it when the local DB was
# already seeded from this exact dump: snapshot.sh only rewrites the dump on a
# fresh >6h pull, and re-importing a byte-identical dump just reproduces the same
# DB. --fresh forces the reset (discarding any events written while developing).
SNAP="$(bash scripts/snapshot.sh)"
SNAP_ID="$(cksum < "$SNAP")"
SEEDED_AT=worker/.wrangler/.seeded-from
if [ "$FRESH" = 1 ] || [ ! -d worker/.wrangler/state ] || [ "$(cat "$SEEDED_AT" 2>/dev/null || true)" != "$SNAP_ID" ]; then
  rm -rf worker/.wrangler/state
  ( cd worker && "$WRANGLER" d1 execute mimi-stats --local --file="$SNAP" >/dev/null )
  mkdir -p worker/.wrangler && printf '%s' "$SNAP_ID" > "$SEEDED_AT"
  echo "Local D1 reset to prod snapshot."
else
  echo "Local D1 already mirrors the current snapshot — skipping re-import (--fresh to force)."
fi

# Kill the whole process group when this script exits so both children die.
trap 'kill 0 2>/dev/null || true' EXIT INT TERM

# Start the worker now — its ~1.3s miniflare boot is the long pole. Its inputs
# (voicemap.js + the local D1 state just seeded) are ready and it doesn't need
# dist/, so the static build runs concurrently and hides under the boot.
( cd worker && exec "$WRANGLER" dev --local --port 8787 ) &

# Static-site build, overlapping the worker boot above. transcode is a no-op once
# dist/audio/ exists; build.py minifies+inlines into dist/. Foreground, so a build
# failure still aborts (set -e) and the trap tears the worker back down.
python3 scripts/transcode_audio.py
python3 scripts/build.py

( cd dist && exec python3 -m http.server 8080 ) &

cat <<EOF

=== mimi.ganba.re local dev ===
  site:   http://localhost:8080/

  Local D1 mirrors prod, re-pulled from prod when >6h old.

Ctrl-C to stop both.

EOF

wait
