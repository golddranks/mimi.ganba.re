CREATE TABLE IF NOT EXISTS users (
  uid        TEXT PRIMARY KEY,
  nickname   TEXT,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  uid    TEXT    NOT NULL,
  ts     INTEGER NOT NULL,
  target TEXT    NOT NULL,
  idx    INTEGER NOT NULL,
  picked TEXT    NOT NULL,
  cap    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_uid    ON events(uid);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);
