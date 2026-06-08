// happy-dom loader for the BUILT pages. dist/ pages are self-contained — esbuild
// IIFE bundle + data (VOICE_COUNTS / VOICE_MAP) inlined by scripts/build.py — so
// there are no external scripts to fetch. document.write() runs the inline
// scripts in situ (so document.currentScript is set, which the dashboard's
// uid-display helper relies on), after we install the few browser bits the
// pages need that happy-dom lacks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

const here = dirname(fileURLToPath(import.meta.url));
export const DIST = resolve(here, "../../dist");

// Test target. Default: the BUILT dist pages driven against a local worker
// (booted by e2e.sh; BASE is its origin). Set SITE to run the SAME suite
// against a deployed site instead — verify.sh points SITE/BASE at production.
// LIVE flips both the page source (fetch the deployed HTML vs read local dist)
// and the worker wiring (a deployed page targets its own worker; locally we
// rewrite the dist page's hardcoded :8787 origin to BASE).
export const LIVE = !!process.env.SITE;
export const SITE = (process.env.SITE || "http://127.0.0.1:8080").replace(/\/$/, "");
export const WORKER = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");

// Load a page from a local dist file (the local DOM tests).
export async function loadPage(file, opts) {
  return loadHtml(readFileSync(resolve(DIST, file), "utf8"), opts);
}

// Run a page given its full HTML — local dist or HTML fetched from a deployed
// site (the post-deploy verify). `workerBase` rewrites the pages' hardcoded
// localhost:8787 worker origin; omit it for a deployed page, which already
// targets the live worker via its own hostname-derived STATS_URL. `setup(win)`
// runs after the stubs but before the page boots — use it to seed localStorage
// (e.g. pin the app's uid to the sentinel before it mints a random one).
export async function loadHtml(html, { url, workerBase, setup } = {}) {
  const win = new Window({ url });
  const logs = [];
  win.console.log = (...a) => logs.push(a.join(" "));
  win.console.error = (...a) => logs.push("ERROR " + a.join(" "));

  // Install stubs BEFORE writing, since document.write executes the page's
  // boot scripts synchronously as it parses.
  // play() is called as audio.play().catch(...); happy-dom doesn't decode media.
  win.HTMLMediaElement.prototype.play = () => Promise.resolve();
  // reminders.js consults Notification; a denied stub makes it a no-op.
  if (!win.Notification) win.Notification = { permission: "denied", requestPermission: async () => "denied" };
  // Node's fetch reaches the local worker without happy-dom's same-origin/CORS
  // layer (page is :8080, worker :8787). The pages hardcode their STATS_URL at
  // :8787; rewrite that origin to wherever the harness actually booted the
  // worker (the pre-push hook uses :8799), so the DOM tests are port-agnostic.
  const pageWorker = `http://${win.location.hostname}:8787`;
  win.fetch = (u, init) => {
    let s = String(u);
    if (workerBase && s.startsWith(pageWorker)) s = workerBase + s.slice(pageWorker.length);
    return globalThis.fetch(s, init);
  };

  if (setup) setup(win);

  // document.write builds the DOM but does not run inline scripts in happy-dom,
  // so we eval each one ourselves in document order. document.currentScript is
  // getter-only; shadow it so a script can locate its own element (the
  // dashboard's uid-display helper reads currentScript.previousElementSibling).
  win.document.write(html);
  win.document.close();
  let currentScript = null;
  Object.defineProperty(win.document, "currentScript", { configurable: true, get: () => currentScript });
  for (const s of win.document.querySelectorAll("script")) {
    currentScript = s;
    win.eval(s.textContent);
  }
  currentScript = null;

  await win.happyDOM.waitUntilComplete();
  return { win, logs, close: () => win.happyDOM.close() };
}

// Open an app page by URL path ("/", "/dashboard/?uid=…", "/?morning"),
// abstracting over the target so test bodies run identically on either. Live:
// fetch the deployed HTML, which already talks to the live worker. Local: load
// the matching built dist file and rewrite its :8787 worker origin to BASE.
const distFileFor = (path) =>
  path.startsWith("/dashboard") ? "dashboard/index.html"
    : path.startsWith("/admin") ? "admin/index.html"
      : "index.html";

export async function openPage(path, { setup } = {}) {
  const url = SITE + path;
  if (LIVE) return loadHtml(await (await fetch(url)).text(), { url, setup });
  return loadPage(distFileFor(path), { url, workerBase: WORKER, setup });
}

// Poll until predicate() returns truthy, or throw on timeout. The pages fire
// Node fetches that happy-dom's task queue doesn't track, so waitUntilComplete()
// can return before the response lands — poll the resulting state instead.
export async function waitFor(predicate, { timeout = 5000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, step));
  }
}

// Read the given confusion-matrix cells, enforcing the rendered-format contract:
// every cell is picked/offered ("n/n"), the pairwise pick-when-offered view (the
// only denominator now — "vs asked" was retired). That contract is the part that
// drifted between the pre-deploy (dom.test) and post-deploy (verify.test) suites;
// keeping it here makes the two share one source of truth. Returns
// "T/P" -> { picked, offered }; the caller asserts the actual numbers (exact for
// a fixture, bounded for the ever-growing prod sentinel).
export async function readConfusion(win, cells) {
  const cell = (t, p) => win.confchart.querySelector(`td[data-t="${t}"][data-p="${p}"]`);
  const [t0, p0] = cells[0];
  await waitFor(() => /^\d+\/\d+$/.test(cell(t0, p0)?.textContent || "") || null, { timeout: 15000 });

  const out = {};
  for (const [t, p] of cells) {
    const shown = cell(t, p).textContent;
    assert.match(shown, /^\d+\/\d+$/, `shown ${t}/${p}`);
    const [picked, offered] = shown.split("/").map(Number);
    out[`${t}/${p}`] = { picked, offered };
  }
  return out;
}
