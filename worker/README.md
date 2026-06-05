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
./scripts/dev.sh
```

`dev.sh` keeps an isolated local miniflare DB mirroring prod's D1 (via
`scripts/snapshot.sh`), refreshing it from prod only when the local copy is over
6h old — it reads prod, never writes it, and needs `wrangler login`. The worker then migrates that local copy on first
request, so you develop against real data with the schema the code expects. The
frontend auto-detects `localhost` and talks to the local worker.

The rare case of running against the live prod DB isn't a blessed workflow —
do it by hand with `npx wrangler dev --remote` from `worker/`, and mind that it
writes to prod and migrates it on first request.

## Deploy

The worker auto-deploys via `.github/workflows/deploy.yml` on push to
`main` when anything under `worker/`, `data/phonetic_training/morae/good/`,
or `scripts/build.py` changes. The workflow regenerates `src/voicemap.js`
from the current voice set before deploying, so the deployed map always
matches what's in the data dir on `main`.

Required GitHub secret: `CLOUDFLARE_API_TOKEN`. Don't use the *Edit Workers*
template — it grants way more than CI needs. Create a **Custom token** with
two permissions:

| Permission                         | Why                                              |
|------------------------------------|--------------------------------------------------|
| Account → Workers Scripts: Edit    | Upload and publish the worker bundle.            |
| Account → D1: Read                 | Pre-deploy gate snapshots prod (`smoke.sh`).     |

The *D1: Read* permission is what lets the pre-deploy gate `wrangler d1 export`
a fresh prod snapshot and run the code's migrations against the real schema
before deploying (see *End-to-end tests*). Wrangler 4 (which the workflow pins) skips
the `/memberships` probe wrangler 3 made, so the token still needs no
*User Details: Read*.

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

Both deploys are gated by a shared **`e2e`** job (see below): it snapshots prod,
builds the site, and runs the full suite, and runs whenever *either* the pages or
the worker changed — so a frontend-only change is gated too. `deploy-pages` and
`deploy-worker` run only if it passes. After **both** deploys settle, a **`verify`**
job (`scripts/verify.sh`) checks the LIVE deployed system — it runs the same
api + dom e2e suites against the deployed Pages site and the live worker.

Manual deploy is still possible:

```sh
python3 scripts/build.py --voicemap-only                       # refresh voicemap
./scripts/smoke.sh                                             # snapshot prod + e2e (pre-deploy)
( cd worker && npx wrangler deploy )
./scripts/verify.sh                                            # verify the live deployment
```

## End-to-end tests

The suite lives in `worker/test/` and runs on `node:test`:

- **`test/api.test.mjs`** — the migration gate. Hits a worker over HTTP and
  asserts the paths a schema/code mismatch breaks — above all a *non-empty*
  `POST /v1/events` INSERT round-trip, the exact 500 the migration system exists
  to prevent. (An empty batch early-returns before the INSERT, so it can't
  surface that bug — the test posts real rows.) Writes under the `TestUser`
  sentinel uid, so the rows stay out of all aggregates. Runs against any worker.
- **`test/dom.test.mjs`** — a full-stack check in happy-dom (`test/dom.mjs` loads
  the pages). It drives the app UI through a few questions — the answers POST real
  events through the worker into D1 — then loads the dashboard and admin pages
  against those events and asserts the confusion matrix renders. A break anywhere
  along app → worker → D1 → dashboard surfaces here. **One suite, two targets**:
  `openPage()` loads the built `dist/` against a local worker by default, or — with
  `SITE` set (`scripts/verify.sh`) — fetches the *deployed* pages from Pages and
  drives them against the live worker, a true post-deploy check of what's serving.
  Every uid it writes under is registered as `TestUser` (excluded from aggregates)
  so the exact-count assertions hold against prod too; the admin test, which needs
  `power_user` via local SQL and its rows *in* the aggregate, self-skips when live.
- **`test/push.test.mjs`** — pure unit tests for the reminder cron's due-logic and
  VAPID JWT signing (`src/push.js`); no worker, D1, or DOM.

`scripts/smoke.sh` runs the pre-deploy gate; `scripts/verify.sh` the post-deploy:

```sh
./scripts/smoke.sh                                             # snapshot prod -> build -> boot local -> full e2e
./scripts/smoke.sh https://mimi-stats.golddranks.workers.dev   # just the API migration gate, against a running worker
./scripts/verify.sh                                            # api + dom e2e suites against the live deployment
```

With no argument it refreshes the local DB from a prod snapshot (`scripts/snapshot.sh`, cached 6h), builds
the site (`scripts/build.py`, so the DOM suite can load the real pages), boots the
worker on a local miniflare D1, runs the full suite, and tears down — so the
code's migrations run against prod's *actual* schema, exactly as a deploy would
apply them. That's how drift gets caught before publishing, with zero prod risk.
Given a URL it skips the snapshot/build/boot and runs just the API migration gate
against that worker.

You rarely run it by hand: a **pre-push hook** (`.githooks/pre-push`,
auto-installed by `scripts/dev.sh`) runs it whenever a push changes the worker, so
the whole workflow is just **`./scripts/dev.sh` to develop, `git push` to ship** —
the hook gates locally, then CI gates again and deploys. Bypass the hook with
`git push --no-verify`; it skips itself if `worker/node_modules` isn't installed.

### Snapshotting prod

`scripts/snapshot.sh` does `wrangler d1 export` of prod into a SQL dump, resets
the local miniflare DB, and imports it. Both `dev.sh` and `smoke.sh` run it, but
the **prod export is cached for 6h**, keyed off the *dump file's* age (it lives in
the temp dir, not `.wrangler/state`). So prod is hit at most every 6h regardless
of the local DB — wiping `worker/.wrangler/state` just re-imports the cached dump,
it does not re-hit prod. Force a fresh pull by deleting the dump
(`$TMPDIR/mimi-stats-snapshot.sql`). Needs `wrangler login` locally (or
`CLOUDFLARE_API_TOKEN` with *D1: Read* in CI; CI containers are fresh, so they
always pull). It verifies the
dump before wiping local, so a failed/empty export never leaves you with an empty
DB. The dump holds real user rows, lives under the system temp dir, and must not
be committed or shared.

The CI deploy gates **pre-deploy** with the full `e2e` job (snapshots prod, deploy
aborts on failure) — that snapshot is what needs the `CLOUDFLARE_API_TOKEN`'s
*D1: Read*. **Post-deploy**, the `verify` job checks the live deployed system
(sentinel-scoped; needs no secret). If verify fails, roll back with `npx wrangler
rollback` (or `npx wrangler deployments list` to pick a target) — fast, since the
worker is on `*.workers.dev`.

## Endpoints

- `POST /v1/events`              — body `{uid, events: [{ts, target, idx, picked, cap}, ...]}`
- `POST /v1/user`                — body `{uid, nickname}`
- `POST /v1/push/subscribe`      — body `{uid, subscription, tzOffset}` — register a device for reminders
- `POST /v1/push/unsubscribe`    — body `{endpoint}`
- `POST /v1/push/test`           — body `{endpoint}` — push this device now (the `?remind=test` check)
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

(Grant it on **prod** — `dev.sh` resets local to a prod snapshot each launch, so a
prod grant shows up locally too.)

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

## Reminders (Web Push)

Opted-in devices get a daily nudge even with the app closed. The client
registers `/sw.js` and subscribes via the Push API (`src/main/reminders.js`),
and the subscription is stored in `push_subs`. The worker's **hourly cron**
(`scheduled()` in `src/index.js`; `[triggers]` in `wrangler.toml`) scans that
table, derives each device's local time from its stored `tz_offset`, and pushes
when that device's events show no answers today (19:00 local) or a not-yet-done
day (22:00 local, via the shared `dayTier`). Pushes are **payloadless** — the
service worker shows a fixed message — so there's no RFC 8291 payload
encryption; only VAPID identification (a signed JWT) is needed.

### One-time setup

Generate a VAPID keypair, commit the public half, store the private half as a
secret:

```sh
node scripts/vapid-keygen.mjs
# paste the public key into src/shared/vapid.js (VAPID_PUBLIC_KEY)
cd worker && npx wrangler secret put VAPID_PRIVATE_KEY   # paste the private JWK
```

Until both are set the feature is inert: the client skips subscription and the
cron no-ops. Rotating the keypair invalidates every existing subscription
(devices re-subscribe on their next visit).

### Testing delivery

`?remind` (bare) re-subscribes the current device; `?remind=test` asks the
worker (`POST /v1/push/test`) to push it immediately — the end-to-end check that
works even with the app backgrounded. The cron's due-logic and VAPID signing are
unit-tested in `test/push.test.mjs` (pure, no worker); real OS delivery is a
manual device check, since service workers don't run in happy-dom.

### iOS

Web Push on iOS works only for a site **installed to the home screen** as a PWA
(iOS 16.4+) — Safari/Firefox tabs can't receive it. The `manifest.json` plus the
apple-touch meta tags make the app installable; Android Firefox/Chrome need no
install.

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
