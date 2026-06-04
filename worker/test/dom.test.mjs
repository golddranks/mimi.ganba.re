// Full-stack DOM e2e: drive the BUILT pages in happy-dom against a live local
// worker (booted on a prod snapshot by scripts/smoke.sh). The app's answers POST
// real events through the worker into D1; the dashboard reads them back and
// renders. Local-only — needs dist/ built and a writable local DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadPage, waitFor } from "./dom.mjs";

const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");
// hostname localhost/127.0.0.1 makes the pages target the local worker on :8787.
const ORIGIN = "http://127.0.0.1:8080";

const getEvents = async (uid) =>
  (await (await fetch(`${BASE}/v1/user/${encodeURIComponent(uid)}/events`)).json()).events || [];

const postEvents = (uid, events) =>
  fetch(`${BASE}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, events }),
  });

// power_user has no API setter (it's granted by hand via SQL), so poke the local
// D1 the dev worker reads. Local-only, like this whole suite; runs from worker/.
// Honors WRANGLER_PERSIST so it targets the same state dir the worker booted on
// (smoke.sh uses the default; an isolated test run can point both at a temp dir).
const grantPowerUser = (uid, level = 1) => {
  const args = ["wrangler", "d1", "execute", "mimi-stats", "--local"];
  if (process.env.WRANGLER_PERSIST) args.push("--persist-to", process.env.WRANGLER_PERSIST);
  args.push("--command", `UPDATE users SET power_user=${level} WHERE uid='${uid}'`);
  execFileSync("npx", args, { stdio: "ignore" });
};

// Six deterministic answers for sound "sa", reused by the dashboard and admin
// tests: za picked 3x & offered 5x, sa picked 2x, sya picked 1x & offered 1x.
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
  const { win, close } = await loadPage("index.html", { url: ORIGIN + "/", workerBase: BASE });
  t.after(close);

  const uid = win.localStorage.uid;
  assert.match(uid, /^[0-9a-f-]{36}$/, "app generated a uid");

  // Each loop starts a question (primary doubles as Start / Next) and answers
  // the first choice. Right answers auto-advance, wrong ones surface Next —
  // clicking primary again covers both. Poll for the rendered choices rather
  // than waitUntilComplete, which would block on the app's 5s flush-retry timer.
  for (let i = 0; i < 6; i++) {
    win.primary.click();
    const btns = await waitFor(() => {
      const b = win.choices.querySelectorAll("button.choice");
      return b.length ? b : null;
    });
    btns[0].click();
  }

  const events = await waitFor(async () => {
    const ev = await getEvents(uid);
    return ev.length ? ev : null;
  });
  const answers = events.filter((e) => e.ev === "a" || e.ev === "g");
  assert.ok(answers.length >= 1, "at least one answer event persisted");
  assert.ok(
    answers.some((e) => typeof e.opts === "string" && e.opts.includes(",")),
    "answer events carry the opts column end-to-end",
  );
});

test("app: a Y/N question saves a y event end to end", async (t) => {
  const { win, close } = await loadPage("index.html", {
    url: ORIGIN + "/",
    workerBase: BASE,
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

  win.primary.click();
  await waitFor(() => !win.yn.hidden);
  assert.equal(win.ynprompt.textContent, "さ");
  win.ynyes.click();   // ○: さ is the sa sound → correct

  const yn = await waitFor(async () => {
    const e = (await getEvents(uid)).filter((x) => x.ev === "y" || x.ev === "n");
    return e.length ? e : null;
  });
  assert.equal(yn[0].ev, "y");
  assert.equal(yn[0].picked, "sa");
});

test("app: day-start probing drills the uncertain confusion (released without the grind flag)", async (t) => {
  const { win, close } = await loadPage("index.html", {
    url: ORIGIN + "/",
    setup: (w) => {
      // sa→za: 2 wrong of 3 offered → uncertain → the probe target. No stats
      // today, so the day-start probe phase starts even with grind off.
      w.localStorage.setItem("grind_tally", JSON.stringify({
        sa: { n: 3, correct: 1, conf: { za: 2 }, offered: { za: 3 } },
      }));
    },
  });
  t.after(close);

  win.primary.click();
  const btns = await waitFor(() => {
    const b = win.choices.querySelectorAll("button.choice");
    return b.length ? b : null;
  });
  const morae = [...btns].map((b) => b.dataset.mora).sort();
  assert.deepEqual(morae, ["sa", "za"], "probe drills the sa/za pair as a 2-button question");
});

test("dashboard: confusion matrix renders asked vs shown denominators", async (t) => {
  // Per-uid view, so counts are exact. With the sa fixture, za is picked 3x &
  // offered 5x, sya picked 1x & offered 1x.
  const uid = randomUUID();
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);

  const { win, close } = await loadPage("dashboard/index.html", { url: `${ORIGIN}/dashboard/?uid=${uid}`, workerBase: BASE });
  t.after(close);

  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  // Default "asked" mode: off-diagonal cell is the raw pick count.
  await waitFor(() => cell("sa", "za")?.textContent === "3");
  assert.equal(cell("sa", "sya").textContent, "1");

  // "shown" mode: picked / times-that-kana-was-offered.
  win.document.querySelector('#confdenom button[data-denom="shown"]').click();
  await win.happyDOM.waitUntilComplete();
  assert.equal(cell("sa", "za").textContent, "3/5");
  assert.equal(cell("sa", "sya").textContent, "1/1");
});

test("dashboard: confusion matrix marks grind and probe targets", async (t) => {
  // sa->za: 10 wrong of 10 offered -> confidently >20% -> grind.
  // sa->sya: 2 wrong of 3 offered -> uncertain, highest such rate -> probe.
  const uid = randomUUID();
  const t0 = Date.now();
  const mk = (i, picked, opts) =>
    ({ ts: t0 + i, target: "sa", idx: 0, picked, cap: opts.length, ms: 500, ev: "a", opts, skill: 0 });
  const events = [];
  for (let i = 0; i < 10; i++) events.push(mk(i, "za", ["sa", "za"]));
  events.push(mk(10, "sya", ["sa", "sya"]), mk(11, "sya", ["sa", "sya"]), mk(12, "sa", ["sa", "sya"]));
  assert.equal((await postEvents(uid, events)).status, 200);

  const { win, close } = await loadPage("dashboard/index.html", { url: `${ORIGIN}/dashboard/?uid=${uid}`, workerBase: BASE });
  t.after(close);
  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  await waitFor(() => cell("sa", "za")?.classList.contains("grind"));
  assert.ok(!cell("sa", "za").classList.contains("probe"), "grind cell isn't also probe");
  assert.ok(cell("sa", "sya").classList.contains("probe"), "sa/sya is the probe target");
  assert.ok(!cell("sa", "sya").classList.contains("grind"), "probe cell isn't grind");
  // The diagonal (correct) is never a target.
  assert.ok(!cell("sa", "sa").classList.contains("grind") && !cell("sa", "sa").classList.contains("probe"));
});

test("dashboard: clicking a confusion cell shows its history strip", async (t) => {
  // 6 sa-questions with za offered: picked za (red) 3x, sa (green) 3x.
  const uid = randomUUID();
  const t0 = Date.now();
  const mk = (i, picked) => ({ ts: t0 + i, target: "sa", idx: 0, picked, cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 });
  const events = [mk(1, "za"), mk(2, "sa"), mk(3, "za"), mk(4, "sa"), mk(5, "za"), mk(6, "sa")];
  assert.equal((await postEvents(uid, events)).status, 200);

  const { win, close } = await loadPage("dashboard/index.html", { url: `${ORIGIN}/dashboard/?uid=${uid}`, workerBase: BASE });
  t.after(close);
  const cell = () => win.confchart.querySelector('td[data-t="sa"][data-p="za"]');
  const detail = win.document.getElementById("confdetail");

  await waitFor(() => cell()?.textContent === "3");   // matrix rendered (asked count of za = 3)
  assert.ok(detail.hidden, "history hidden until a cell is clicked");
  cell().click();

  await waitFor(() => !detail.hidden && detail.querySelectorAll("svg rect").length > 0);
  assert.equal(detail.querySelectorAll("svg rect").length, 6, "one box per offered event");
  assert.match(detail.querySelector(".cd-head").textContent, /→ ざ · confused 3\/6/);
  assert.ok(cell().classList.contains("selected"), "clicked cell is marked selected");
});

test("admin: confusion matrix uses server-aggregated asked vs shown counts", async (t) => {
  // The admin matrix is global (all users), so we can't assert exact counts
  // against a prod snapshot — we add the sa fixture and assert robust shape:
  // an integer in asked mode, "picked/offered" with picked<=offered in shown.
  const uid = randomUUID();
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);
  grantPowerUser(uid, 1);

  const { win, close } = await loadPage("admin/index.html", { url: `${ORIGIN}/admin/?uid=${uid}`, workerBase: BASE });
  t.after(close);

  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  // Asked mode: integer >= the 3 sa->za we just added.
  const asked = await waitFor(() => {
    const txt = cell("sa", "za")?.textContent;
    return /^\d+$/.test(txt || "") ? Number(txt) : null;
  });
  assert.ok(asked >= 3, `asked sa/za >= 3 (got ${asked})`);

  // Shown mode: "picked/offered", picked<=offered, offered >= the 5 we added.
  win.document.querySelector('#confdenom button[data-denom="shown"]').click();
  await win.happyDOM.waitUntilComplete();
  const shown = cell("sa", "za").textContent;
  const m = shown.match(/^(\d+)\/(\d+)$/);
  assert.ok(m, `shown sa/za is "picked/offered" (got ${JSON.stringify(shown)})`);
  const [, picked, offered] = m.map(Number);
  assert.ok(picked <= offered, `picked ${picked} <= offered ${offered}`);
  assert.ok(offered >= 5, `offered >= 5 (got ${offered})`);
});
