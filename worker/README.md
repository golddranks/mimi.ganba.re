# mimi-stats worker

Anonymous per-answer stats sink for mimi.ganba.re — a Cloudflare Worker writing to D1.

## One-time setup

```sh
cd worker
npm install
npx wrangler login                                          # opens browser
npx wrangler d1 create mimi-stats                           # prints database_id
# paste the printed database_id into wrangler.toml
npx wrangler d1 execute mimi-stats --remote --file=schema.sql
npx wrangler deploy                                         # prints the *.workers.dev URL
```

Paste the deployed URL into `STATS_URL` near the top of `src/main/app.js`.

## Local dev

For the combined site + worker stack — frontend on `:8080`, worker on `:8787`
— use the dev script from the repo root:

```sh
./scripts/dev.sh            # default: --remote (worker hits production D1)
./scripts/dev.sh --local    # isolated local miniflare D1
```

In `--remote` mode the worker code is hot-reloaded from local files but runs
on Cloudflare's preview environment with the real D1 binding, so the
dashboards show real data. Events you generate while practicing in dev are
written to prod D1 — fine for personal dev; if that's a concern, use
`--local` (no auth needed, no risk of polluting prod, but you start with an
empty DB).

The frontend auto-detects `localhost` and talks to the local worker; no
source changes needed to switch between local and production targets.

Worker-only:

```sh
npx wrangler dev --remote   # production D1
npx wrangler dev            # local miniflare D1
npx wrangler d1 execute mimi-stats --local --file=schema.sql   # one-time seed for local
```

## Deploy

The worker auto-deploys via `.github/workflows/deploy-worker.yml` on push to
`main` when anything under `worker/`, `data/phonetic_training/morae/good/`,
or `scripts/build.py` changes. The workflow regenerates `src/voicemap.js`
from the current voice set before deploying, so the deployed map always
matches what's in the data dir on `main`.

Required GitHub secret: `CLOUDFLARE_API_TOKEN`. Don't use the *Edit Workers*
template — it grants way more than CI needs. Create a **Custom token** with
a single permission:

| Permission                         | Why                                    |
|------------------------------------|----------------------------------------|
| Account → Workers Scripts: Edit    | Upload and publish the worker bundle.  |

That's it. Wrangler 4 (which the workflow pins) skips the pre-deploy
`/memberships` and D1-binding probes that wrangler 3 made, so the token
needs neither *User Details: Read* nor *D1: Read*.

Additive schema migrations are **applied automatically** by the worker: the
ordered list in `src/migrations.js` runs on the first request each isolate
handles after deploy (see *Schema migrations* below), so a code deploy needing
a new column no longer races ahead of the DB. Baseline creation and destructive
changes are still done by hand with `wrangler d1 execute` from a logged-in
shell, not from CI.

**Account Resources:** Include → *(your account only)*.
**Zone Resources:** leave empty — the worker is on a `*.workers.dev` URL,
not a custom-domain route, so no zone permissions are needed.

The workflow references a GitHub Environment named **`worker`**. Create it
under Repo Settings → Environments → New environment → `worker`, then:

1. Add the token there as an **Environment secret**: `CLOUDFLARE_API_TOKEN`.
2. Under *Deployment branches and tags*, pick *Selected branches* and add
   `main` so the secret is only released to deploys from `main`.

(Using an Environment secret rather than a Repository secret means the
token is only loaded by jobs that explicitly declare `environment: worker`,
and never reachable from a stray PR-triggered workflow.)

Manual deploy is still possible:

```sh
python3 scripts/build.py --voicemap-only   # refresh voicemap
cd worker
npx wrangler deploy
```

## Endpoints

- `POST /v1/events`              — body `{uid, events: [{ts, target, idx, picked, cap}, ...]}`
- `POST /v1/user`                — body `{uid, nickname}`
- `GET  /v1/user/:uid/events`    — all events for a single user (no auth; uid is unguessable)
- `GET  /v1/admin/stats?uid=…`   — sound/aggregate sections; 403 unless `users.power_user >= 1`
- `GET  /v1/admin/stats/users?uid=…` — overview, per-user histograms, daily activity, uid drilldowns; 403 unless `users.power_user >= 2`

CORS is locked to `https://mimi.ganba.re` plus `localhost`/`127.0.0.1` (any port).

## Power users

Two tiers gate the `/admin/` dashboard:

- `power_user = 1` — the aggregate sections only (hour of day, per-sound &
  sound-file difficulty, both confusion matrices). These carry no device
  identifiers. Served by `/v1/admin/stats`.
- `power_user = 2` — everything: overview totals, per-user histograms, daily
  activity, and the uid drill-downs / nicknames. Adds `/v1/admin/stats/users`,
  and unlocks the dashboard's "view another uid" form.

Grant manually via SQL (2 implies 1 — the endpoints check `>=`):

```sh
npx wrangler d1 execute mimi-stats --remote \
  --command="UPDATE users SET power_user = 2 WHERE uid = '<uid>'"
```

To migrate an existing DB that predates these columns:

```sh
# users.power_user — gates /v1/admin/stats and the /admin/ dashboard.
npx wrangler d1 execute mimi-stats --remote \
  --command="ALTER TABLE users ADD COLUMN power_user INTEGER NOT NULL DEFAULT 0"

# events.voice — canonical voice identity at capture time, resolved by the
# worker from (mora-of-played, idx). Migration is generated by
# scripts/build.py; it adds the column and backfills 'a'/'g'/'r' rows from
# the *current* build map. (Legacy 'p' rows can't be backfilled — their idx
# meant target's idx under the old semantic; the new semantic uses picked's
# idx and we can't recover what was played. They stay voice=NULL and are
# excluded from admin aggregates.) Run AFTER you build so the SQL reflects
# the latest data/.../good/ layout.
cd .. && python3 scripts/build.py --no-audio && cd worker
npx wrangler d1 execute mimi-stats --remote --file=migrate-voices.sql
```

`events.opts` and `events.skill` are no longer migrated by hand — they're the
first entries in the auto-applied list (see *Schema migrations* below).

Fresh setups via `schema.sql` already include every column.

## Schema migrations

Schema changes live in `src/migrations.js` as a flat ordered list, each entry
carrying its forward (`up`) and reversal (`down`) SQL:

```js
export const MIGRATIONS = [
  { id: 1,
    up:   "ALTER TABLE events ADD COLUMN opts TEXT",
    down: "ALTER TABLE events DROP COLUMN opts" },
  { id: 2,
    up:   "ALTER TABLE events ADD COLUMN skill INTEGER",
    down: "ALTER TABLE events DROP COLUMN skill" },
];
```

`runMigrations` (in `src/index.js`) runs on the first request each isolate
serves: it ensures a `migrations` ledger table, then for every entry whose `id`
isn't recorded yet it runs the `up` SQL and records `id` + `up_sql` + `down_sql`
+ `applied_at`. So a worker deploy needing a new column heals the schema on its
own first hit — no separate `wrangler d1 execute` step, no window where
`/v1/events` 500s against the old table.

**Both directions are stored in the row, not just the code.** That's the point:
the database is self-describing, so it can be rolled back even by a deploy that
no longer contains the migration's definition. Forward is automatic; reversal is
always deliberate.

Adding one:

- **Append only.** Never edit, reorder, or renumber a shipped migration — the
  `id`s, and the `up`/`down` SQL captured under them, are the permanent record
  of what each DB has had applied.
- Prefer idempotent forward DDL (`CREATE TABLE/INDEX IF NOT EXISTS`). SQLite has
  no `ADD COLUMN IF NOT EXISTS`, so the runner forgives a `duplicate column
  name` error (treats it as already-applied — this is what lets a fresh
  `schema.sql` DB, which already has the columns, stamp them cleanly). Any other
  error propagates as a 500 and retries on the next request.
- Give every migration a `down`. Use `null` only for a genuinely irreversible
  change — `rollback` past it then refuses rather than half-reverting.
- When you add a column here, add it to `schema.sql` too, so fresh DBs start
  with the full shape.

### Rolling back

Reversal never runs on deploy. To undo migrations above id `N`, newest first,
using the down SQL **stored in the DB** (so it works regardless of which code is
deployed):

```sh
# See what would be reversed, and the exact down SQL recorded for each:
npx wrangler d1 execute mimi-stats --remote \
  --command="SELECT id, down_sql FROM migrations WHERE id > N ORDER BY id DESC"

# Then, for each row newest-first, run its down_sql and drop the ledger entry:
npx wrangler d1 execute mimi-stats --remote \
  --command="<down_sql>; DELETE FROM migrations WHERE id = <id>"
```

The same logic is available programmatically as the exported `rollback(env,
toId)` in `src/index.js` (it reads `down_sql` from the ledger and refuses if any
migration in range has a NULL `down_sql`). It is intentionally not wired to any
route — wire it behind a guarded admin trigger if you ever want it over HTTP.

Destructive or backfilling migrations that can't be expressed as a simple
idempotent `up` (like `events.voice` above) still run manually.

## Voice map

`src/voicemap.js` is auto-generated by `scripts/build.py` (committed). It
maps `(mora, idx) → voice name`. The worker imports it and writes
`voice` / `pvoice` on every event INSERT so the row preserves voice
identity even if the voice set is later reordered or extended.

After any change under `data/phonetic_training/morae/good/`:

```sh
python3 scripts/build.py --no-audio   # regenerates worker/src/voicemap.js
cd worker
npx wrangler deploy
```

## Data model & GDPR

- `uid` is a random UUID minted client-side. With no nickname attached, it
  carries no link to a real person → behavioral but not personal data.
- `events` rows are sent from day 1 with no consent prompt (anonymous).
- `users.nickname` is opt-in (client asks on day 2+). Setting it links the
  nickname to all prior+future events under the same uid, so the *act* of
  setting one is what we treat as the consent moment.
- The worker never reads or stores client IPs. Cloudflare may keep IPs in
  its own edge logs for security/abuse purposes (their data as your
  processor, not part of what we collect).

## Looking at the data

Wrap each in `npx wrangler d1 execute mimi-stats --remote --command="..."`:

```sql
-- per-mora accuracy across everyone
SELECT target,
       COUNT(*)                       AS attempts,
       SUM(picked = target)           AS correct,
       ROUND(100.0 * SUM(picked = target) / COUNT(*), 1) AS pct
FROM events GROUP BY target ORDER BY pct ASC;

-- which voice samples confuse people the most (target/idx pairs)
SELECT target, idx,
       COUNT(*)             AS attempts,
       SUM(picked = target) AS correct,
       ROUND(100.0 * SUM(picked = target) / COUNT(*), 1) AS pct
FROM events
GROUP BY target, idx
HAVING attempts >= 5
ORDER BY pct ASC LIMIT 20;

-- accuracy by difficulty cap (more buttons = harder)
SELECT cap, COUNT(*) AS n, ROUND(100.0 * SUM(picked = target) / COUNT(*), 1) AS pct
FROM events GROUP BY cap ORDER BY cap;

-- confusion matrix: when target is X, what do people pick instead?
SELECT target, picked, COUNT(*) AS n
FROM events
WHERE picked != target
GROUP BY target, picked
ORDER BY n DESC LIMIT 30;

-- active users (last 7 days)
SELECT COUNT(DISTINCT uid) FROM events WHERE ts > (strftime('%s','now') - 7*86400) * 1000;
```
