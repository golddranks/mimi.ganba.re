// Full-stack DOM e2e: drive the app pages in happy-dom against a real worker.
// The app's answers POST real events through the worker into D1; the dashboard
// reads them back and renders. One set of cases, two targets:
//   - local (default): built dist/ + a worker booted by scripts/e2e.sh
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

// Register a uid as an automatic test user (role 1) so the worker excludes its
// rows from production aggregates (EXCLUDE_TEST = role 0). Every uid the suite
// writes under goes through this — keeping writes prod-safe and isolated (a
// fresh uid sees only its own events, so exact counts hold live as well as
// local).
const registerTestUser = (uid) =>
  fetch(`${WORKER}/v1/user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, nickname: "TestUser", role: 1 }),
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
// Honors WRANGLER_PERSIST so it targets the state dir e2e.sh booted on.
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

// skip on LIVE: this posts role-0 events (the ranking's input), which would
// pollute prod. Uses mora 'zo' — untouched by any other test — so the global
// ranking sees only this scenario for that recording.
test("native pairs: keeps high-wrong recordings, drops expert-vetted ones", { skip: LIVE }, async () => {
  const answer = (uid, confuser, n, correct = false) =>
    postEvents(uid, Array.from({ length: n }, (_, i) => ({
      ts: Date.now() + i, target: "zo", idx: 0, picked: correct ? "zo" : confuser,
      cap: 2, ms: 500, ev: "a", opts: ["zo", confuser], skill: 0,
    })));
  // (zo#0, so): a normal listener picks 'so' 3/3 → high wrong-rate, no expert data → kept.
  await answer(randomUUID(), "so", 3);
  // (zo#0, syo): a normal listener also confuses it (3/3 wrong) ...
  await answer(randomUUID(), "syo", 3);
  // ... but 6 high-accuracy (100% 'zo') offers of 'syo' vet it → dropped despite the wrong-rate.
  await answer(randomUUID(), "syo", 6, true);

  const { pairs } = await (await fetch(`${WORKER}/v1/native/pairs`)).json();
  const has = (c) => pairs.some((p) => p.mora === "zo" && p.confuser === c);
  assert.ok(has("so"), "kept the high-wrong, un-vetted pair");
  assert.ok(!has("syo"), "dropped the pair vetted by ≥5 expert offers");
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

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`);
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

  await waitFor(() => !detail.hidden && detail.querySelectorAll("svg circle, svg path").length > 0, WAIT);
  assert.equal(detail.querySelectorAll("svg circle, svg path").length, 6, "one ○/✕ mark per offered event");
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

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`);
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

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`);
  t.after(close);
  const overview = win.document.getElementById("overview");
  const stat = (k) => overview.querySelector(`[data-stat="${k}"]`).textContent;

  await waitFor(() => stat("answers") === "3" || null, WAIT);
  assert.equal(stat("correct"), "2", "the Y/N 'no' reject counts as correct");
});

test("admin: confusion matrix uses server-aggregated pick-when-offered counts", { skip: LIVE }, async (t) => {
  // Local-only: needs power_user granted via local SQL, and unlike the rest its
  // rows must stay *in* the aggregate (so its uid is NOT a TestUser). The admin
  // matrix is global (all users), so we can't assert exact counts against a
  // snapshot — add the sa fixture and assert robust shape: "picked/offered" with
  // picked<=offered.
  const uid = randomUUID();
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);
  grantPowerUser(uid, 1);

  const { win, close } = await openPage(`/admin/?uid=${uid}`);
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

test("admin: Y/N answers feed the server confusion matrix", { skip: LIVE }, async () => {
  // The admin matrix is a global aggregate, so we can't assert absolute counts;
  // instead assert the *delta* a Y/N batch adds to the sa/za cell — robust against
  // whatever else is in the aggregate, since only this batch lands between reads.
  // Needs a non-TestUser uid (so the rows stay in the aggregate) + power_user.
  const uid = randomUUID();
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

test("dashboard: per-user sound-file confusion matrix renders the viewer's recordings", async (t) => {
  // Per-uid, exact counts. saFixture is all idx 0, so every answer is the same
  // sa recording; the worker assigns its voice at ingest. For that recording, za
  // is picked 3× of 5 offered. The matrix lives in a collapsed <details> but is
  // rendered into the DOM regardless.
  const uid = await freshTestUser();
  assert.equal((await postEvents(uid, saFixture(Date.now()))).status, 200);
  const voice = (await getEvents(uid)).find((e) => e.target === "sa" && e.idx === 0)?.voice;
  assert.ok(voice, "worker assigned a voice to sa#0");

  const { win, close } = await openPage(`/dashboard/?uid=${uid}`);
  t.after(close);

  const cell = await waitFor(() => {
    const td = [...win.voiceconf.querySelectorAll("td")]
      .find((d) => d.title.startsWith(`sa (${voice}) → za`));
    return td && /^\d+\/\d+$/.test(td.textContent) ? td.textContent : null;
  });
  assert.equal(cell, "3/5", "sa recording: za picked 3 of 5 offered");
});

test("admin: sound-file matrix exposes per-recording shown/offered (vs the kana)", { skip: LIVE }, async () => {
  // The sound-file confusion matrix normalises a cell by how often that kana was
  // offered FOR THIS RECORDING (not how often the recording was asked). Assert the
  // delta a batch adds to one recording's sa/za cell. Global aggregate → delta;
  // non-TestUser uid so the rows count; power_user for the admin endpoint.
  const uid = randomUUID();
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
  const admin = randomUUID();
  await postEvents(admin, [{ ts: Date.now(), target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }]);
  grantPowerUser(admin, 1);
  const offeredZa = async (minacc) => {
    const d = await (await fetch(`${WORKER}/v1/admin/stats?uid=${admin}&minacc=${minacc}`)).json();
    return (d.confusion_offered || []).find((r) => r.t === "sa" && r.k === "za")?.n || 0;
  };

  const before0 = await offeredZa(0);
  const before90 = await offeredZa(90);

  // A 10%-accuracy user: 1 correct さ, 9 confused さ→ざ (za offered every time).
  const low = randomUUID();
  const t0 = Date.now();
  const events = [{ ts: t0, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }];
  for (let i = 1; i <= 9; i++) {
    events.push({ ts: t0 + i, target: "sa", idx: 0, picked: "za", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 });
  }
  await postEvents(low, events);

  assert.equal(await offeredZa(0) - before0, 10, "minacc=0 counts the low-accuracy user (za offered +10)");
  assert.equal(await offeredZa(90) - before90, 0, "minacc=90 excludes the low-accuracy user");
});

test("voice-attempts: per-recording answer counts (a/g/y/n), test users excluded", async () => {
  const get = async () => (await fetch(`${WORKER}/v1/voice-attempts`)).json();
  const n = (d) => (d.sa && d.sa["7"]) || 0;   // sa recording #7 — assert the delta

  const before = n(await get());

  // Two answers on sa#7 — one multi-choice 'a', one Y/N 'y' — under a real uid.
  const real = randomUUID();   // not a TestUser → counted
  const t0 = Date.now();
  await postEvents(real, [
    { ts: t0 + 1, target: "sa", idx: 7, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 },
    { ts: t0 + 2, target: "sa", idx: 7, picked: "za", cap: 2, ms: 500, ev: "y" },
  ]);
  // One more on sa#7 under a TestUser — must NOT be counted.
  await postEvents(await freshTestUser(),
    [{ ts: t0 + 3, target: "sa", idx: 7, picked: "sa", cap: 2, ms: 500, ev: "a", opts: ["sa", "za"], skill: 0 }]);

  assert.equal(n(await get()) - before, 2, "the two real answers count; the TestUser one is excluded");
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
