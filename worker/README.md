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

Paste the deployed URL into `STATS_URL` near the top of `src/app.js`.

## Local dev

```sh
npx wrangler dev      # http://127.0.0.1:8787
npx wrangler d1 execute mimi-stats --local --file=schema.sql
```

## Endpoints

- `POST /v1/events` — body `{uid, events: [{ts, target, idx, picked, cap}, ...]}`
- `POST /v1/user`   — body `{uid, nickname}`

CORS is locked to `https://mimi.ganba.re` plus `localhost`/`127.0.0.1` (any port).

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
