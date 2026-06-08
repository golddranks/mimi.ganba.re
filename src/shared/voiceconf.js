// The sound-file confusion matrix — per-recording confusion grouped by mora,
// shared by the admin dashboard (all-users data) and the per-user dashboard
// (the viewer's own data). DOM-touching, frontend-only.

import { HIRAGANA, KATAKANA, VOWEL_GROUPS } from "./kana.js";
import { confusionBg } from "./confusion.js";

// Click-to-play a recording. VOICE_MAP (injected by build) maps mora -> [voice
// names]; audio lives at ../audio/<vowel>/<mora>/<idx>.opus relative to the page
// (both /admin/ and /dashboard/ sit one level under the site root). One Audio
// instance, so a second click cancels the previous playback.
const voiceAudio = new Audio();
export function playVoice(mora, voice) {
  const list = (window.VOICE_MAP || {})[mora] || [];
  const idx = list.indexOf(voice);
  if (idx < 0) return;
  voiceAudio.src = `../audio/${mora.slice(-1)}/${mora}/${idx}.opus`;
  voiceAudio.currentTime = 0;
  voiceAudio.play().catch(() => { });
}

// Render the matrix into `container`. `shownRows`/`offeredRows` are
// [{t,v,p,n}] / [{t,v,k,n}] — picks / offers per (recording, kana). The row list
// iterates the current build's VOICE_MAP so newly-added recordings appear (and
// removed ones drop out). `minA` = min times asked, `minW` = min worst-confusion
// %, `mode` = "pct"|"count". Cells show the same pairwise pick-when-offered value
// as the main confusion matrix; rows are ordered hardest-first within each sound.
export function drawVoiceConfusion(container, shownRows, offeredRows, { mode, minA, minW }) {
  const map = window.VOICE_MAP || {};
  const shown = {}, offered = {};
  for (const r of shownRows) shown[`${r.t}/${r.v}/${r.p}`] = r.n;
  for (const r of offeredRows) offered[`${r.t}/${r.v}/${r.k}`] = r.n;

  // A (recording, kana) cell's confusion rate (0..100): picks ÷ times that kana
  // was offered for this recording. Independent of the count/% display mode.
  const offPct = (m, voice, p) => {
    const off = offered[`${m}/${voice}/${p}`] || 0;
    return off > 0 ? (shown[`${m}/${voice}/${p}`] || 0) / off * 100 : 0;
  };
  // Worst off-diagonal rate in a row — drives the wrong-% filter and orders
  // recordings hardest-first, surfacing the ones driving a specific confusion.
  const rowMaxOffPct = (m, voice) => {
    let max = 0;
    for (const p of VOWEL_GROUPS[m.slice(-1)] || []) {
      if (p === m) continue;
      const pct = offPct(m, voice, p);
      if (pct > max) max = pct;
    }
    return max;
  };
  const valueFor = (m, voice, p) => {
    const pct = offPct(m, voice, p);
    const n = shown[`${m}/${voice}/${p}`] || 0;
    const off = offered[`${m}/${voice}/${p}`] || 0;
    if (mode === "pct") {
      const display = (off > 0 && n > 0) ? (Math.round(pct) === 0 ? "<1" : String(Math.round(pct))) : "";
      return { display, mag: pct, raw: off };
    }
    return { display: off ? `${n}/${off}` : "", mag: pct, raw: off };
  };

  const html = [];
  for (const v of ["a", "i", "u", "o"]) {
    const morae = VOWEL_GROUPS[v];

    // Keep the per-sound clustering (morae in fixed order), but within each sound
    // order its recordings hardest-first by their worst per-kana confusion rate.
    const rowsInGroup = [];
    for (const m of morae) {
      const voices = (map[m] || []).filter((voice) => {
        // Times this recording was asked = times its own kana was offered (the
        // target is always an option), read off the offered map.
        const attempts = offered[`${m}/${voice}/${m}`] || 0;
        if (attempts < minA) return false;
        if (minW > 0 && rowMaxOffPct(m, voice) < minW) return false;
        return true;
      });
      voices.sort((a, b) => rowMaxOffPct(m, b) - rowMaxOffPct(m, a));
      // idx = the recording's position in the current voice set, i.e. its current
      // file id (audio/<vowel>/<mora>/<idx>.opus) — mutable as voices are
      // added/reordered, unlike the stable voice name.
      for (const voice of voices) rowsInGroup.push({ m, voice, idx: (map[m] || []).indexOf(voice) });
    }

    let maxOn = 0, maxOff = 0;
    for (const row of rowsInGroup) {
      for (const p of morae) {
        const mag = valueFor(row.m, row.voice, p).mag;
        if (row.m === p) maxOn = Math.max(maxOn, mag); else maxOff = Math.max(maxOff, mag);
      }
    }

    let header = `<tr><th></th><th></th>`;
    for (const p of morae) header += `<th>${HIRAGANA[p]}</th>`;
    header += `</tr>`;

    let body = "";
    let lastMora = null;
    const spacer = `<tr class="moragap" aria-hidden="true"><td colspan="${2 + morae.length}"></td></tr>`;
    for (const row of rowsInGroup) {
      // Empty spacer row between sound clusters (fixed td height under
      // border-box eats padding/border on the first row, so a row is the only
      // reliable whitespace). vname carries data-mora/data-voice for the
      // click-to-play delegation; vmora is katakana (heard side). The voice name
      // is in a span so it can ellipsis-truncate without widening the th.
      if (row.m !== lastMora && body !== "") body += spacer;
      lastMora = row.m;
      body += `<tr><th class="vmora">${KATAKANA[row.m]}</th><th class="vname" data-mora="${row.m}" data-voice="${row.voice}" title="${row.voice} — current id ${row.idx}"><span>${row.voice}</span></th>`;
      for (const p of morae) {
        const val = valueFor(row.m, row.voice, p);
        const diag = row.m === p;
        const cls = ((diag ? "diag" : "") + (val.raw === 0 ? " empty" : "")).trim();
        // No-data cells: no inline bg, so the .empty CSS (light grey) shows.
        const style = val.raw === 0 ? "" : ` style="background:${confusionBg(val.mag, diag, maxOn, maxOff)}"`;
        body += `<td class="${cls}"${style} title="${row.m} (${row.voice}) → ${p}: ${val.raw}">${val.display}</td>`;
      }
      body += `</tr>`;
    }

    html.push(`<div class="confgroup">
      <table class="vconfgrid">
        <thead>${header}</thead>
        <tbody>${body || `<tr><td colspan="${2 + morae.length}" style="text-align:left;color:var(--muted);padding:.4rem 0">no recordings meet the filters</td></tr>`}</tbody>
      </table>
    </div>`);
  }
  container.innerHTML = html.join("");
}
