// Forward D1 schema migrations, applied in order by the worker on boot (see
// runMigrations in index.js). Each entry runs once per database, tracked by
// `id` in the `migrations` table.
//
// Both the `up` SQL and its `down` reversal are *copied into the ledger row* at
// apply time, so the database is self-describing: rolling back reads the down
// SQL from the row, never from this list. A worker build that predates a
// migration can therefore still undo it — the reversal lives in the DB, not in
// whatever code happens to be deployed (see rollback() in index.js).
//
// Rules for adding one:
//   - Append only. Never edit, reorder, or renumber a shipped migration — the
//     ids (and the up/down SQL captured under them) are the permanent record of
//     what a given database has had applied.
//   - Prefer idempotent forward DDL (CREATE TABLE/INDEX IF NOT EXISTS). SQLite
//     has no `ADD COLUMN IF NOT EXISTS`, so the runner forgives a "duplicate
//     column name" error (treats it as already-applied).
//   - Give every migration a `down` if it can be reversed; use null only for a
//     genuinely irreversible change (rollback past one then refuses rather than
//     silently losing the boundary).
//   - When you add a column here, add it to schema.sql too, so fresh DBs start
//     with the full shape.
export const MIGRATIONS = [
  {
    id: 1,
    up: "ALTER TABLE events ADD COLUMN opts TEXT",
    down: "ALTER TABLE events DROP COLUMN opts",
  },
  {
    id: 2,
    up: "ALTER TABLE events ADD COLUMN skill INTEGER",
    down: "ALTER TABLE events DROP COLUMN skill",
  },
];
