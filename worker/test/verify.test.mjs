// Post-deploy verification of the LIVE system. Unlike the pre-deploy DOM tests
// (which build dist/ and boot a local worker), this fetches the *actually
// deployed* dashboard from Pages and runs it in happy-dom: served from
// mimi.ganba.re, the page's own STATS_URL points at the live worker, so the
// fetches hit the real deployment — a true end-to-end check of what's serving.
//
// Safe to run against production: it only writes under the TestUser sentinel uid
// (excluded from aggregates). Driven by scripts/verify.sh (CI post-deploy + by
// hand). SITE/BASE default to production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHtml, waitFor } from "./dom.mjs";

const SITE = (process.env.SITE || "https://mimi.ganba.re").replace(/\/$/, "");
const BASE = (process.env.BASE || "https://mimi-stats.golddranks.workers.dev").replace(/\/$/, "");
const SENTINEL = "00000000-0000-4000-8000-000000000000";

const sentinelEvents = async () =>
  (await (await fetch(`${BASE}/v1/user/${SENTINEL}/events`)).json()).events || [];

test("verify: the deployed app saves answers to the live worker", async (t) => {
  // The load-bearing data-collection path: the deployed app, talking to the live
  // worker, must actually persist answers. Drive it in happy-dom pinned to the
  // sentinel uid (so it runs in normal save mode — not ?uid= view-as — but writes
  // only excluded rows), then read the events back off the live worker.
  const start = Date.now();
  const html = await (await fetch(`${SITE}/`)).text();
  const { win, close } = await loadHtml(html, {
    url: `${SITE}/`,
    setup: (w) => w.localStorage.setItem("uid", SENTINEL),
  });
  t.after(close);
  assert.equal(win.localStorage.getItem("uid"), SENTINEL, "app pinned to the sentinel uid");

  // Answer a few questions; each queues an event the app flushes to the worker.
  for (let i = 0; i < 3; i++) {
    win.primary.click();
    const btns = await waitFor(() => {
      const b = win.choices.querySelectorAll("button.choice");
      return b.length ? b : null;
    });
    btns[0].click();
  }

  // Read them back off the live worker — proves the write round-tripped and
  // persisted, carrying the opts column data collection depends on.
  const fresh = await waitFor(async () => {
    const mine = (await sentinelEvents()).filter((e) => e.ts >= start && (e.ev === "a" || e.ev === "g"));
    return mine.length ? mine : null;
  }, { timeout: 15000 });
  assert.ok(
    fresh.some((e) => typeof e.opts === "string" && e.opts.includes(",")),
    "a saved answer carries the opts column end-to-end",
  );
});

test("verify: the deployed dashboard renders sentinel events from the live worker", async (t) => {
  // Seed a known confusion under the sentinel via the live worker (sa picked as
  // za once, correct once). The cell only grows across runs — >= tolerates it.
  const ts = Date.now();
  const events = [
    { ts, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 },
    { ts: ts + 1, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 },
  ];
  const post = await fetch(`${BASE}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: SENTINEL, events }),
  });
  assert.equal(post.status, 200, `POST ${BASE}/v1/events`);

  // Fetch and run the deployed dashboard itself.
  const pageUrl = `${SITE}/dashboard/?uid=${SENTINEL}`;
  const res = await fetch(pageUrl);
  assert.equal(res.status, 200, `GET ${pageUrl}`);
  const { win, close } = await loadHtml(await res.text(), { url: pageUrl });
  t.after(close);

  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  // The deployed page fetched the sentinel's events from the live worker and
  // rendered them. The default "shown" mode reads picked/offered — proving opts
  // flows end-to-end on the live stack.
  const shown = await waitFor(() => {
    const txt = cell("sa", "za")?.textContent;
    return /^\d+\/\d+$/.test(txt || "") ? txt : null;
  }, { timeout: 15000 });
  const [picked, offered] = shown.split("/").map(Number);
  assert.ok(picked >= 1 && offered >= picked, `shown sa/za: ${picked}/${offered}`);

  // "asked" mode is the raw pick count.
  win.document.querySelector('#confdenom button[data-denom="asked"]').click();
  await win.happyDOM.waitUntilComplete();
  assert.match(cell("sa", "za").textContent, /^\d+$/);
});
