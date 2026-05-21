-- Anonymous per-answer stats for mimi.ganba.re practice sessions.
-- See worker/README.md for the data model and GDPR rationale.

-- A user is identified by a random UUID generated client-side (no PII).
-- nickname is opt-in; not used yet but the column exists for future use.
CREATE TABLE IF NOT EXISTS users (
  uid        TEXT PRIMARY KEY,           -- crypto.randomUUID() from the client
  nickname   TEXT,                       -- self-chosen, may contain PII when set
  first_seen INTEGER NOT NULL,           -- unix ms of first event POST
  last_seen  INTEGER NOT NULL            -- unix ms of most recent event POST
);

-- One row per user action within a question. Action kinds (`ev`):
--   'a' — regular answer submitted. picked = the mora chosen.
--         correct iff picked = target.
--   'g' — guess answer (long-press), correct or wrong. Same shape as 'a'.
--   'r' — re-listen button (or Space) pressed *before* answering.
--         picked is empty. This also resets the vowel's in-level skill
--         and breaks the streak.
--   'p' — after a wrong/guess answer, a choice button was tapped during
--         review to play that choice's audio. picked = which mora.
--
-- `ms` is elapsed time since the question first appeared. For 'p' events
-- this is cumulative — subtract the matching 'a' event's `ms` to get the
-- time spent in review.
--
-- `cap` is the number of choice buttons shown (2..6) when the event happened.
-- For the `u` vowel group cap can reach 6; smaller vowel groups cap lower
-- (a/o: 5, i: 3) regardless of skill.
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  uid    TEXT    NOT NULL,                  -- random per-device UUID
  ts     INTEGER NOT NULL,                  -- unix ms when the event happened
  target TEXT    NOT NULL,                  -- correct mora, kunrei-shiki (e.g. 'sa')
  idx    INTEGER NOT NULL,                  -- voice sample index (0..N-1) of target
  picked TEXT    NOT NULL,                  -- see action-kind comment above
  cap    INTEGER NOT NULL,                  -- choices shown (2..6)
  ms     INTEGER,                           -- elapsed since question shown
  ev     TEXT    NOT NULL DEFAULT 'a'       -- 'a'/'g'/'r'/'p' — see comment above
);

CREATE INDEX IF NOT EXISTS idx_events_uid    ON events(uid);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);
