// Full-stack DOM e2e: drive the app pages in happy-dom against a real worker.
// The app's answers POST real events through the worker into D1; the dashboard
// reads them back and renders. One set of cases, two targets:
//   - local (default): built dist/ + a worker booted by scripts/e2e.sh
//   - live (SITE set): the deployed Pages site + live worker, post-deploy, via
//     scripts/verify.sh
// openPage() hides the difference. HARD RULE: every uid the suite posts answers
// under goes through freshTestUser(), which stamps the TestUser canary (nickname
// TEST_NICK + sentinel tz TEST_TZ; see sentinel.mjs) so a test row can NEVER look
// organic — even role-0 "counted" users that aggregates must include (those just
// can't be role 1, which the worker excludes; they stay in the aggregate but the
// nickname keeps them identifiable, and showing up in prod is then a visible
// canary). Tests whose data must count in a global aggregate use freshTestUser({
// role: 0 }) and skip in live mode (their rows would otherwise pollute prod). The
// guard test at the end enforces the canary nickname on every answer-posting uid.
import "./retry-fetch.mjs";   // tolerate wrangler dev's occasional keep-alive socket resets
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openPage, waitFor, readConfusion, LIVE, ISOLATED, WORKER } from "./dom.mjs";
import { daysAgo } from "../../src/shared/dates.js";
import { TEST_NICK, TEST_TZ } from "./sentinel.mjs";

const getEvents = async (uid) =>
  (await (await fetch(`${WORKER}/v1/user/${encodeURIComponent(uid)}/events`)).json()).events || [];

const getUserRole = async (uid) =>
  (await (await fetch(`${WORKER}/v1/user/${encodeURIComponent(uid)}/events`)).json()).role;

const postEvents = (uid, events, tz) =>
  fetch(`${WORKER}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tz == null ? { uid, events } : { uid, events, tz }),
  });

// Register a uid as a test user. ALWAYS stamps the canary nickname (TEST_NICK)
// and a sentinel tz (TEST_TZ) so no test row can ever look organic — even role-0
// "counted" users that aggregates must include (role 1 is the prod-excluded,
// janitor-purged kind; role 0 stays visible as a leak canary). The guard test at
// the end of this file enforces the nickname on every user that posts answers.
//   role: 0 = counted in aggregates, 1 = excluded (default), 2 = native.
//   tz:   pass null to leave it unset — only the "no tz → JST default" tests
//         (which must exercise a real stale-client's null tz) do this.
const registerTestUser = (uid, { role = 1, tz = TEST_TZ } = {}) =>
  fetch(`${WORKER}/v1/user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tz == null
      ? { uid, nickname: TEST_NICK, role }
      : { uid, nickname: TEST_NICK, role, tz }),
  });

const freshTestUser = async (opts) => {
  const uid = randomUUID();
  await registerTestUser(uid, opts);
  return uid;
};

// Worker-dependent waits cross the network; give them room on the live target.
const WAIT = { timeout: LIVE ? 20000 : 5000 };

// power_user has no API setter (granted by hand via SQL), so poke the local D1
// the dev worker reads. Local-only — the admin test that uses it skips live.
// Honors WRANGLER_PERSIST so it targets the state dir e2e.sh booted on.
// Run SQL against the local D1 the dev worker reads (honors WRANGLER_PERSIST).
// Returns result rows (empty for writes). Local-only — callers skip live.
const localSql = (sql) => {
  const args = ["wrangler", "d1", "execute", "mimi-stats", "--local"];
  if (process.env.WRANGLER_PERSIST) args.push("--persist-to", process.env.WRANGLER_PERSIST);
  args.push("--json", "--command", sql);
  return JSON.parse(execFileSync("npx", args, { encoding: "utf8" }))[0].results || [];
};
const grantPowerUser = (uid, level = 1) => localSql(`UPDATE users SET power_user=${level} WHERE uid='${uid}'`);

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

// skip on LIVE: a fresh-device nick POST would write a role-0 user to prod.
test("app: ?nick prompts for a nickname once, then not again", { skip: LIVE }, async (t) => {
  let asked = 0;
  const fresh = await openPage("/?nick", { setup: (w) => { w.prompt = () => { asked++; return "Pingu"; }; } });
  t.after(fresh.close);
  assert.equal(asked, 1, "prompted on a fresh device");
  assert.equal(fresh.win.localStorage.nick, "Pingu", "stored the nickname locally");

  // Already set → ?nick must not prompt again.
  const again = await openPage("/?nick", {
    setup: (w) => { w.localStorage.setItem("nick", "Keep"); w.prompt = () => { throw new Error("re-prompted"); }; },
  });
  t.after(again.close);
  assert.equal(again.win.localStorage.nick, "Keep");
});

// skip on LIVE: opting in would tag a prod user role 2.
test("app: ?nativeTester prompts and persists the native-mode flag", { skip: LIVE }, async (t) => {
  let asked = 0;
  const { win, close } = await openPage("/?nativeTester", { setup: (w) => { w.prompt = () => { asked++; return "ネイティブ"; }; } });
  t.after(close);
  assert.equal(asked, 1, "prompted for a nickname");
  assert.equal(win.localStorage.nativeMode, "1", "native-mode flag persisted");
});

// skip on LIVE: would tag a prod user role 2.
test("app: a native-mode device re-asserts role 2 on boot (self-heals a missed ?nativeTester POST)", { skip: LIVE }, async (t) => {
  // Device stuck in native mode locally but role 0 on the server — its one-time
  // ?nativeTester POST never landed (the fetch swallows errors).
  const uid = randomUUID();
  await fetch(`${WORKER}/v1/user`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, nickname: "Native" }),
  });
  assert.equal(await getUserRole(uid), 0, "starts role 0");

  // A plain boot (no ?nativeTester) under that uid should self-heal it to role 2.
  const { close } = await openPage("/", { setup: (w) => {
    w.localStorage.setItem("uid", uid);
    w.localStorage.setItem("nativeMode", "1");
    w.localStorage.setItem("nick", "Native");
  } });
  t.after(close);
  await waitFor(async () => (await getUserRole(uid)) === 2 || null, WAIT);
});

// skip on LIVE: opening a fresh "/" would create a role-0 prod user.
test("app: the top-left dashboard link carries ?uid in view-as", { skip: LIVE }, async (t) => {
  const own = await openPage("/");
  t.after(own.close);
  assert.equal(own.win.dashlink.getAttribute("href"), "dashboard/", "own session links to the bare dashboard");

  const uid = await freshTestUser();
  await postEvents(uid, saFixture(Date.now()));
  const va = await openPage(`/?uid=${uid}`);
  t.after(va.close);
  await waitFor(() => va.win.score.textContent.includes("out of 6") ? true : null, WAIT);   // loadAsUser's render landed
  assert.equal(va.win.dashlink.getAttribute("href"), `dashboard/?uid=${uid}`, "view-as keeps the uid on the dashboard link");
});

// skip on LIVE: opens a fresh "/" and fakes /version.json.
test("app: nudges to reload when a newer build is deployed", { skip: LIVE }, async (t) => {
  const { win, close } = await openPage("/", {
    setup: (w) => {
      const real = w.fetch.bind(w);
      w.fetch = (u, o) => String(u).includes("/version.json")
        ? Promise.resolve(new w.Response('{"sha":"newer-than-this-build"}', { status: 200 }))
        : real(u, o);
    },
  });
  t.after(close);
  assert.ok(win.BUILD_SHA && win.BUILD_SHA !== "dev", "build embedded a real BUILD_SHA");
  await waitFor(() => win.updatebar && !win.updatebar.hidden ? true : null, WAIT);
  assert.match(win.updatebar.textContent, /New version available/);
});

// skip on LIVE: posts role-0 events (the ranking's input), which would pollute
// prod. The exact presence/absence assertions also need an isolated DB — the
// global top-200 only reflects this scenario when it's the only data (a prod
// snapshot adds its own zo pairs and can evict these via the 200-cap) — so those
// are gated on ISOLATED, while the endpoint itself is exercised on the snapshot.
test("native pairs: keeps high-wrong recordings, drops expert-vetted ones", { skip: LIVE }, async () => {
  const answer = (uid, confuser, n, correct = false) =>
    postEvents(uid, Array.from({ length: n }, (_, i) => ({
      ts: Date.now() + i, target: "zo", idx: 0, picked: correct ? "zo" : confuser,
      cap: 2, ms: 500, ev: "a", opts: ["zo", confuser], skill: 0,
    })));
  // (zo#0, so): a normal listener picks 'so' 3/3 → high wrong-rate, no expert data → kept.
  await answer(await freshTestUser({ role: 0 }), "so", 3);
  // (zo#0, syo): a normal listener also confuses it (3/3 wrong) ...
  await answer(await freshTestUser({ role: 0 }), "syo", 3);
  // ... but 6 high-accuracy (100% 'zo') offers of 'syo' vet it → dropped despite the wrong-rate.
  await answer(await freshTestUser({ role: 0 }), "syo", 6, true);

  const { pairs } = await (await fetch(`${WORKER}/v1/native/pairs`)).json();
  assert.ok(Array.isArray(pairs) && pairs.every((p) => p.mora && Number.isInteger(p.idx) && p.confuser),
    "returns well-formed {mora, idx, confuser} pairs");
  assert.ok(pairs.every((p) => Number.isInteger(p.offered) && Number.isInteger(p.wrong) && p.wrong <= p.offered && p.offered > 0),
    "each pair carries debug counts (wrong ≤ offered)");
  if (!ISOLATED) return;   // exact ranking membership only holds on a fresh DB
  const has = (c) => pairs.some((p) => p.mora === "zo" && p.confuser === c);
  assert.ok(has("so"), "kept the high-wrong, un-vetted pair");
  assert.ok(!has("syo"), "dropped the pair vetted by ≥5 expert offers");
});

// skip on LIVE: posts role-0 seed data and role-0 native answers.
test("app: native mode drills forced 2-choice pairs from the ranking", { skip: LIVE }, async (t) => {
  // Seed a confusable recording so the ranking has a pair to serve.
  await postEvents(await freshTestUser({ role: 0 }), Array.from({ length: 3 }, (_, i) => ({
    ts: Date.now() + i, target: "su", idx: 0, picked: "zu", cap: 2, ms: 500, ev: "a", opts: ["su", "zu"], skill: 0,
  })));

  const { win, close } = await openPage("/", { setup: (w) => { w.localStorage.setItem("nativeMode", "1"); w.localStorage.setItem("nick", TEST_NICK); } });
  t.after(close);
  const uid = win.localStorage.uid;

  // Native testers see a thank-you, not the learner-progress message.
  assert.equal(win.message.textContent, "音声の品質向上にご協力いただき、ありがとうございます！");

  win.primary.click();
  const btns = await waitFor(() => {
    const b = win.choices.querySelectorAll("button.choice");
    return b.length ? b : null;
  }, WAIT);
  assert.equal(btns.length, 2, "native questions are always 2-choice (no Y/N, no wider sets)");

  // The played recording is the target; the other button is the confuser.
  const [, mora, idx] = win.audio.src.match(/audio\/[^/]+\/([^/]+)\/(\d+)\.opus/);
  const confuser = [...btns].map((b) => b.dataset.mora).find((m) => m !== mora);
  // On an isolated DB the two top-200 rankings agree, so the shown pair is in a
  // fresh fetch; on a snapshot they can diverge at the cap, so check only there.
  if (ISOLATED) {
    const { pairs } = await (await fetch(`${WORKER}/v1/native/pairs`)).json();
    assert.ok(
      pairs.some((p) => p.mora === mora && p.idx === Number(idx) && p.confuser === confuser),
      "the question is a (recording, confuser) pair drawn from the ranking",
    );
  }

  btns[0].click();
  const answers = await waitFor(async () => {
    const a = (await getEvents(uid)).filter((e) => e.ev === "a" || e.ev === "g");
    return a.length ? a : null;
  }, WAIT);
  assert.equal(answers[0].opts.split(",").length, 2, "records a normal 2-option answer event");
});

// skip on LIVE: posts role-0 seed + a native re-listen/answer.
test("app: a re-listen then an answer share one start_ts (the re-listen is creditable)", { skip: LIVE }, async (t) => {
  await postEvents(await freshTestUser({ role: 0 }), Array.from({ length: 3 }, (_, i) => ({
    ts: Date.now() + i, target: "su", idx: 0, picked: "zu", cap: 2, ms: 500, ev: "a", opts: ["su", "zu"], skill: 0,
  })));
  const { win, close } = await openPage("/", { setup: (w) => { w.localStorage.setItem("nativeMode", "1"); w.localStorage.setItem("nick", TEST_NICK); } });
  t.after(close);
  const uid = win.localStorage.uid;

  win.primary.click();
  const btns = await waitFor(() => {
    const b = win.choices.querySelectorAll("button.choice");
    return b.length ? b : null;
  }, WAIT);

  win.relisten.click();                       // re-listen BEFORE answering (cap-2 → free, but recorded)
  await waitFor(async () => (await getEvents(uid)).some((e) => e.ev === "r") || null, WAIT);
  btns[0].click();                            // then answer the SAME question

  const evs = await waitFor(async () => {
    const e = await getEvents(uid);
    return e.some((x) => x.ev === "r") && e.some((x) => x.ev === "a") ? e : null;
  }, WAIT);
  const r = evs.find((e) => e.ev === "r");
  const a = evs.find((e) => e.ev === "a");
  assert.ok(r.start_ts != null && r.start_ts === a.start_ts,
    `re-listen and answer share start_ts (r=${r.start_ts}, a=${a.start_ts}) so confusionExtras can credit the re-listen`);
});

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

test("app: after a correct ✕ guess in Y/N, tapping ○ replays the sound", async (t) => {
  const { win, close } = await openPage("/", {
    setup: (w) => {
      w.localStorage.setItem("mora", JSON.stringify({ s: {}, k: 0, x: { a: 20 } }));
    },
  });
  t.after(close);
  const uid = win.localStorage.uid;
  await registerTestUser(uid);

  // Force a wrong-kana Y/N question for さ: shown kana = ざ (a sibling), so ✕ is
  // correct. One newQuestion→newYNQuestion consumes five randoms: target pick, the
  // <YN_RATIO gate, pickVoice, the shown-kana coin flip (>=0.5 → sibling), and the
  // sibling pick. Set after load so boot's own randoms don't shift the sequence.
  const seq = [0, 0, 0, 0.9, 0];
  let i = 0;
  win.Math.random = () => (i < seq.length ? seq[i++] : 0);

  win.primary.click();
  await waitFor(() => !win.yn.hidden, WAIT);
  assert.equal(win.ynprompt.textContent, "ざ", "wrong-kana prompt (ざ shown while さ plays)");

  // Long-press ✕ = guess; correct (ざ ≠ the さ sound), so it stays in review.
  const fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }));
  fire(win.ynno, "pointerdown");
  await new Promise((r) => setTimeout(r, 600));   // > LONG_MS (500) → the guess fires
  fire(win.ynno, "pointerup");
  assert.ok(win.ynno.classList.contains("correct"), "✕ guess was correct (wrong-kana question)");
  assert.equal(win.ynactual.hidden, false, "the actual sound is revealed");
  assert.ok(!win.primary.hidden, "stayed in review (Next shown), didn't auto-advance");

  const plays = async () => (await getEvents(uid)).filter((e) => e.ev === "p");
  const tap = async (el, want) => {
    const n = (await plays()).length;
    fire(el, "pointerdown");   // resets longHandled, as a real tap would
    fire(el, "pointerup");
    el.click();
    const p = await waitFor(async () => {
      const ps = await plays();
      return ps.length > n ? ps[ps.length - 1] : null;
    }, WAIT);
    assert.equal(p.picked, want, `replayed ${want}`);
  };

  // ○ replays the kana shown on screen (ざ — the "wrong" one), so the user can
  // compare it to the さ that actually played; ✕ replays the actual さ.
  await tap(win.ynyes, "za");
  await tap(win.ynno, "sa");
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

test("app: ?remind degrades cleanly where push is unsupported (no SW / no VAPID key)", async (t) => {
  // happy-dom has no serviceWorker/PushManager and VAPID_PUBLIC_KEY is unset, so
  // pushSupported() is false: ?remind must no-op without throwing, leaving the
  // opt-in prompt hidden. Real push subscription + delivery are verified manually
  // on a device — service workers don't run here.
  const { win, close } = await openPage("/?remind");
  t.after(close);
  await win.happyDOM.waitUntilComplete();
  assert.ok(win.primary, "app booted");
  assert.ok(win.remindprompt.hidden, "no opt-in prompt where push is unsupported");
});

test("dashboard: confusion matrix renders the pick-when-offered denominator", async (t) => {
  // Per-uid view, so counts are exact. With the sa fixture, za is picked 3x &
  // offered 5x, sya picked 1x & offered 1x. Cells read picked/offered.
  const uid = await freshTestUser();
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // this user viewing their own dashboard
  });
  t.after(close);

  const r = await readConfusion(win, [["sa", "za"], ["sa", "sya"]]);
  assert.deepEqual(r["sa/za"], { picked: 3, offered: 5 });
  assert.deepEqual(r["sa/sya"], { picked: 1, offered: 1 });
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

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // this user viewing their own dashboard
  });
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

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // this user viewing their own dashboard
  });
  t.after(close);
  const cell = () => win.confchart.querySelector('td[data-t="sa"][data-p="za"]');
  const detail = win.document.getElementById("confdetail");

  await waitFor(() => cell()?.textContent === "3/6", WAIT);   // matrix rendered (shown: za picked 3 of 6 offered)
  assert.equal(win.statslink.hidden, true, "a non-power viewer gets no stats link");
  assert.ok(detail.hidden, "history hidden until a cell is clicked");
  assert.equal(win.confhint.hidden, false, "the 'tap a cell' hint shows until the first tap");
  cell().click();

  await waitFor(() => !detail.hidden && detail.querySelectorAll("svg circle, svg path").length > 0, WAIT);
  assert.equal(detail.querySelectorAll("svg circle, svg path").length, 6, "one ○/✕ mark per offered event");
  assert.match(detail.querySelector(".cd-head").textContent, /→ ざ · confused 3\/6/);
  assert.ok(cell().classList.contains("selected"), "clicked cell is marked selected");

  // The discovery hint hides for the session once a cell has been tapped.
  assert.equal(win.confhint.hidden, true, "the 'tap a cell' hint hides after the first tap");
  // The replay hint rides inline on the head row as a parenthetical.
  const replayHint = detail.querySelector(".cd-head .cd-file");
  assert.ok(replayHint?.textContent.startsWith("(tap a ○ / ✕"), "replay hint is an inline parenthetical on the head row");

  // A cell with no answers still renders the marks strip (height reserved) so the
  // detail box doesn't change height between cells.
  win.confchart.querySelector('td[data-t="za"][data-p="za"]').click();
  await waitFor(() => detail.querySelector(".cd-head")?.textContent.includes("no answers") ? true : null, WAIT);
  const emptyStrip = detail.querySelector("svg.cd-strip");
  assert.ok(emptyStrip, "empty cell still renders a strip");
  assert.equal(emptyStrip.getAttribute("height"), "26", "the ○/✕ row height stays reserved");
});

test("dashboard: tapping a diagonal ✕ names the kana the user wrongly picked", async (t) => {
  // 4 sa-questions with za offered: wrongly picked za (diagonal ✕) then sa (○), twice.
  const uid = await freshTestUser();
  const t0 = Date.now();
  const mk = (i, picked) => ({ ts: t0 + i, target: "sa", idx: 0, picked, cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 });
  assert.equal((await postEvents(uid, [mk(1, "za"), mk(2, "sa"), mk(3, "za"), mk(4, "sa")])).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // own dashboard
  });
  t.after(close);
  const detail = win.document.getElementById("confdetail");
  const diagCell = () => win.confchart.querySelector('td[data-t="sa"][data-p="sa"]');

  await waitFor(() => diagCell()?.textContent === "2/4", WAIT);   // diagonal: sa picked 2 of 4 offered
  diagCell().click();
  // ✕ marks render as <path>; the first one is the oldest event (picked za).
  const wrongMark = await waitFor(() => detail.querySelector(".cd-mark path")?.closest(".cd-mark"), WAIT);
  wrongMark.dispatchEvent(new win.Event("click", { bubbles: true }));   // SVG <g> has no .click(); the handler is delegated on #confdetail
  await waitFor(() => detail.querySelector(".cd-file")?.textContent.includes("picked") ? true : null, WAIT);
  assert.match(detail.querySelector(".cd-file").textContent, /picked ざ/, "the parenthetical names the chosen wrong kana");
});

test("dashboard: confusion matrix metric switch (answered → guessed)", async (t) => {
  // sa→za picked 3× (all offered za), one of them a guess → answered 3/3, guessed 1/3.
  const uid = await freshTestUser();
  const t0 = Date.now();
  const a = (i, ev_) => ({ ts: t0 + i, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: ev_, opts: ["sa", "za"], skill: 0 });
  assert.equal((await postEvents(uid, [a(1, "a"), a(2, "a"), a(3, "g")])).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),
  });
  t.after(close);
  const cell = () => win.confchart.querySelector('td[data-t="sa"][data-p="za"]');
  await waitFor(() => cell()?.textContent === "3/3" ? true : null, WAIT);   // default metric = answered

  const g = win.confmetric.querySelector('input[value="guessed"]');
  g.checked = true;
  g.dispatchEvent(new win.Event("change", { bubbles: true }));   // wireSwitchGroup delegates on the span
  await waitFor(() => cell()?.textContent === "1/3" ? true : null, WAIT);
  assert.equal(cell().textContent, "1/3", "guessed metric counts only the guess, over the same offered");
});

test("dashboard: a free (cap-2) re-listen is recorded but doesn't break the streak", async (t) => {
  // Three correct sa answers with a cap-2 (free) re-listen before the third. The
  // re-listen is recorded — it shows in the re-listen metric (1/3) — but at cap 2
  // it carries no penalty, so the streak runs through it to 3 (a cap>=3 'r' would
  // have reset it to 1). Locks isPenalizedRelisten gating the replay.
  const uid = await freshTestUser();
  const t0 = Date.now();
  const ans = (s) => ({ ts: s + 1, start_ts: s, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 1, ev: "a", opts: ["sa", "za"], skill: 0 });
  const events = [
    ans(t0),
    ans(t0 + 10),
    { ts: t0 + 20, start_ts: t0 + 21, target: "sa", idx: 0, picked: "", cap: 2, ms: 1, ev: "r" },  // free re-listen
    ans(t0 + 21),
  ];
  assert.equal((await postEvents(uid, events)).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),
  });
  t.after(close);
  const stat = (k) => win.document.querySelector(`#overview [data-stat="${k}"]`).textContent;
  await waitFor(() => stat("topstreak") !== "0" ? true : null, WAIT);
  assert.equal(stat("topstreak"), "3", "free re-listen doesn't break the streak");

  const cell = () => win.confchart.querySelector('td[data-t="sa"][data-p="za"]');
  const r = win.confmetric.querySelector('input[value="relistened"]');
  r.checked = true;
  r.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => cell()?.textContent === "1/3" ? true : null, WAIT);
  assert.equal(cell().textContent, "1/3", "the free re-listen is recorded and shows in the re-listen metric");
});

test("dashboard: a re-listen with no answer still shows in the re-listen metric", { skip: LIVE }, async (t) => {
  // The re-listen carries its own opts, so it's credited even when the question is
  // never answered — and the denominator counts every question that offered the
  // kana (answered or not), so the ratio stays sane.
  const uid = await freshTestUser();
  const t0 = Date.now();
  await postEvents(uid, [
    // An answered sa question that offered za — no re-listen.
    { ts: t0 + 1, start_ts: t0, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 1, ev: "a", opts: ["sa", "za"], skill: 0 },
    // A sa question that was re-listened then abandoned — only the 'r' (with opts).
    { ts: t0 + 100, start_ts: t0 + 100, target: "sa", idx: 0, picked: "", cap: 2, ms: 1, ev: "r", opts: ["sa", "za"] },
  ]);
  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, { setup: (w) => w.localStorage.setItem("uid", uid) });
  t.after(close);
  const cell = () => win.confchart.querySelector('td[data-t="sa"][data-p="za"]');
  await waitFor(() => cell()?.textContent ? true : null, WAIT);   // answered metric renders first
  const r = win.confmetric.querySelector('input[value="relistened"]');
  r.checked = true;
  r.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => cell()?.textContent === "1/2" ? true : null, WAIT);
  assert.equal(cell().textContent, "1/2", "unanswered re-listen counts; denominator = both questions that offered za");
});

test("dashboard: the sound-file matrix has synced metric + count/% switches that drive it", { skip: LIVE }, async (t) => {
  const uid = await freshTestUser();
  await postEvents(uid, saFixture(Date.now()));   // a/g answers (no guesses) → answered populated, guessed all-zero
  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, { setup: (w) => w.localStorage.setItem("uid", uid) });
  t.after(close);
  const main = (v) => win.confmetric.querySelector(`input[value="${v}"]`);
  const voice = (v) => win.confmetricv.querySelector(`input[value="${v}"]`);
  await waitFor(() => win.voiceconf.querySelector("td") ? true : null, WAIT);

  assert.ok(voice("answered").checked, "the duplicate metric selector starts in sync (answered)");
  const answeredHtml = win.voiceconf.innerHTML;

  // Flip the MAIN metric switch → the voice copy syncs AND the sound-file matrix re-renders.
  const g = main("guessed"); g.checked = true; g.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => voice("guessed").checked ? true : null, WAIT);
  assert.ok(voice("guessed").checked, "the voice metric selector synced to guessed");
  assert.notEqual(win.voiceconf.innerHTML, answeredHtml, "the sound-file matrix re-rendered for the new metric");

  // Flip the VOICE metric copy → the main one syncs back.
  const r = voice("relistened"); r.checked = true; r.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => main("relistened").checked ? true : null, WAIT);
  assert.ok(main("relistened").checked, "the main metric selector synced from the voice copy");

  // Back to a metric with data (relistened is empty for this fixture), so the
  // count/% change has something to re-render.
  const a = main("answered"); a.checked = true; a.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => voice("answered").checked ? true : null, WAIT);

  // The count/% toggle also has a synced copy here, and it drives the matrix.
  const mainPct = win.confmode.querySelector('input[value="pct"]');
  const voicePct = win.confmodev.querySelector('input[value="pct"]');
  assert.ok(win.confmodev.querySelector('input[value="count"]').checked, "count/% copy starts in sync (counts)");
  const countHtml = win.voiceconf.innerHTML;
  mainPct.checked = true; mainPct.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => voicePct.checked ? true : null, WAIT);
  assert.ok(voicePct.checked, "the voice count/% copy synced to per-sound %");
  assert.notEqual(win.voiceconf.innerHTML, countHtml, "the sound-file matrix re-rendered in per-sound % mode");
});

test("dashboard: the sound-file matrix's row filter relabels 'min % wrong' → 'min %' for non-answered metrics", { skip: LIVE }, async (t) => {
  const uid = await freshTestUser();
  await postEvents(uid, saFixture(Date.now()));
  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, { setup: (w) => w.localStorage.setItem("uid", uid) });
  t.after(close);
  await waitFor(() => win.voiceconf.querySelector("td") ? true : null, WAIT);
  assert.equal(win.vcwronglabel.textContent, "min % wrong", "answered: off-diagonal-only filter, labelled 'min % wrong'");
  const r = win.confmetric.querySelector('input[value="relistened"]');
  r.checked = true;
  r.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => win.vcwronglabel.textContent === "min %" ? true : null, WAIT);
  assert.equal(win.vcwronglabel.textContent, "min %", "non-answered: diagonal is signal too, so just 'min %'");
});

test("dashboard: a one-sided cell reads 'consistent', not 'no clear trend'", async (t) => {
  // 8 sa-questions with za offered, always answered sa → never confused (0/8).
  const uid = await freshTestUser();
  const t0 = Date.now();
  const events = Array.from({ length: 8 }, (_, i) =>
    ({ ts: t0 + i, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }));
  assert.equal((await postEvents(uid, events)).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // this user viewing their own dashboard
  });
  t.after(close);
  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);
  const detail = win.document.getElementById("confdetail");

  await waitFor(() => cell("sa", "sa")?.textContent === "8/8", WAIT);   // diagonal (shown): 8 correct of 8 → render done
  cell("sa", "za").click();
  await waitFor(() => !detail.hidden && detail.querySelector(".cd-head"), WAIT);
  assert.match(detail.querySelector(".cd-head").textContent, /confused 0\/8 · consistent/);
  assert.equal(detail.querySelectorAll("svg polyline").length, 0, "no trend line for a flat cell");
});

// skip on LIVE: posts a role-0-style fixture under a fresh uid with a tz.
test("dashboard: hour-of-day buckets in the viewed user's timezone, not the viewer's", { skip: LIVE }, async (t) => {
  // Two answers at 02:30 UTC; the user reports JST (+540 min), so they belong at hour 11.
  const uid = await freshTestUser();
  const ts = Date.UTC(2026, 0, 1, 2, 30, 0);
  const ev = (i) => ({ ts: ts + i * 1000, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 });
  assert.equal((await postEvents(uid, [ev(0), ev(1)], 540)).status, 200);   // tz = JST

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // own dashboard
  });
  t.after(close);
  const titles = () => [...win.hourlychart.querySelectorAll("title")].map((n) => n.textContent);
  await waitFor(() => titles().length ? titles() : null, WAIT);
  assert.ok(titles().some((s) => s.startsWith("11:00") && s.includes("2/2")), "the two answers bucket at JST 11:00");
  assert.ok(!titles().some((s) => s.startsWith("02:00")), "not at the raw UTC hour (02:00)");
  assert.match(win.hourtz.textContent, /UTC\+9\b/, "the heading names the timezone the hours are in");
});

// skip on LIVE: posts a fixture under a fresh uid with a tz.
test("dashboard: day-bucketing uses the viewed user's timezone (first-seen, days)", { skip: LIVE }, async (t) => {
  // 16:00 UTC on Jan 1 is 01:00 of Jan 2 in JST — with tz=JST both answers must
  // bucket as Jan 2 (one day), and first-seen must read the JST date, not the UTC one.
  const uid = await freshTestUser();
  const ts = Date.UTC(2026, 0, 1, 16, 0, 0);
  const ev = (i) => ({ ts: ts + i * 1000, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 });
  assert.equal((await postEvents(uid, [ev(0), ev(1)], 540)).status, 200);   // tz = JST

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // own dashboard
  });
  t.after(close);
  const stat = (k) => win.document.querySelector(`#overview [data-stat="${k}"]`).textContent;
  await waitFor(() => stat("first") !== "—" ? true : null, WAIT);
  assert.equal(stat("first"), "2026-01-02", "first-seen is the user's JST day, not the UTC day (2026-01-01)");
  assert.equal(stat("days"), "1", "both answers fall on the same JST day");
});

test("dashboard: Y/N answers feed the confusion matrix (diagonal + confuser)", async (t) => {
  // Y/N events all ask the さ sound (target sa); picked = the kana shown, ev y =
  // "yes it matches", n = "no". The matrix counts a correct-kana prompt on the
  // diagonal only, and a wrong-kana prompt on the diagonal AND the confuser.
  const uid = await freshTestUser();
  const t0 = Date.now();
  const yn = (i, ev, picked) => ({ ts: t0 + i, target: "sa", idx: 0, picked, cap: 2, ms: 500, ev });
  const events = [
    yn(1, "y", "sa"),   // correct-kana, correct → diagonal hit
    yn(2, "n", "sa"),   // correct-kana, wrong   → diagonal miss
    yn(3, "n", "za"),   // wrong-kana, correct   → diagonal hit, za offered
    yn(4, "y", "za"),   // wrong-kana, wrong     → confused sa→za (za picked)
  ];
  assert.equal((await postEvents(uid, events)).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // this user viewing their own dashboard
  });
  t.after(close);

  // Diagonal: 2 right of 4 asked. Confuser sa/za: za offered twice (the two
  // wrong-kana prompts), picked once (the wrong "yes").
  const r = await readConfusion(win, [["sa", "sa"], ["sa", "za"]]);
  assert.deepEqual(r["sa/sa"], { picked: 2, offered: 4 });
  assert.deepEqual(r["sa/za"], { picked: 1, offered: 2 });
});

test("dashboard: Y/N answers count as activity (answers + accuracy)", async (t) => {
  // y = "yes it matches", n = "no". Correct when: y & picked==target, or n &
  // picked!=target. Below: right, right, wrong → 3 answers, 2 correct.
  const uid = await freshTestUser();
  const t0 = Date.now();
  const events = [
    { ts: t0 + 1, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "y" },  // matches → right
    { ts: t0 + 2, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: "n" },  // rejected → right
    { ts: t0 + 3, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: "y" },  // wrong "yes"
  ];
  assert.equal((await postEvents(uid, events)).status, 200);

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // this user viewing their own dashboard
  });
  t.after(close);
  const overview = win.document.getElementById("overview");
  const stat = (k) => overview.querySelector(`[data-stat="${k}"]`).textContent;

  await waitFor(() => stat("answers") === "3" || null, WAIT);
  assert.equal(stat("correct"), "2", "the Y/N 'no' reject counts as correct");
});

test("stats: confusion matrix uses server-aggregated pick-when-offered counts", { skip: LIVE }, async (t) => {
  // Local-only: needs power_user granted via local SQL, and unlike role-1 test
  // users its rows must stay *in* the aggregate — so it's role 0 (but still tagged
  // TestUser, per the canary rule). The stats matrix is global (all users), so we
  // can't assert exact counts against a snapshot — add the sa fixture and assert
  // robust shape: "picked/offered" with picked<=offered.
  const uid = await freshTestUser({ role: 0 });
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);
  grantPowerUser(uid, 1);

  const { win, close } = await openPage(`/stats/?uid=${uid}`);
  t.after(close);

  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  // "picked/offered", picked<=offered, offered >= the 5 we added.
  const shown = await waitFor(() => {
    const txt = cell("sa", "za")?.textContent;
    return /^\d+\/\d+$/.test(txt || "") ? txt : null;
  });
  const m = shown.match(/^(\d+)\/(\d+)$/);
  const [, picked, offered] = m.map(Number);
  assert.ok(picked <= offered, `picked ${picked} <= offered ${offered}`);
  assert.ok(offered >= 5, `offered >= 5 (got ${offered})`);
});

test("stats: normal/native population toggle defaults to normal and syncs both copies", { skip: LIVE }, async (t) => {
  const uid = await freshTestUser({ role: 0 });
  await postEvents(uid, saFixture(Date.now()));
  grantPowerUser(uid, 1);
  const { win, close } = await openPage(`/stats/?uid=${uid}`);
  t.after(close);

  // Let the page's async load() settle (renders the matrix) before asserting, so
  // its render chain doesn't run against a torn-down window after the test ends.
  const cellTxt = () => win.confchart.querySelector('td[data-t="sa"][data-p="za"]')?.textContent || "";
  await waitFor(() => cellTxt().includes("/") ? true : null, WAIT);
  const normalCell = cellTxt();

  const active = (id) => [...win.document.getElementById(id).querySelectorAll("input")].find((r) => r.checked).value;
  // Default (hard reload / first load) is normal — the radios start at the HTML
  // default; a soft reload would restore whatever was last picked.
  assert.equal(active("confpop"), "0", "confusion-h2 switch defaults to normal");
  assert.equal(active("confpop2"), "0", "sound-file filter-row copy defaults to normal");

  // Choosing natives in one copy switches both (one logical group).
  const nat = win.document.querySelector('#confpop input[value="2"]');
  nat.checked = true;
  nat.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.equal(active("confpop"), "2", "picked switch updates");
  assert.equal(active("confpop2"), "2", "the mirrored copy stays in sync");

  // Drain the population re-fetch the click kicked off: this normal-user uid has
  // different/no native sa/za data, so the cell changes once it lands. Waiting
  // keeps the re-render from resolving against a torn-down window after the test.
  await waitFor(() => cellTxt() !== normalCell ? true : null, WAIT);
});

test("stats: the confusion metric switch (synced copy) drives both aggregate matrices", { skip: LIVE }, async (t) => {
  // Role-0 uid so it counts in the global aggregate (tagged TestUser per the canary
  // rule). A guess of za, plus a re-listen + its answer, so the alternate metrics
  // have data. The aggregate is global, so assert >= our contribution, not exact.
  const uid = await freshTestUser({ role: 0 });
  const t0 = Date.now();
  await postEvents(uid, [
    { ts: t0 + 1, start_ts: t0, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: "g", opts: ["sa", "za"], skill: 0 },
    { ts: t0 + 11, start_ts: t0 + 10, target: "sa", idx: 0, picked: "", cap: 2, ms: 100, ev: "r", opts: ["sa", "za"] },
    { ts: t0 + 12, start_ts: t0 + 10, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 },
  ]);
  grantPowerUser(uid, 1);
  const { win, close } = await openPage(`/stats/?uid=${uid}`);
  t.after(close);

  const cell = () => win.confchart.querySelector('td[data-t="sa"][data-p="za"]');
  const main = (v) => win.confmetric.querySelector(`input[value="${v}"]`);
  const voice = (v) => win.confmetricv.querySelector(`input[value="${v}"]`);
  await waitFor(() => /\d+\/\d+/.test(cell()?.textContent || "") ? true : null, WAIT);

  assert.ok(voice("answered").checked, "the sound-file metric copy starts synced (answered)");
  assert.equal(win.vcwronglabel.textContent, "min % wrong", "answered → 'min % wrong'");

  // Switch to guessed via the main copy → the voice copy syncs and sa/za shows the guess.
  const g = main("guessed"); g.checked = true; g.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => voice("guessed").checked ? true : null, WAIT);
  const m = (cell().textContent || "").match(/^(\d+)\/(\d+)$/);
  assert.ok(m && Number(m[1]) >= 1, `guessed za >= 1 (got ${cell().textContent})`);

  // A non-answered metric relabels the filter, and flipping the voice copy syncs back.
  const r = voice("relistened"); r.checked = true; r.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => main("relistened").checked ? true : null, WAIT);
  assert.equal(win.vcwronglabel.textContent, "min %", "non-answered → 'min %'");
});

test("stats: overview shows app-wide totals (level-1, no device IDs)", { skip: LIVE }, async (t) => {
  // The overview counters moved to /stats/ (power_user >= 1), read from
  // /v1/admin/stats. Global aggregate, so assert the 6 sa answers are present
  // (>=), not exact totals.
  const uid = await freshTestUser({ role: 0 });
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);
  grantPowerUser(uid, 1);

  const { win, close } = await openPage(`/stats/?uid=${uid}`);
  t.after(close);

  const overview = win.document.getElementById("overview");
  const stat = (k) => overview.querySelector(`[data-stat="${k}"]`).textContent;
  await waitFor(() => /^[1-9]/.test(stat("answers")) ? true : null, WAIT);
  assert.ok(Number(stat("answers")) >= 6, `answers >= 6 (got ${stat("answers")})`);
  assert.ok(Number(stat("users")) >= 1, "at least one user counted");
  assert.match(stat("days"), /^[1-9]/, "days of data populated from totals.days, not a per-day series");
});

test("stats: aggregate hour-of-day buckets each user's local hour (JST default)", { skip: LIVE }, async () => {
  // An answer at 02:30 UTC by a user with no tz on record → defaults to JST (+540),
  // so it belongs at hour 11, not the raw UTC hour 2. (tz: null on purpose — this
  // is the stale-client no-tz path; the canary nickname still tags the row.)
  const uid = await freshTestUser({ role: 0, tz: null });
  const ts = Date.UTC(2026, 0, 1, 2, 30, 0);
  await postEvents(uid, [{ ts, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }]);
  grantPowerUser(uid, 1);

  const { hourly } = await (await fetch(`${WORKER}/v1/admin/stats?uid=${encodeURIComponent(uid)}`)).json();
  const at = (h) => (hourly.find((r) => r.h === h) || { n: 0 }).n;
  assert.ok(at(11) >= 1, "the JST-11:00 answer is in the aggregate hourly");
  if (ISOLATED) assert.equal(at(2), 0, "nothing left at the raw UTC hour (02:00)");
});

test("admin: daily activity buckets each user's local day (JST default)", { skip: LIVE }, async () => {
  // 16:00 UTC Jan 1 = 01:00 JST Jan 2; with no tz on record it defaults to JST → Jan 2.
  // (tz: null on purpose — the no-tz default path; canary nickname still tags it.)
  const uid = await freshTestUser({ role: 0, tz: null });
  const ts = Date.UTC(2026, 0, 1, 16, 0, 0);
  await postEvents(uid, [{ ts, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }]);
  grantPowerUser(uid, 2);

  // daily is a global aggregate (can't isolate this uid on the shared test DB), so
  // assert per-uid via the drilldown map: this user lands on their JST day, not UTC.
  const { daily_uids } = await (await fetch(`${WORKER}/v1/admin/stats/users?uid=${encodeURIComponent(uid)}`)).json();
  assert.ok((daily_uids["2026-01-02"] || []).includes(uid), "user listed under their JST day (Jan 2)");
  assert.ok(!(daily_uids["2026-01-01"] || []).includes(uid), "not under the raw UTC day (Jan 1)");
});

test("admin: level-2 page renders per-user histograms, no overview/confusion", { skip: LIVE }, async (t) => {
  // The /admin/ page reads /v1/admin/stats/users (power_user >= 2). saFixture
  // trains さ (vowel あ), so the あ button-count histogram counts at least this
  // user — a global aggregate, so assert >= 1, not an exact total. The overview
  // and confusion matrix moved to /stats/, so they're absent here. Also assert a
  // clean render (no thrown errors in the boot scripts).
  const uid = await freshTestUser({ role: 0 });
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);
  grantPowerUser(uid, 2);

  const { win, logs, close } = await openPage(`/admin/?uid=${uid}`);
  t.after(close);

  const total = () => Number(win.document.querySelector('#levelhist .lvlcol[data-vowel="a"] .lvltotal').textContent);
  await waitFor(() => total() >= 1 ? true : null, WAIT);
  assert.equal(win.document.getElementById("overview"), null, "overview moved to /stats/");
  assert.equal(win.document.getElementById("confchart"), null, "no confusion matrix on the admin page");
  assert.deepEqual(logs.filter((l) => l.startsWith("ERROR")), [], "no errors during render");
});

test("admin: a uid-less device (private window) is told it has no Device ID", async (t) => {
  // Regression: with no uid the page never calls load(), so the message must be
  // shown directly — otherwise it falls back to the bare CSS "Unauthorized."
  // pseudo-element. No worker call on this path, so it holds on LIVE too.
  const { win, close } = await openPage("/admin/");   // no ?uid, fresh localStorage
  t.after(close);
  const msg = win.document.getElementById("msg");
  await waitFor(() => /no Device ID/.test(msg.textContent) ? true : null, WAIT);
  assert.match(msg.textContent, /can't view the admin page/);
  const link = msg.querySelector("a");
  assert.match(link?.getAttribute("href") || "", /\/dashboard\/?$/, "points at the dashboard");
  assert.equal(win.document.getElementById("dash").style.display, "none", "dashboard skeleton hidden");
});

test("admin: Y/N answers feed the server confusion matrix", { skip: LIVE }, async () => {
  // The admin matrix is a global aggregate, so we can't assert absolute counts;
  // instead assert the *delta* a Y/N batch adds to the sa/za cell — robust against
  // whatever else is in the aggregate, since only this batch lands between reads.
  // Needs a role-0 uid (so the rows stay in the aggregate; still tagged TestUser
  // per the canary rule) + power_user.
  const uid = await freshTestUser({ role: 0 });
  const stats = async () =>
    (await fetch(`${WORKER}/v1/admin/stats?uid=${encodeURIComponent(uid)}`)).json();
  const nFor = (data, map, col) =>
    (data[map] || []).find((x) => x.t === "sa" && x[col] === "za")?.n || 0;

  await postEvents(uid, saFixture(Date.now()));   // a/g baseline (also creates the user row)
  grantPowerUser(uid, 1);                          // UPDATE, so it must follow the row's creation
  const a = await stats();

  // Three wrong-kana prompts (ざ shown while さ plays): two wrong "yes" (confused,
  // picked za) and one correct "no". All three offer za; two pick it.
  const t0 = Date.now();
  await postEvents(uid, [
    { ts: t0 + 1, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: "y" },
    { ts: t0 + 2, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: "y" },
    { ts: t0 + 3, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: "n" },
  ]);
  const b = await stats();

  assert.equal(nFor(b, "confusion_offered", "k") - nFor(a, "confusion_offered", "k"), 3, "za offered +3");
  assert.equal(nFor(b, "confusion_shown", "p") - nFor(a, "confusion_shown", "p"), 2, "za picked +2");
});

// Delta-based (like the Y/N test) so it's robust against whatever else is in the
// aggregate: add a normal (role 0) su→tu confusion and a native (role 2) so→tyo,
// and check each population's view moves only for its own population.
test("admin: ?natives switches the confusion matrix between normal and native data", { skip: LIVE }, async () => {
  const ans = (target, picked) => ({ ts: Date.now(), target, idx: 0, picked, cap: 2, ms: 500, ev: "a", opts: [target, picked], skill: 0 });
  const admin = await freshTestUser({ role: 0 });
  await postEvents(admin, [ans("sa", "sa")]);   // creates the row for grantPowerUser
  grantPowerUser(admin, 1);

  const shownN = async (q, t, p) =>
    ((await (await fetch(`${WORKER}/v1/admin/stats?uid=${encodeURIComponent(admin)}${q}`)).json())
      .confusion_shown || []).find((r) => r.t === t && r.p === p)?.n || 0;

  const before = {
    nSu: await shownN("", "su", "tu"), vSu: await shownN("&natives=1", "su", "tu"),
    nSo: await shownN("", "so", "tyo"), vSo: await shownN("&natives=1", "so", "tyo")
  };

  await postEvents(await freshTestUser({ role: 0 }), [ans("su", "tu"), ans("su", "tu")]);   // role 0
  const native = await freshTestUser({ role: 2 });   // role 2, tagged TestUser
  await postEvents(native, [ans("so", "tyo"), ans("so", "tyo")]);       // role 2

  assert.equal(await shownN("", "su", "tu") - before.nSu, 2, "normal view counts the normal confusion");
  assert.equal(await shownN("&natives=1", "su", "tu") - before.vSu, 0, "natives view ignores the normal confusion");
  assert.equal(await shownN("&natives=1", "so", "tyo") - before.vSo, 2, "natives view counts the native confusion");
  assert.equal(await shownN("", "so", "tyo") - before.nSo, 0, "normal view ignores the native confusion");
});

test("dashboard: per-user sound-file confusion matrix renders the viewer's recordings", async (t) => {
  // Per-uid, exact counts. saFixture is all idx 0, so every answer is the same
  // sa recording; the worker assigns its voice at ingest. For that recording, za
  // is picked 3× of 5 offered. The matrix lives in a collapsed <details> but is
  // rendered into the DOM regardless.
  const uid = await freshTestUser();
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);
  const voice = (await getEvents(uid)).find((e) => e.target === "sa" && e.idx === 0)?.voice;
  assert.ok(voice, "worker assigned a voice to sa#0");

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // this user viewing their own dashboard
  });
  t.after(close);

  const cell = await waitFor(() => {
    const td = [...win.voiceconf.querySelectorAll("td")]
      .find((d) => d.title.startsWith(`sa (${voice}) → za`));
    return td && /^\d+\/\d+$/.test(td.textContent) ? td.textContent : null;
  });
  assert.equal(cell, "3/5", "sa recording: za picked 3 of 5 offered");

  // The row header's hover exposes the recording's current file id (its index in
  // the current voice set). saFixture is idx 0, so its voice is VOICE_MAP[sa][0].
  const vth = [...win.voiceconf.querySelectorAll("th.vname")].find((th) => th.dataset.voice === voice);
  assert.equal(vth?.title, `${voice} — current id 0`, "row header hover shows the current file id");
});

test("admin: sound-file matrix exposes per-recording shown/offered (vs the kana)", { skip: LIVE }, async () => {
  // The sound-file confusion matrix normalises a cell by how often that kana was
  // offered FOR THIS RECORDING (not how often the recording was asked). Assert the
  // delta a batch adds to one recording's sa/za cell. Global aggregate → delta;
  // role-0 uid so the rows count (still tagged TestUser); power_user for the read.
  const uid = await freshTestUser({ role: 0 });
  const t0 = Date.now();
  // Seed one event so the user row exists (for grantPowerUser) and so we can read
  // back the worker-assigned voice name for the sa recording at idx 0.
  await postEvents(uid, [{ ts: t0, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }]);
  grantPowerUser(uid, 1);
  const voice = (await getEvents(uid)).find((e) => e.target === "sa" && e.idx === 0)?.voice;
  assert.ok(voice, "worker assigned a voice name to sa#0");

  const stats = async () =>
    (await fetch(`${WORKER}/v1/admin/stats?uid=${encodeURIComponent(uid)}`)).json();
  const n = (data, map, col, val) =>
    (data[map] || []).find((r) => r.t === "sa" && r.v === voice && r[col] === val)?.n || 0;
  const a = await stats();

  // Two more sa#0 questions with za offered; pick za once.
  await postEvents(uid, [
    { ts: t0 + 1, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 },
    { ts: t0 + 2, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 },
  ]);
  const b = await stats();

  assert.equal(n(b, "by_voice_offered", "k", "za") - n(a, "by_voice_offered", "k", "za"), 2, "za offered +2 for sa#0");
  assert.equal(n(b, "by_voice_shown", "p", "za") - n(a, "by_voice_shown", "p", "za"), 1, "za picked +1 for sa#0");
});

test("admin: minacc filter drops low-accuracy users from the confusion matrices", { skip: LIVE }, async () => {
  // Robust against the global aggregate by measuring the DELTA that adding ONE
  // low-accuracy user causes, at two thresholds: counted at minacc=0, excluded at
  // minacc=90. A separate uid carries power_user for the admin reads.
  const admin = await freshTestUser({ role: 0 });
  await postEvents(admin, [{ ts: Date.now(), target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }]);
  grantPowerUser(admin, 1);
  const offeredZa = async (minacc) => {
    const d = await (await fetch(`${WORKER}/v1/admin/stats?uid=${admin}&minacc=${minacc}`)).json();
    return (d.confusion_offered || []).find((r) => r.t === "sa" && r.k === "za")?.n || 0;
  };

  const before0 = await offeredZa(0);
  const before90 = await offeredZa(90);

  // A 10%-accuracy user: 1 correct さ, 9 confused さ→ざ (za offered every time).
  const low = await freshTestUser({ role: 0 });
  const t0 = Date.now();
  const events = [{ ts: t0, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }];
  for (let i = 1; i <= 9; i++) {
    events.push({ ts: t0 + i, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 });
  }
  await postEvents(low, events);

  assert.equal(await offeredZa(0) - before0, 10, "minacc=0 counts the low-accuracy user (za offered +10)");
  assert.equal(await offeredZa(90) - before90, 0, "minacc=90 excludes the low-accuracy user");
});

// skip on LIVE: the counted answers need a role-0 uid (EXCLUDE_TEST keeps test
// users out of voice-attempts), and a bare randomUUID() the janitor never purges
// (role 1 only) would permanently pollute prod aggregates — so this runs only in
// the isolated sandbox, like the other role-0-data tests.
test("voice-attempts: per-recording matrix coverage = min over same-vowel confusers", { skip: LIVE }, async () => {
  const get = async () => (await fetch(`${WORKER}/v1/voice-attempts`)).json();
  const real = await freshTestUser({ role: 0 });   // role 0 → counted, but tagged
  const t0 = Date.now();
  const all = ["sa", "za", "sya", "zya", "tya"];   // sa + its 4 same-vowel confusers
  const a = (i, idx, opts) => ({ ts: t0 + i, target: "sa", idx, picked: "sa", cap: opts.length, ms: 500, ev: "a", opts, skill: 0 });

  // sa#91: every confuser offered ≥2× (za 3×), so the min lands on the rarest = 2.
  await postEvents(real, [
    a(1, 91, all), a(2, 91, all),
    a(3, 91, ["sa", "za"]),                                // za → 3
    { ts: t0 + 4, target: "sa", idx: 91, picked: "za", cap: 2, ms: 500, ev: "y" },   // Y/N: no opts → not matrix-usable
    { ts: t0 + 5, target: "sa", idx: 91, picked: "sa", cap: 2, ms: 500, ev: "a", skill: 0 },   // pre-migration: no opts → ignored
  ]);
  // A TestUser offering every confuser — role-excluded, so it must not lift the min.
  await postEvents(await freshTestUser(), [a(6, 91, all)]);
  assert.equal((await get()).sa?.["91"], 2, "min over za=3, sya/zya/tya=2; Y/N, opts-less, and TestUser rows ignored");

  // sa#92: za/sya/zya offered but tya never → that empty cell forces the min to 0,
  // even though the recording is otherwise sampled.
  await postEvents(real, [a(7, 92, ["sa", "za", "sya", "zya"])]);
  assert.equal((await get()).sa?.["92"], 0, "a never-offered confuser drops the min to 0");
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

// skip on LIVE: viewing another uid now needs power (granted via local SQL).
test("dashboard: no drift notice when viewing someone else's data", { skip: LIVE }, async (t) => {
  // Drift is about THIS device's tally, which only reflects the viewer's own
  // answers — so drilling into another uid never flags it, however stale.
  const other = await freshTestUser();
  assert.equal((await postEvents(other, saFixture(Date.now()))).status, 200);
  const me = await freshTestUser({ role: 0 });
  await postEvents(me, saFixture(Date.now()));   // create me's row, then grant power
  grantPowerUser(me, 1);                          // viewing another's dashboard is power-gated

  const { win, close } = await openPage(`/dashboard/?uid=${other}`, {
    setup: (w) => {
      w.localStorage.setItem("uid", me);             // viewer is a (power) someone else
      w.localStorage.setItem("grind_tally", "{}");   // whose empty tally would "drift"
    },
  });
  t.after(close);
  const cell = (tt, pp) => win.confchart.querySelector(`td[data-t="${tt}"][data-p="${pp}"]`);

  await waitFor(() => cell("sa", "za")?.textContent === "3/5", WAIT);
  assert.equal(win.syncnotice.hidden, true, "another user's matrix never flags local drift");
  assert.equal(win.uidform.hidden, true, "level-1 viewer can view a shared link but gets no load-as form");
  assert.equal(win.statslink.hidden, false, "level-1 viewer gets the aggregate-stats link");
  assert.equal(win.statslink.getAttribute("href"), "../stats/", "stats link authorises by the viewer's own uid — no viewed ?uid");
});

test("dashboard: a Y/N diagonal-miss doesn't keep drifting after a sync", async (t) => {
  // Regression: a Y/N "no" on a correct-kana prompt (heard the right kana, said
  // no) is a diagonal miss with no confuser. The matrix once hand-rolled its own
  // shown map and logged a phantom `sa/` key the grind tally never produces, so
  // the drift notice stuck even right after Sync — "sync and refresh, same
  // message". Now matrix + tally are one projection of one tally, so it settles.
  const uid = await freshTestUser();
  const t0 = Date.now();
  const yn = (i, ev, picked) => ({ ts: t0 + i, target: "sa", idx: 0, picked, cap: 2, ms: 500, ev });
  const events = [
    yn(1, "y", "sa"),   // diagonal hit
    yn(2, "n", "sa"),   // diagonal MISS, no confuser — the phantom-key trigger
    yn(3, "y", "za"),   // wrong-kana, wrong → confused sa→za
  ];
  assert.equal((await postEvents(uid, events)).status, 200);

  // First load with an empty tally → drift; Sync rebuilds it from the events.
  const cellReady = (w) => w.confchart.querySelector('td[data-t="sa"][data-p="za"]')?.textContent?.includes("/") ? true : null;
  const first = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => { w.localStorage.setItem("uid", uid); w.localStorage.setItem("grind_tally", "{}"); },
  });
  t.after(first.close);
  await waitFor(() => cellReady(first.win), WAIT);
  assert.equal(first.win.syncnotice.hidden, false, "empty tally vs server data drifts");
  first.win.syncbtn.click();
  const synced = first.win.localStorage.getItem("grind_tally");

  // The "refresh" the user did: reload carrying the just-synced tally → settled.
  const second = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => { w.localStorage.setItem("uid", uid); w.localStorage.setItem("grind_tally", synced); },
  });
  t.after(second.close);
  await waitFor(() => cellReady(second.win), WAIT);
  assert.equal(second.win.syncnotice.hidden, true, "after Sync + reload the drift notice is gone");
});

test("dashboard: viewing another user's dashboard is denied without power", async (t) => {
  const other = randomUUID();   // a uid we don't own
  const me = randomUUID();      // a normal (non-power) viewer
  const { win, close } = await openPage(`/dashboard/?uid=${other}`, {
    setup: (w) => w.localStorage.setItem("uid", me),
  });
  t.after(close);

  await waitFor(() => win.msg.textContent.includes("Unauthorized") ? true : null, WAIT);
  assert.equal(win.dash.style.display, "none", "the dashboard content is hidden");
  assert.equal(win.confchart.querySelector('td[data-t="sa"][data-p="za"]')?.textContent || "", "",
    "the other user's data was never loaded");
});

const subscribePush = (uid) => {
  const endpoint = `https://push.example.invalid/${uid}-${Date.now()}`;
  return fetch(`${WORKER}/v1/push/subscribe`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, subscription: { endpoint, keys: { p256dh: "k", auth: "a" } }, tzOffset: 540 }),
  });
};

test("admin reminder: reports a uid's push-subscription state, gated to power users", { skip: LIVE }, async () => {
  const admin = await freshTestUser({ role: 0 });
  await postEvents(admin, saFixture(Date.now()));   // creates the row for grantPowerUser
  grantPowerUser(admin, 1);
  const target = randomUUID();
  const ask = (asker, t) =>
    fetch(`${WORKER}/v1/admin/reminder?uid=${encodeURIComponent(asker)}&target=${encodeURIComponent(t)}`);

  assert.equal((await ask(target, target)).status, 403, "non-power viewer is forbidden");
  assert.equal((await (await ask(admin, target)).json()).on, false, "no subscription → off");
  await subscribePush(target);
  assert.equal((await (await ask(admin, target)).json()).on, true, "subscribed → on");
});

test("admin: a user's timezone is recorded from events, not just subscriptions", { skip: LIVE }, async () => {
  // A normal (role 0) user who never subscribed to reminders, but whose events
  // POST carried tz — should still show a timezone in the admin overview. Tagged
  // TestUser but registered tz:null, so the 540 it shows comes FROM the events POST.
  const uid = await freshTestUser({ role: 0, tz: null });
  await fetch(`${WORKER}/v1/events`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, tz: 540, events: [{ ts: Date.now(), target: "sa", idx: 0, picked: "sa", cap: 2, ms: 100, ev: "a", opts: ["sa", "za"], skill: 0 }] }),
  });
  const admin = await freshTestUser({ role: 0 });
  await postEvents(admin, saFixture(Date.now()));
  grantPowerUser(admin, 2);
  const data = await (await fetch(`${WORKER}/v1/admin/stats/users?uid=${encodeURIComponent(admin)}`)).json();
  assert.equal(data.timezones?.[uid], 540, "tz from the events POST shows in admin (no subscription needed)");
});

test("admin reminder: reports the opt-in engagement state (declined / offered / none)", { skip: LIVE }, async () => {
  const admin = await freshTestUser({ role: 0 });
  await postEvents(admin, saFixture(Date.now()));
  grantPowerUser(admin, 1);
  const evt = { ts: Date.now(), target: "sa", idx: 0, picked: "sa", cap: 2, ms: 100, ev: "a", opts: ["sa", "za"], skill: 0 };
  const post = (uid, remind_state) => fetch(`${WORKER}/v1/events`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, remind_state, events: [evt] }),
  });
  const stateOf = (t) => fetch(`${WORKER}/v1/admin/reminder?uid=${encodeURIComponent(admin)}&target=${encodeURIComponent(t)}`)
    .then((r) => r.json()).then((d) => d.state);

  const decliner = await freshTestUser({ role: 0 }); await post(decliner, "declined");
  const offered = await freshTestUser({ role: 0 }); await post(offered, "offered");
  const fresh = await freshTestUser({ role: 0 }); await post(fresh, null);   // no opt-in signal
  assert.equal(await stateOf(decliner), "declined");
  assert.equal(await stateOf(offered), "offered");
  assert.equal(await stateOf(fresh), null, "no signal → not-shown");
});

test("dashboard: a power user sees the viewed uid's reminder state, read-only", { skip: LIVE }, async (t) => {
  const admin = await freshTestUser({ role: 0 });
  await postEvents(admin, saFixture(Date.now()));
  grantPowerUser(admin, 2);
  const target = await freshTestUser();
  await postEvents(target, saFixture(Date.now()));
  await subscribePush(target);                       // so it reads "on"

  const { win, close } = await openPage(`/dashboard/?uid=${target}`, {
    setup: (w) => w.localStorage.setItem("uid", admin),   // viewer is the power user
  });
  t.after(close);

  // Drain the page's async load() (renders the matrix) so it doesn't resolve
  // against a torn-down window after the test — saFixture gives sa/za = 3/5.
  await waitFor(() => win.confchart.querySelector('td[data-t="sa"][data-p="za"]')?.textContent === "3/5", WAIT);
  await waitFor(() => !win.reminders.hidden && win.reminderstatus.textContent.includes("Daily reminders") ? true : null, WAIT);
  assert.match(win.reminderstatus.textContent, /Daily reminders: on for this user/);
  assert.equal(win.reminderbtn.hidden, true, "view-as shows no toggle button");
  assert.equal(win.uidform.hidden, false, "level-2 viewer gets the load-as form");
});

test("dashboard view-as: shows a declined reminder opt-in (not just on/off)", { skip: LIVE }, async (t) => {
  const admin = await freshTestUser({ role: 0 });
  await postEvents(admin, saFixture(Date.now()));
  grantPowerUser(admin, 1);
  const decliner = await freshTestUser({ role: 0 });
  await fetch(`${WORKER}/v1/events`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: decliner, remind_state: "declined", events: saFixture(Date.now()) }),
  });

  const { win, close } = await openPage(`/dashboard/?uid=${decliner}`, {
    setup: (w) => w.localStorage.setItem("uid", admin),
  });
  t.after(close);
  await waitFor(() => win.reminderstatus.textContent.includes("Daily reminders") ? true : null, WAIT);
  assert.match(win.reminderstatus.textContent, /declined by this user/);
});

// delete_after is computed on the write path (handleEvents / registration), so it's
// exercised over HTTP — no cron, no local SQL.
test("events: start_ts round-trips (the per-question key)", { skip: LIVE }, async () => {
  const uid = await freshTestUser();
  await postEvents(uid, [{ ts: Date.now(), target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0, start_ts: 1234567 }]);
  const ev = (await getEvents(uid)).find((e) => e.target === "sa");
  assert.equal(ev.start_ts, 1234567, "worker stores and returns the question's start_ts");
});

test("delete_after: registration stamps a +30d baseline", { skip: LIVE }, async () => {
  const uid = randomUUID();
  const t0 = Date.now();
  await registerTestUser(uid);   // POST /v1/user (role 1), no events yet
  const { delete_after } = await (await fetch(`${WORKER}/v1/user/${encodeURIComponent(uid)}/events`)).json();
  assert.ok(Math.abs(delete_after - (t0 + 30 * 86400000)) < 60000, `≈ now + 30d (got ${delete_after})`);
});

test("user registration records tz_offset (before any events)", { skip: LIVE }, async () => {
  const uid = randomUUID();
  await fetch(`${WORKER}/v1/user`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, nickname: "TestUser", role: 1, tz: 540 }),
  });
  const { tz_offset } = await (await fetch(`${WORKER}/v1/user/${encodeURIComponent(uid)}/events`)).json();
  assert.equal(tz_offset, 540, "tz captured at registration, so a register-only user has one");
});

test("delete_after: an events POST recomputes it (30d + 1d per 10 answers)", { skip: LIVE }, async () => {
  const uid = await freshTestUser();
  const t0 = Date.now();
  // 50 answers, all "now" (so recent == total) → both arms = now + 30d + 50/10 d = now + 35d.
  const evs = Array.from({ length: 50 }, (_, i) =>
    ({ ts: t0 + i, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }));
  await postEvents(uid, evs);
  const { delete_after } = await (await fetch(`${WORKER}/v1/user/${encodeURIComponent(uid)}/events`)).json();
  assert.ok(Math.abs(delete_after - (t0 + 35 * 86400000)) < 60000, `≈ now + 35d (got ${delete_after})`);
});

test("dashboard: shows the data-kept-until date", { skip: LIVE }, async (t) => {
  const uid = await freshTestUser();
  await postEvents(uid, saFixture(Date.now()));
  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),   // own dashboard
  });
  t.after(close);
  await waitFor(() => win.retention && !win.retention.hidden ? true : null, WAIT);
  assert.match(win.retention.querySelector('[data-stat="kept"]').textContent, /^\d{4}-\d{2}-\d{2}$/, "kept-until stat shows a date");
});

test("dashboard: native testers (role 2) get a native-testing badge", { skip: LIVE }, async (t) => {
  const uid = await freshTestUser();
  await postEvents(uid, saFixture(Date.now()));
  localSql(`UPDATE users SET role=2 WHERE uid='${uid}'`);
  const { win, close } = await openPage(`/dashboard/?uid=${uid}`, {
    setup: (w) => w.localStorage.setItem("uid", uid),
  });
  t.after(close);
  await waitFor(() => win.nativebadge && !win.nativebadge.hidden ? true : null, WAIT);
  assert.match(win.nativebadge.textContent, /native testing mode/);
});

// The canary backstop (isolated only, queries via local SQL — no fetch, so the
// janitor test's dead socket doesn't matter; placed before it so it sees every
// API-written user). The isolated DB starts empty, so every row was written by
// this suite, and the HARD RULE is that any uid posting answers must be
// unmistakably ours: nickname = TEST_NICK, even role-0 "counted" users. Forget to
// route a writer through freshTestUser and this goes red, naming the offenders.
// (Nickname is the universal canary; the sentinel tz is the factory default, but
// the no-tz-default tests deliberately set it null — so tz isn't asserted here.)
test("guard: every uid that posts answers carries the TestUser canary nickname", { skip: !ISOLATED }, () => {
  const bad = localSql(
    `SELECT u.uid, u.role, u.nickname, u.tz_offset,
            (SELECT COUNT(*) FROM events e WHERE e.uid = u.uid) AS n_events
     FROM users u
     WHERE EXISTS (SELECT 1 FROM events e WHERE e.uid = u.uid AND e.ev IN ('a','g','y','n'))
       AND u.nickname IS NOT '${TEST_NICK}'`);
  assert.equal(bad.length, 0,
    `untagged answer-posting users (must be nickname='${TEST_NICK}' — route via freshTestUser):\n${JSON.stringify(bad, null, 2)}`);
});

// Runs LAST: triggering /__scheduled drops this process's keep-alive socket to the
// worker, so a following fetch in this file would fail (undici reuses the dead
// socket). The separate api.test.mjs process has its own pool, so it's unaffected.
// skip on LIVE: seeds backdated rows via local SQL and fires the cron.
test("janitor: the cron purges idle role-1 test users and their data", { skip: LIVE }, async () => {
  const old = "janitor-old-" + randomUUID();
  const fresh = "janitor-new-" + randomUUID();
  const real = "janitor-real-" + randomUUID();
  const t2h = Date.now() - 2 * 60 * 60 * 1000, now = Date.now();
  const evRow = (uid, ts) => `('${uid}',${ts},'sa',0,'sa',2)`;
  // old role-1 (idle 2h) + fresh role-1 (now) + an old role-0; the role-1s get an event.
  localSql(`INSERT INTO users (uid, first_seen, last_seen, role) VALUES ('${old}',${t2h},${t2h},1),('${fresh}',${now},${now},1),('${real}',${t2h},${t2h},0)`);
  localSql(`INSERT INTO events (uid, ts, target, idx, picked, cap) VALUES ${evRow(old, t2h)},${evRow(fresh, now)}`);

  await fetch(`${WORKER}/__scheduled`);   // run scheduled() → runJanitor (reminders no-op without VAPID)

  const count = (tbl, uid) => localSql(`SELECT COUNT(*) AS c FROM ${tbl} WHERE uid='${uid}'`)[0].c;
  try {
    assert.equal(count("users", old), 0, "idle role-1 user deleted");
    assert.equal(count("events", old), 0, "its events deleted");
    assert.equal(count("users", fresh), 1, "recent role-1 user kept (no mid-verify deletion)");
    assert.equal(count("events", fresh), 1, "recent role-1 user's events kept");
    assert.equal(count("users", real), 1, "old role-0 user untouched (role filter)");
  } finally {
    localSql(`DELETE FROM events WHERE uid IN ('${old}','${fresh}','${real}')`);
    localSql(`DELETE FROM users WHERE uid IN ('${old}','${fresh}','${real}')`);
  }
});
