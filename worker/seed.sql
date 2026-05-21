-- Wipe any prior data for this test user.
DELETE FROM events WHERE uid = 'ef78ee05-92f3-458b-a16b-e38bd5547395';
DELETE FROM users  WHERE uid = 'ef78ee05-92f3-458b-a16b-e38bd5547395';

INSERT INTO users (uid, first_seen, last_seen) VALUES
  ('ef78ee05-92f3-458b-a16b-e38bd5547395', 1778857200000, 1779289200000);

-- All days seeded at JST midnight + i seconds.
-- Today (JST) midnight = 2026-05-21 00:00 JST = 1779289200000 ms.
-- Day -n start  = 1779289200000 - n * 86400000.

-- Day -1: 20 answers, 80%  → NOT done, no sparkle.
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < 20)
INSERT INTO events (uid, ts, target, idx, picked, cap, ms, ev)
SELECT 'ef78ee05-92f3-458b-a16b-e38bd5547395',
       1779202800000 + i*1000, 'sa', 0,
       CASE WHEN i % 5 = 0 THEN 'za' ELSE 'sa' END,
       4, 2000, 'a' FROM s;

-- Day -2: 100 answers, 85% → done (steady glow).
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < 100)
INSERT INTO events (uid, ts, target, idx, picked, cap, ms, ev)
SELECT 'ef78ee05-92f3-458b-a16b-e38bd5547395',
       1779116400000 + i*1000, 'sa', 0,
       CASE WHEN i % 20 < 3 THEN 'za' ELSE 'sa' END,
       4, 2000, 'a' FROM s;

-- Day -3: 100 answers, 92% → done90 (slow pulse).
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < 100)
INSERT INTO events (uid, ts, target, idx, picked, cap, ms, ev)
SELECT 'ef78ee05-92f3-458b-a16b-e38bd5547395',
       1779030000000 + i*1000, 'sa', 0,
       CASE WHEN i % 100 < 8 THEN 'za' ELSE 'sa' END,
       4, 2000, 'a' FROM s;

-- Day -4: 50 answers, 100% → done95 (50+@95% path).
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < 50)
INSERT INTO events (uid, ts, target, idx, picked, cap, ms, ev)
SELECT 'ef78ee05-92f3-458b-a16b-e38bd5547395',
       1778943600000 + i*1000, 'sa', 0, 'sa', 4, 2000, 'a' FROM s;

-- Day -5: 120 answers, ~97.5% → done95 (grind+95% path).
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < 120)
INSERT INTO events (uid, ts, target, idx, picked, cap, ms, ev)
SELECT 'ef78ee05-92f3-458b-a16b-e38bd5547395',
       1778857200000 + i*1000, 'sa', 0,
       CASE WHEN i % 33 = 0 THEN 'za' ELSE 'sa' END,
       4, 2000, 'a' FROM s;

-- Day -6: 30 perfect answers in a row (streak completion) → done95 via streak.
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < 30)
INSERT INTO events (uid, ts, target, idx, picked, cap, ms, ev)
SELECT 'ef78ee05-92f3-458b-a16b-e38bd5547395',
       1778770800000 + i*1000, 'sa', 0, 'sa', 4, 2000, 'a' FROM s;
