-- Anonymous per-answer stats for mimi.ganba.re practice sessions.
-- See worker/README.md for the data model and GDPR rationale.

-- A user is identified by a random UUID generated client-side (no PII).
-- nickname is opt-in; not used yet but the column exists for future use.
-- power_user gates access to /v1/admin/stats — set manually via SQL.
CREATE TABLE IF NOT EXISTS users (
  uid        TEXT PRIMARY KEY,                  -- crypto.randomUUID() from the client
  nickname   TEXT,                              -- self-chosen, may contain PII when set
  first_seen INTEGER NOT NULL,                  -- unix ms of first event POST
  last_seen  INTEGER NOT NULL,                  -- unix ms of most recent event POST
  power_user INTEGER NOT NULL DEFAULT 0         -- 1 = may view aggregated app-wide stats
);

-- One row per user action within a question. Action kinds (`ev`):
--   'a' — regular answer submitted. picked = the mora chosen.
--         correct iff picked = target.
--   'g' — guess answer (long-press), correct or wrong. Same shape as 'a'.
--   'r' — re-listen button (or Space) pressed *before* answering.
--         picked is empty. This also resets the vowel's in-level skill
--         and breaks the streak. The voice replayed is the question's.
--   'p' — after a wrong/guess answer, a choice button was tapped during
--         review to play that choice's audio. picked = the mora tapped.
--
-- `idx` and `voice` describe the voice that was played in *this* event.
-- The mora that voice belongs to depends on the event kind:
--    'a'/'g'/'r'   →  target  (so idx = target's voice idx, voice = target's voice name)
--    'p'           →  picked  (so idx = picked's voice idx, voice = picked's voice name)
-- This polymorphism lets a single (idx, voice) pair carry "what was played"
-- across all kinds without redundant pidx/pvoice columns.
--
-- A question instance is implicitly identified by (uid, target, ts - ms):
-- all events from the same question share the same display timestamp. There
-- is no explicit `question_id` column. To recover a 'p' event's question
-- voice, join to the sibling 'a'/'g' event on that key.
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
  target TEXT    NOT NULL,                  -- mora of the question (kunrei-shiki, e.g. 'sa')
  idx    INTEGER NOT NULL,                  -- voice idx of what was played (see comment above)
  picked TEXT    NOT NULL,                  -- mora chosen / tapped; see action-kind comment
  cap    INTEGER NOT NULL,                  -- choices shown (2..6)
  ms     INTEGER,                           -- elapsed since question shown
  ev     TEXT    NOT NULL DEFAULT 'a',      -- 'a'/'g'/'r'/'p' — see comment above
  -- `voice` is the canonical, cross-build identifier of the recording that
  -- was played. The worker resolves it from (mora-of-played, idx) using a
  -- build-time voice map on INSERT, so old rows keep their identity even
  -- if voices are added / removed / reordered later.
  voice  TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_uid    ON events(uid);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);
