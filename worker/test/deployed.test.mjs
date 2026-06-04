// Prod-safe end-to-end check, run against an already-deployed worker (the CI
// post-deploy step, or `./scripts/smoke.sh <url>` by hand). It drives the real
// built dashboard bundle in happy-dom against the LIVE worker, exercising the
// deployed frontend -> worker -> D1 path.
//
// Safe against production because it only ever writes under the TestUser
// sentinel uid, which the admin aggregates exclude (nickname 'TestUser'); the
// per-user dashboard still renders those rows. The app/admin DOM tests stay
// local-only — they write non-sentinel rows or poke the local D1 directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, waitFor } from "./dom.mjs";

const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");
const ORIGIN = "http://127.0.0.1:8080";
// Same sentinel as seed.sql / api.test.mjs — excluded from aggregates.
const SENTINEL = "00000000-0000-4000-8000-000000000000";

test("deployed: dashboard renders sentinel events from the live worker", async (t) => {
  // Seed a known confusion under the sentinel (sa picked as za once, correct
  // once). The cell only grows across runs, which the >= assertions tolerate.
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
  assert.equal(post.status, 200);

  const { win, close } = await loadPage("dashboard/index.html",
    { url: `${ORIGIN}/dashboard/?uid=${SENTINEL}`, workerBase: BASE });
  t.after(close);

  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  // The deployed frontend fetched the sentinel's events from the live worker and
  // rendered them: sa->za is a non-empty pick count in the default "asked" mode.
  const asked = await waitFor(() => {
    const txt = cell("sa", "za")?.textContent;
    return /^\d+$/.test(txt || "") ? Number(txt) : null;
  });
  assert.ok(asked >= 1, `asked sa/za >= 1 (got ${asked})`);

  // "shown" mode proves opts flows end-to-end on the deployed stack: picked/offered.
  win.document.querySelector('#confdenom button[data-denom="shown"]').click();
  await win.happyDOM.waitUntilComplete();
  assert.match(cell("sa", "za").textContent, /^\d+\/\d+$/);
});
