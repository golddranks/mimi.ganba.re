"""Split synthesized morae into good/ and needs_review/ based on diagnostics.tsv.

Reads phonetic_training/morae/diagnostics.tsv (output of 01_diagnose.py).
For each wav in audio/:
  - flagged in TSV  -> needs_review/<mora>/<voice>.wav  (symlink)
                     + needs_review/<mora>/<voice>__tile.wav   (the 5× tiled
                       audio that STT received for the tile test)
                     + needs_review/<mora>/<voice>__splice.wav (the
                       pre+mora+post clip that STT received for the splice test)
  - not flagged     -> good/<mora>/<voice>.wav          (symlink)

Also writes needs_review/results.md: per-row explanation of which test
failed and what STT thought it heard instead.

Existing good/ and needs_review/ contents are wiped first.
"""
from __future__ import annotations

import csv
import json
import re
import shutil
import wave
from collections import Counter
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
AUDIO = BASE / "audio"
TSV = BASE / "diagnostics.tsv"
CARRIER_DIR = BASE / "carrier_cache"
CANON = CARRIER_DIR / "canonical.json"
GOOD = BASE / "good"
REVIEW = BASE / "needs_review"

ALL_MORAE = {"す", "ず", "つ", "しゅ", "じゅ", "ちゅ",
             "し", "じ", "ち",
             "さ", "ざ", "しゃ", "じゃ", "ちゃ",
             "そ", "ぞ", "しょ", "じょ", "ちょ"}

ALT_RE = re.compile(r"^(.*?)→(.+?)(?:\s*\[[^\]]*\])?$")


def parse_alts(s: str) -> list[tuple[str, str]]:
    """Parse 'raw→norm [meta] | raw→norm [meta] | ...' into [(raw, norm), ...]."""
    out: list[tuple[str, str]] = []
    if not s or s.startswith("("):
        return out
    for alt in s.split(" | "):
        m = ALT_RE.match(alt.strip())
        if m:
            out.append((m.group(1).strip(), m.group(2).strip()))
    return out


def strip_carrier(s: str, pre: str, post: str) -> str:
    """Strip longest common prefix with pre, longest common suffix with post."""
    i = 0
    while i < min(len(s), len(pre)) and s[i] == pre[i]:
        i += 1
    j = 0
    while j < min(len(s) - i, len(post)) and s[-1 - j] == post[-1 - j]:
        j += 1
    return s[i:len(s) - j]


def dominant_mora(text: str, target: str) -> str:
    """Most common hard mora present in text, excluding the target."""
    counts: Counter[str] = Counter()
    for i in range(len(text) - 1):
        pair = text[i:i + 2]
        if pair in ALL_MORAE and pair != target:
            counts[pair] += 1
    for ch in text:
        if ch in ALL_MORAE and ch != target:
            counts[ch] += 1
    if not counts:
        return ""
    return counts.most_common(1)[0][0]


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return a, sr


def write_wav(path: Path, samples: np.ndarray, sr: int) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(samples.tobytes())


def render_stt_inputs(mora: str, voice: str, src: Path, dest_dir: Path) -> None:
    """Write the exact wavs that 01_diagnose.py sent to STT:
       <voice>__tile.wav and <voice>__splice.wav (if carriers cached)."""
    a, sr = read_wav(src)
    gap = np.zeros(int(sr * 0.3), dtype=np.int16)
    tile = np.concatenate([x for _ in range(5) for x in (a, gap)])
    write_wav(dest_dir / f"{voice}__tile.wav", tile, sr)
    pre_p = CARRIER_DIR / f"{voice}__pre.wav"
    post_p = CARRIER_DIR / f"{voice}__post.wav"
    if pre_p.exists() and post_p.exists():
        p, sr_p = read_wav(pre_p)
        q, sr_q = read_wav(post_p)
        if sr == sr_p == sr_q:
            splice = np.concatenate([p, gap, a, gap, q])
            write_wav(dest_dir / f"{voice}__splice.wav", splice, sr)


def classify_files(flagged: set[tuple[str, str]]) -> tuple[int, int]:
    for d in (GOOD, REVIEW):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir()
    wavs = sorted(AUDIO.rglob("*.wav"))
    n_good = n_review = 0
    for wav in wavs:
        mora = wav.parent.name
        voice = wav.stem
        is_flagged = (mora, voice) in flagged
        dest_root = REVIEW if is_flagged else GOOD
        link = dest_root / mora / f"{voice}.wav"
        link.parent.mkdir(parents=True, exist_ok=True)
        rel = Path("..") / ".." / wav.relative_to(BASE)
        link.symlink_to(rel)
        if is_flagged:
            render_stt_inputs(mora, voice, wav, link.parent)
            n_review += 1
        else:
            n_good += 1
    return n_good, n_review


def write_report(rows: list[dict]) -> None:
    canon: dict = {}
    if CANON.exists():
        canon = json.loads(CANON.read_text())

    by_mora: dict[str, list[dict]] = {}
    for r in rows:
        by_mora.setdefault(r["mora"], []).append(r)

    n_tile = sum(1 for r in rows if r["failed"] == "tile")
    n_splice = sum(1 for r in rows if r["failed"] == "splice")
    n_both = sum(1 for r in rows if r["failed"] == "tile,splice")

    lines: list[str] = [
        "# Mispronunciation Review",
        "",
        f"Total flagged: **{len(rows)}** "
        f"(tile-only: {n_tile}, splice-only: {n_splice}, both: {n_both})",
        "",
        "Generated from `../diagnostics.tsv`. For each flagged voice, shows "
        "which STT test failed and what mora it sounded like instead.",
        "",
    ]

    for mora in sorted(by_mora):
        lines.append(f"## {mora}  ({len(by_mora[mora])} flagged)")
        lines.append("")
        for r in sorted(by_mora[mora], key=lambda x: (x["failed"], x["voice"])):
            voice = r["voice"]
            failed = r["failed"]
            tile_alts = parse_alts(r["tile_heard"])
            splice_alts = parse_alts(r["splice_heard"])
            vc = canon.get(voice, {})
            pre = vc.get("pre", "")
            post = vc.get("post", "")

            lines.append(f"### {voice}  — *{failed} failed*")

            if "tile" in failed:
                heard = " / ".join(f"`{n}`" for _, n in tile_alts[:3]) or "(empty)"
                guess = dominant_mora(tile_alts[0][1], mora) if tile_alts else ""
                guess_str = f" → heard as **{guess}**" if guess else ""
                lines.append(f"- **tile**: {heard}{guess_str}")
            else:
                lines.append("- tile: passed")

            if "splice" in failed:
                if splice_alts:
                    middles = [strip_carrier(n, pre, post) for _, n in splice_alts]
                    if all(not m for m in middles):
                        lines.append("- **splice**: nothing transcribed "
                                     "between carrier halves "
                                     "(silence / unrecognized noise)")
                    else:
                        mids_str = " / ".join(f"`{m}`" if m else "`(empty)`"
                                              for m in middles[:3])
                        # pick guess from first non-empty middle
                        guess = ""
                        for m in middles:
                            if m:
                                guess = dominant_mora(m, mora)
                                if guess:
                                    break
                        guess_str = (f" → heard as **{guess}**" if guess
                                     else " → no recognizable mora in middle")
                        lines.append(f"- **splice** (middle): {mids_str}{guess_str}")
                else:
                    lines.append("- **splice**: STT returned no transcript")
            else:
                lines.append("- splice: passed")
            lines.append("")

    (REVIEW / "results.md").write_text("\n".join(lines))


def main() -> None:
    with TSV.open() as f:
        rows = list(csv.DictReader(f, delimiter="\t"))
    flagged = {(r["mora"], r["voice"]) for r in rows}
    print(f"diagnostics.tsv: {len(flagged)} flagged (mora,voice) entries")

    n_good, n_review = classify_files(flagged)
    print(f"good: {n_good}  needs_review: {n_review}  total: {n_good + n_review}")

    write_report(rows)
    print(f"wrote {REVIEW / 'results.md'}")


if __name__ == "__main__":
    main()
