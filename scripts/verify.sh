#!/usr/bin/env bash
# Post-deploy verification of the LIVE deployed system: fetch the deployed
# dashboard from Pages, run it in happy-dom, and drive it against the live
# worker — confirming the real, serving deployment works end-to-end. Writes only
# under the TestUser sentinel uid (excluded from aggregates), so it's prod-safe.
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
exec env SITE="${SITE%/}" BASE="${WORKER%/}" node --test test/verify.test.mjs
