// Full-stack DOM e2e: drive the BUILT pages in happy-dom against a live local
// worker (booted on a prod snapshot by scripts/smoke.sh). The app's answers POST
// real events through the worker into D1; the dashboard reads them back and
// renders. Local-only — needs dist/ built and a writable local DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadPage, waitFor } from "./dom.mjs";

const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");
// hostname localhost/127.0.0.1 makes the pages target the local worker on :8787.
const ORIGIN = "http://127.0.0.1:8080";

const getEvents = async (uid) =>
  (await (await fetch(`${BASE}/v1/user/${encodeURIComponent(uid)}/events`)).json()).events || [];

test("app: answering questions posts events (with opts) to the worker", async (t) => {
  const { win, close } = await loadPage("index.html", { url: ORIGIN + "/" });
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

test("dashboard: confusion matrix renders asked vs shown denominators", async (t) => {
  // Deterministic answers for sound "sa":
  //   3x picked za, opts [sa,za]   — za offered & wrongly picked
  //   2x picked sa, opts [sa,za]   — za offered, answered correctly
  //   1x picked sya, opts [sa,sya] — za NOT offered this time
  // => za: picked 3, offered 5.   sya: picked 1, offered 1.
  const uid = randomUUID();
  const t0 = Date.now();
  const mk = (i, picked, opts) =>
    ({ ts: t0 + i, target: "sa", idx: 0, picked, cap: opts.length, ms: 500, ev: "a", opts, skill: 0 });
  const events = [
    mk(1, "za", ["sa", "za"]), mk(2, "za", ["sa", "za"]), mk(3, "za", ["sa", "za"]),
    mk(4, "sa", ["sa", "za"]), mk(5, "sa", ["sa", "za"]),
    mk(6, "sya", ["sa", "sya"]),
  ];
  const post = await fetch(`${BASE}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, events }),
  });
  assert.equal(post.status, 200);

  const { win, close } = await loadPage("dashboard/index.html", { url: `${ORIGIN}/dashboard/?uid=${uid}` });
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
