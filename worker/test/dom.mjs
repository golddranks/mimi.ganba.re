// happy-dom loader for the BUILT pages. dist/ pages are self-contained — esbuild
// IIFE bundle + data (VOICE_COUNTS / VOICE_MAP) inlined by scripts/build.py — so
// there are no external scripts to fetch. document.write() runs the inline
// scripts in situ (so document.currentScript is set, which the dashboard's
// uid-display helper relies on), after we install the few browser bits the
// pages need that happy-dom lacks.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

const here = dirname(fileURLToPath(import.meta.url));
export const DIST = resolve(here, "../../dist");

export async function loadPage(file, { url, workerBase }) {
  const html = readFileSync(resolve(DIST, file), "utf8");
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
