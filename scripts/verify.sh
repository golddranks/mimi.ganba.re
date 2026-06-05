#!/usr/bin/env bash
# Post-deploy verification of the LIVE deployed system: run the e2e suites
# against the deployed Pages site + live worker, confirming the real, serving
# deployment works end-to-end. This is the SAME dom.test.mjs that runs locally
# (testenv.sh) — SITE makes it fetch the deployed pages and target the live
# worker instead of a local one; the admin test self-skips (it needs local SQL).
# api.test.mjs runs the worker-API gate against the live worker too. All writes
# are under the TestUser nickname, which production aggregates exclude.
#
#   ./scripts/verify.sh                  # against production
#   ./scripts/verify.sh <site> <worker>  # against given URLs (e.g. a staging pair)
#
# Needs the worker's node_modules (happy-dom): run `npm ci` in worker/ first.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/../worker"

SITE="${1:-https://mimi.ganba.re}"
WORKER="${2:-https://mimi-stats.golddranks.workers.dev}"
exec env SITE="${SITE%/}" BASE="${WORKER%/}" node --test test/api.test.mjs test/dom.test.mjs
