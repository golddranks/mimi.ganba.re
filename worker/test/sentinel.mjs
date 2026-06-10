// Canary markers stamped on every uid the tests write under, so a test user can
// never be mistaken for an organic one — the bug that let role-0 test rows sit
// in prod aggregates indistinguishable from real users (see the guard test in
// dom.test.mjs). Shared by dom.test.mjs and api.test.mjs (no DOM deps here).
//
//   nickname — pins a row as ours even when role != 1 (role-0 "counted" users
//     that aggregates must include still have to be identifiable). This is the
//     hard rule the guard enforces on every user that posts answers.
//   tz       — a valid offset (-720..840) that NO real timezone uses (not a
//     multiple of 15), so its appearance in prod is an unambiguous "a test
//     leaked" CANARY. Deliberately NOT auto-purged (role 1 is the purged kind);
//     a visible canary beats a silently-swept one.
export const TEST_NICK = "TestUser";
export const TEST_TZ = 727;
