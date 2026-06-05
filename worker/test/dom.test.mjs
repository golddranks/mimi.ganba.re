// Full-stack DOM e2e: drive the app pages in happy-dom against a real worker.
// The app's answers POST real events through the worker into D1; the dashboard
// reads them back and renders. One set of cases, two targets:
//   - local (default): built dist/ + a worker booted by scripts/testenv.sh
//   - live (SITE set): the deployed Pages site + live worker, post-deploy, via
//     scripts/verify.sh
// openPage() hides the difference. Every uid the suite writes under is
// registered with nickname "TestUser", which the worker excludes from
// production aggregates (EXCLUDE_TEST) — so a fresh uid sees only its own
// events and the exact-count assertions hold against prod too. The admin test
// is the lone exception (it needs power_user via local SQL *and* its rows must
// stay in the aggregate), so it skips in live mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openPage, waitFor, readConfusion, LIVE, WORKER } from "./dom.mjs";
import { daysAgo } from "../../src/shared/dates.js";

const getEvents = async (uid) =>
  (await (await fetch(`${WORKER}/v1/user/${encodeURIComponent(uid)}/events`)).json()).events || [];

const postEvents = (uid, events) =>
  fetch(`${WORKER}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, events }),
  });

// Register a uid with nickname "TestUser" so the worker excludes its rows from
// production aggregates (EXCLUDE_TEST). Every uid the suite writes under goes
// through this — keeping writes prod-safe and isolated (a fresh uid sees only
// its own events, so exact counts hold live as well as local).
const registerTestUser = (uid) =>
  fetch(`${WORKER}/v1/user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, nickname: "TestUser" }),
  });

const freshTestUser = async () => {
  const uid = randomUUID();
  await registerTestUser(uid);
  return uid;
};

// Worker-dependent waits cross the network; give them room on the live target.
const WAIT = { timeout: LIVE ? 20000 : 5000 };

// power_user has no API setter (granted by hand via SQL), so poke the local D1
// the dev worker reads. Local-only — the admin test that uses it skips live.
// Honors WRANGLER_PERSIST so it targets the state dir testenv.sh booted on.
const grantPowerUser = (uid, level = 1) => {
  const args = ["wrangler", "d1", "execute", "mimi-stats", "--local"];
  if (process.env.WRANGLER_PERSIST) args.push("--persist-to", process.env.WRANGLER_PERSIST);
  args.push("--command", `UPDATE users SET power_user=${level} WHERE uid='${uid}'`);
  execFileSync("npx", args, { stdio: "ignore" });
};

// Six deterministic answers for sound "sa", reused by the dashboard tests:
// za picked 3x & offered 5x, sa picked 2x, sya picked 1x & offered 1x.
const saFixture = (base) => {
  const mk = (i, picked, opts) =>
    ({ ts: base + i, target: "sa", idx: 0, picked, cap: opts.length, ms: 500, ev: "a", opts, skill: 0 });
  return [
    mk(1, "za", ["sa", "za"]), mk(2, "za", ["sa", "za"]), mk(3, "za", ["sa", "za"]),
    mk(4, "sa", ["sa", "za"]), mk(5, "sa", ["sa", "za"]),
    mk(6, "sya", ["sa", "sya"]),
  ];
};

test("app: answering questions posts events (with opts) to the worker", async (t) => {
  const { win, close } = await openPage("/");
  t.after(close);

  const uid = win.localStorage.uid;
  assert.match(uid, /^[0-9a-f-]{36}$/, "app generated a uid");
  await registerTestUser(uid);

  // Each loop starts a question (primary doubles as Start / Next) and answers
  // the first choice. Right answers auto-advance, wrong ones surface Next —
  // clicking primary again covers both. Poll for the rendered choices rather
  // than waitUntilComplete, which would block on the app's 5s flush-retry timer.
  for (let i = 0; i < 6; i++) {
    win.primary.click();
    const btns = await waitFor(() => {
      const b = win.choices.querySelectorAll("button.choice");
      return b.length ? b : null;
    }, WAIT);
    btns[0].click();
  }

  const events = await waitFor(async () => {
    const ev = await getEvents(uid);
    return ev.length ? ev : null;
  }, WAIT);
  const answers = events.filter((e) => e.ev === "a" || e.ev === "g");
  assert.ok(answers.length >= 1, "at least one answer event persisted");
  assert.ok(
    answers.some((e) => typeof e.opts === "string" && e.opts.includes(",")),
    "answer events carry the opts column end-to-end",
  );
});

test("app: a Y/N question saves a y event end to end", async (t) => {
  const { win, close } = await openPage("/", {
    setup: (w) => {
      // Unlock Y/N for vowel 'a' (skill >= 15), and force the Y/N branch with the
      // shown kana == target: Math.random()->0.01 makes pick/idx deterministic and
      // both `< YN_RATIO` (0.2) and `< 0.5` true, so target=sa, shown=さ, answer=yes.
      w.localStorage.setItem("mora", JSON.stringify({ s: {}, k: 0, x: { a: 20 } }));
      w.Math.random = () => 0.01;
    },
  });
  t.after(close);
  const uid = win.localStorage.uid;
  await registerTestUser(uid);

  win.primary.click();
  await waitFor(() => !win.yn.hidden, WAIT);
  assert.equal(win.ynprompt.textContent, "さ");
  win.ynyes.click();   // ○: さ is the sa sound → correct

  const yn = await waitFor(async () => {
    const e = (await getEvents(uid)).filter((x) => x.ev === "y" || x.ev === "n");
    return e.length ? e : null;
  }, WAIT);
  assert.equal(yn[0].ev, "y");
  assert.equal(yn[0].picked, "sa");
});

test("app: day-start probing drills the uncertain confusion (released without the grind flag)", async (t) => {
  const { win, close } = await openPage("/", {
    setup: (w) => {
      // sa→za: 2 wrong of 3 offered → uncertain → the probe target. No stats
      // today, so the day-start probe phase starts even with grind off.
      w.localStorage.setItem("grind_tally", JSON.stringify({
        sa: { n: 3, correct: 1, conf: { za: 2 }, offered: { za: 3 } },
      }));
    },
  });
  t.after(close);
  await registerTestUser(win.localStorage.uid);

  win.primary.click();
  const btns = await waitFor(() => {
    const b = win.choices.querySelectorAll("button.choice");
    return b.length ? b : null;
  }, WAIT);
  const morae = [...btns].map((b) => b.dataset.mora).sort();
  assert.deepEqual(morae, ["sa", "za"], "probe drills the sa/za pair as a 2-button question");
  // Probing presents as an ordinary question: the message is the normal prompt,
  // not the grind-only "focused training" copy (which stays behind GRIND_ENABLED).
  assert.equal(win.message.textContent, "Let's train some more today!");
});

test("app: ?morning forces the probe phase even with answers logged today", async (t) => {
  const { win, close } = await openPage("/?morning", {
    setup: (w) => {
      // Today already has answers — would normally suppress the day-start probe.
      w.localStorage.setItem("mora", JSON.stringify({ s: { [daysAgo(0)]: { correct: 5, total: 5, maxRun: 5 } }, k: 5, x: { a: 20 } }));
      w.localStorage.setItem("grind_tally", JSON.stringify({ sa: { n: 3, correct: 1, conf: { za: 2 }, offered: { za: 3 } } }));
    },
  });
  t.after(close);
  await registerTestUser(win.localStorage.uid);

  win.primary.click();
  const btns = await waitFor(() => {
    const b = win.choices.querySelectorAll("button.choice");
    return b.length ? b : null;
  }, WAIT);
  assert.deepEqual([...btns].map((b) => b.dataset.mora).sort(), ["sa", "za"], "?morning probes despite today's stats");
});

test("dashboard: confusion matrix renders asked vs shown denominators", async (t) => {
  // Per-uid view, so counts are exact. With the sa fixture, za is picked 3x &
  // offered 5x, sya picked 1x & offered 1x. Default "shown" = picked/offered,
  // "asked" = raw pick count.
  const uid = await freshTestUser();
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`);
  t.after(close);

  const r = await readConfusion(win, [["sa", "za"], ["sa", "sya"]]);
  assert.deepEqual(r["sa/za"], { picked: 3, offered: 5, asked: 3 });
  assert.deepEqual(r["sa/sya"], { picked: 1, offered: 1, asked: 1 });
});

test("dashboard: confusion matrix marks grind and probe targets", async (t) => {
  // sa->za: 10 wrong of 10 offered -> confidently >20% -> grind.
  // sa->sya: 2 wrong of 3 offered -> uncertain, highest such rate -> probe.
  const uid = await freshTestUser();
  const t0 = Date.now();
  const mk = (i, picked, opts) =>
    ({ ts: t0 + i, target: "sa", idx: 0, picked, cap: opts.length, ms: 500, ev: "a", opts, skill: 0 });
  const events = [];
  for (let i = 0; i < 10; i++) events.push(mk(i, "za", ["sa", "za"]));
  events.push(mk(10, "sya", ["sa", "sya"]), mk(11, "sya", ["sa", "sya"]), mk(12, "sa", ["sa", "sya"]));
  assert.equal((await postEvents(uid, events)).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`);
  t.after(close);
  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  await waitFor(() => cell("sa", "za")?.classList.contains("grind"), WAIT);
  assert.ok(!cell("sa", "za").classList.contains("probe"), "grind cell isn't also probe");
  assert.ok(cell("sa", "sya").classList.contains("probe"), "sa/sya is the probe target");
  assert.ok(!cell("sa", "sya").classList.contains("grind"), "probe cell isn't grind");
  // The diagonal (correct) is never a target.
  assert.ok(!cell("sa", "sa").classList.contains("grind") && !cell("sa", "sa").classList.contains("probe"));
});

test("dashboard: clicking a confusion cell shows its history strip", async (t) => {
  // 6 sa-questions with za offered: picked za (red) 3x, sa (green) 3x.
  const uid = await freshTestUser();
  const t0 = Date.now();
  const mk = (i, picked) => ({ ts: t0 + i, target: "sa", idx: 0, picked, cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 });
  const events = [mk(1, "za"), mk(2, "sa"), mk(3, "za"), mk(4, "sa"), mk(5, "za"), mk(6, "sa")];
  assert.equal((await postEvents(uid, events)).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`);
  t.after(close);
  const cell = () => win.confchart.querySelector('td[data-t="sa"][data-p="za"]');
  const detail = win.document.getElementById("confdetail");

  await waitFor(() => cell()?.textContent === "3/6", WAIT);   // matrix rendered (shown: za picked 3 of 6 offered)
  assert.ok(detail.hidden, "history hidden until a cell is clicked");
  cell().click();

  await waitFor(() => !detail.hidden && detail.querySelectorAll("svg rect").length > 0, WAIT);
  assert.equal(detail.querySelectorAll("svg rect").length, 6, "one box per offered event");
  assert.match(detail.querySelector(".cd-head").textContent, /→ ざ · confused 3\/6/);
  assert.ok(cell().classList.contains("selected"), "clicked cell is marked selected");
});

test("dashboard: a one-sided cell reads 'consistent', not 'no clear trend'", async (t) => {
  // 8 sa-questions with za offered, always answered sa → never confused (0/8).
  const uid = await freshTestUser();
  const t0 = Date.now();
  const events = Array.from({ length: 8 }, (_, i) =>
    ({ ts: t0 + i, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }));
  assert.equal((await postEvents(uid, events)).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`);
  t.after(close);
  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);
  const detail = win.document.getElementById("confdetail");

  await waitFor(() => cell("sa", "sa")?.textContent === "8/8", WAIT);   // diagonal (shown): 8 correct of 8 → render done
  cell("sa", "za").click();
  await waitFor(() => !detail.hidden && detail.querySelector(".cd-head"), WAIT);
  assert.match(detail.querySelector(".cd-head").textContent, /confused 0\/8 · consistent/);
  assert.equal(detail.querySelectorAll("svg polyline").length, 0, "no trend line for a flat cell");
});

test("admin: confusion matrix uses server-aggregated asked vs shown counts", { skip: LIVE }, async (t) => {
  // Local-only: needs power_user granted via local SQL, and unlike the rest its
  // rows must stay *in* the aggregate (so its uid is NOT a TestUser). The admin
  // matrix is global (all users), so we can't assert exact counts against a
  // snapshot — add the sa fixture and assert robust shape: an integer in asked
  // mode, "picked/offered" with picked<=offered in shown.
  const uid = randomUUID();
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);
  grantPowerUser(uid, 1);

  const { win, close } = await openPage(`/admin/?uid=${uid}`);
  t.after(close);

  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  // Default "shown" mode: "picked/offered", picked<=offered, offered >= the 5 we added.
  const shown = await waitFor(() => {
    const txt = cell("sa", "za")?.textContent;
    return /^\d+\/\d+$/.test(txt || "") ? txt : null;
  });
  const m = shown.match(/^(\d+)\/(\d+)$/);
  const [, picked, offered] = m.map(Number);
  assert.ok(picked <= offered, `picked ${picked} <= offered ${offered}`);
  assert.ok(offered >= 5, `offered >= 5 (got ${offered})`);

  // Toggle to "asked": integer >= the 3 sa->za we added.
  win.document.querySelector('#confdenom button[data-denom="asked"]').click();
  await win.happyDOM.waitUntilComplete();
  const asked = cell("sa", "za").textContent;
  assert.match(asked, /^\d+$/, `asked sa/za is an integer (got ${JSON.stringify(asked)})`);
  assert.ok(Number(asked) >= 3, `asked sa/za >= 3 (got ${asked})`);
});

test("dashboard: detects local-tally drift and syncs from the server", async (t) => {
  // The viewer's OWN dashboard, but this device's grind_tally is empty while the
  // server has confusion data → drift notice. Sync rebuilds the tally from the
  // events. (This is the after-a-local-reset case the feature exists for.)
  const uid = await freshTestUser();
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => {
      w.localStorage.setItem("uid", uid);            // viewing our OWN data
      w.localStorage.setItem("grind_tally", "{}");   // but the device tally is empty
    },
  });
  t.after(close);
  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  await waitFor(() => cell("sa", "za")?.textContent === "3/5", WAIT);   // matrix rendered
  assert.equal(win.syncnotice.hidden, false, "empty tally vs server data is flagged as drift");

  win.syncbtn.click();
  const tally = JSON.parse(win.localStorage.getItem("grind_tally"));
  assert.deepEqual(tally.sa, { n: 6, correct: 2, conf: { za: 3, sya: 1 }, offered: { za: 5, sya: 1 } });
  assert.match(win.syncnotice.textContent, /Synced/);
});

test("dashboard: no drift notice when the local tally already matches", async (t) => {
  const uid = await freshTestUser();
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => {
      w.localStorage.setItem("uid", uid);
      w.localStorage.setItem("grind_tally", JSON.stringify({
        sa: { n: 6, correct: 2, conf: { za: 3, sya: 1 }, offered: { za: 5, sya: 1 } },
      }));
    },
  });
  t.after(close);
  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  await waitFor(() => cell("sa", "za")?.textContent === "3/5", WAIT);
  assert.equal(win.syncnotice.hidden, true, "matching tally → no drift notice");
});

test("dashboard: no drift notice when viewing someone else's data", async (t) => {
  // Drift is about THIS device's tally, which only reflects the viewer's own
  // answers — so drilling into another uid never flags it, however stale.
  const other = await freshTestUser();
  assert.equal((await postEvents(other, saFixture(Date.now()))).status, 200);
  const me = randomUUID();   // viewer writes nothing; only a localStorage identity

  const { win, close } = await openPage(`/dashboard/?uid=${other}`, {
    setup: (w) => {
      w.localStorage.setItem("uid", me);             // viewer is someone else
      w.localStorage.setItem("grind_tally", "{}");   // whose empty tally would "drift"
    },
  });
  t.after(close);
  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  await waitFor(() => cell("sa", "za")?.textContent === "3/5", WAIT);
  assert.equal(win.syncnotice.hidden, true, "another user's matrix never flags local drift");
});
