#!/usr/bin/env python3
"""Build a self-contained distribution under dist/.

Reads data/phonetic_training/morae/good/ (the symlinks to STT-verified voice
samples), transcodes each underlying WAV to Opus, and assembles a static
site ready to deploy to GitHub Pages:

    dist/
      .nojekyll
      index.html                     # css + js + voice counts inlined
      audio/<vowel>/<mora>/<i>.opus  # voice files renumbered 0..N-1

The mora/vowel structure is hardcoded in src/app.js; only the per-mora
voice counts are dynamic, and the build injects them as window.VOICE_COUNTS.

Pass --no-audio to skip transcoding when iterating on src/ only.

Requires: ffmpeg with libopus on PATH.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MORAE_GOOD = ROOT / "data" / "phonetic_training" / "morae" / "good"
SRC = ROOT / "src"
DIST = ROOT / "dist"
WORKER = ROOT / "worker"

# Source dirs are named in hiragana; we transcode them to kunrei-shiki so the
# bundled URLs are pure ASCII (audio/a/sa/0.opus rather than %E3%81%95/…).
MORAE = {
    "さ": ("sa", "a"), "ざ": ("za", "a"),
    "しゃ": ("sya", "a"), "じゃ": ("zya", "a"), "ちゃ": ("tya", "a"),
    "し": ("si", "i"), "じ": ("zi", "i"), "ち": ("ti", "i"),
    "す": ("su", "u"), "ず": ("zu", "u"), "つ": ("tu", "u"),
    "しゅ": ("syu", "u"), "じゅ": ("zyu", "u"), "ちゅ": ("tyu", "u"),
    "そ": ("so", "o"), "ぞ": ("zo", "o"),
    "しょ": ("syo", "o"), "じょ": ("zyo", "o"), "ちょ": ("tyo", "o"),
}

BITRATE_KBPS = 48


@dataclass
class Job:
    src: Path
    dst: Path
    mora: str


def check_ffmpeg() -> None:
    try:
        subprocess.run(["ffmpeg", "-version"], check=True, capture_output=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        sys.exit("ffmpeg not found on PATH. Install ffmpeg (with libopus) and retry.")


def collect_jobs() -> tuple[list[Job], dict[str, list[str]]]:
    """Enumerate transcode jobs and the (mora → [voice_name_by_idx]) map.

    The DB only stores `(target, idx)` so the per-sound-file admin view needs
    a build-time map to resolve idx back to its original source name (e.g.
    "Neural2-B"). The map mirrors whatever the current build's alphabetical
    `sorted(wavs)` produces — if voices are added/removed/reordered, idx
    values in older events may point at a different voice than they did at
    capture time. Rebuild after touching `data/phonetic_training/morae/good/`.
    """
    jobs: list[Job] = []
    voice_map: dict[str, list[str]] = {}
    for mora_dir in sorted(MORAE_GOOD.iterdir()):
        if not mora_dir.is_dir():
            continue
        entry = MORAE.get(mora_dir.name)
        if not entry:
            continue
        mora, vowel = entry
        wavs = sorted(p for p in mora_dir.iterdir() if p.name.endswith(".wav"))
        voice_map[mora] = [p.stem for p in wavs]
        for i, src in enumerate(wavs):
            dst = DIST / "audio" / vowel / mora / f"{i}.opus"
            jobs.append(Job(src=src, dst=dst, mora=mora))
    return jobs, voice_map


def transcode(job: Job) -> tuple[Path, str | None]:
    job.dst.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-i", str(job.src),
         "-c:a", "libopus", "-b:a", f"{BITRATE_KBPS}k",
         "-ac", "1", "-application", "audio",
         str(job.dst)],
        capture_output=True, text=True,
    )
    return job.dst, None if proc.returncode == 0 else proc.stderr.strip()


# ---------- minification ----------
# Source-aware: assumes app.css/app.js don't contain strings/regexes that look
# like comments (e.g. URLs with "//"). True for the current sources.

def minify_css(src: str) -> str:
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    src = re.sub(r"\s*([{}:;,>])\s*", r"\1", src)
    return re.sub(r"\s+", " ", src).strip()


def minify_js(src: str) -> str:
    # Single pass: at each position try strings/templates and comments together,
    # so a `'` inside a `// comment` doesn't get mistaken for a string opener
    # and a `//` inside a "https://..." doesn't get mistaken for a comment.
    preserved: list[str] = []
    def handle(m: re.Match) -> str:
        s = m.group(0)
        if s.startswith("/*") or s.startswith("//"):
            return ""           # drop comment
        preserved.append(s)
        return f"\x00{len(preserved) - 1}\x00"
    src = re.sub(
        r"`(?:\\.|[^`\\])*`"
        r"|'(?:\\.|[^'\\])*'"
        r"|\"(?:\\.|[^\"\\])*\""
        r"|/\*[\s\S]*?\*/"
        r"|//[^\n]*",
        handle, src,
    )
    src = re.sub(r"\s+", " ", src)
    src = re.sub(r" ?([^\w\s$]) ?", r"\1", src).strip()
    return re.sub(r"\x00(\d+)\x00", lambda m: preserved[int(m.group(1))], src)


def transcode_all(jobs: list[Job]) -> None:
    print(f"Transcoding {len(jobs)} files → Opus @ {BITRATE_KBPS}k mono …")
    failures: list[tuple[Path, str]] = []
    with ProcessPoolExecutor() as pool:
        for n, (dst, err) in enumerate(pool.map(transcode, jobs), 1):
            if err:
                failures.append((dst, err))
            if n % 50 == 0 or n == len(jobs):
                print(f"  {n}/{len(jobs)}")
    if failures:
        for dst, err in failures[:5]:
            print(f"  FAIL {dst.relative_to(DIST)}: {err[:200]}", file=sys.stderr)
        sys.exit(f"{len(failures)} transcode(s) failed.")


def inline(html: str, src_dir: Path, css_name: str | None, js_name: str | None,
           js_prelude: str = "") -> str:
    """Inline <link rel=stylesheet> and <script src> into the HTML, minified."""
    if css_name:
        css = minify_css((src_dir / css_name).read_text(encoding="utf-8"))
        html = re.sub(
            rf'<link\s+rel="stylesheet"\s+href="{re.escape(css_name)}"\s*/?>',
            lambda _m: f"<style>{css}</style>",
            html, count=1,
        )
    if js_name:
        js = minify_js((src_dir / js_name).read_text(encoding="utf-8"))
        html = re.sub(
            rf'<script\s+src="{re.escape(js_name)}"></script>',
            lambda _m: f"<script>{js_prelude}{js}</script>",
            html, count=1,
        )
    return re.sub(r">\s+<", "><", html).strip()


def bundle_index(counts: dict[str, int]) -> None:
    html = (SRC / "index.html").read_text(encoding="utf-8")
    counts_js = json.dumps(counts, ensure_ascii=False, separators=(",", ":"))
    html = inline(html, SRC, "app.css", "app.js",
                  js_prelude=f"window.VOICE_COUNTS={counts_js};")
    (DIST / "index.html").write_text(html, encoding="utf-8")
    (DIST / ".nojekyll").write_text("")
    shutil.copy(SRC / "favicon.svg", DIST / "favicon.svg")


def bundle_dashboard() -> None:
    src = SRC / "dashboard"
    html = inline((src / "index.html").read_text(encoding="utf-8"),
                  src, "dashboard.css", "dashboard.js")
    out = DIST / "dashboard"
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")


def bundle_privacy() -> None:
    src = SRC / "privacy"
    html = inline((src / "index.html").read_text(encoding="utf-8"),
                  src, "privacy.css", None)
    out = DIST / "privacy"
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")


def write_worker_voicemap(voice_map: dict[str, list[str]]) -> None:
    """Emit worker/src/voicemap.js (committed) and worker/migrate-voices.sql
    (one-shot, gitignored). The worker imports voicemap.js to resolve
    (mora, idx) → voice name when inserting events, so each row preserves
    voice identity even if the voice set is reordered or extended later."""
    body = json.dumps(voice_map, ensure_ascii=False, indent=2)
    (WORKER / "src" / "voicemap.js").write_text(
        "// Auto-generated by scripts/build.py — do not edit by hand.\n"
        "// (mora, idx) → voice name. The build is authoritative; if voices\n"
        "// change, re-run scripts/build.py and redeploy the worker.\n\n"
        f"export const VOICE_MAP = {body};\n\n"
        "export function nameOf(mora, idx) {\n"
        "  const arr = VOICE_MAP[mora];\n"
        "  return arr && idx >= 0 && idx < arr.length ? arr[idx] : null;\n"
        "}\n",
        encoding="utf-8",
    )

    # One-shot backfill SQL for the live DB: adds the column and fills voice
    # on existing rows using the CURRENT map (= snapshot of voice identity at
    # migration time; future rows are filled by the worker).
    #
    # Backfill is restricted to 'a'/'g'/'r' events because there idx has
    # consistently meant target's voice idx, both before and after the
    # schema change. For pre-change 'p' rows, idx was target's voice idx
    # (legacy semantic) — but under the new semantic idx is picked's voice
    # idx, and we can't recover what was played retroactively. Those 'p'
    # rows stay with voice = NULL and are excluded from admin aggregates.
    lines = [
        "-- Auto-generated by scripts/build.py — one-shot.",
        "-- Run via: npx wrangler d1 execute mimi-stats --remote --file=migrate-voices.sql",
        "-- (The ALTER TABLE statement will error if re-run; that's expected.)",
        "",
        "ALTER TABLE events ADD COLUMN voice TEXT;",
        "",
        "-- voice for 'a'/'g'/'r' events (idx = target's voice idx under both",
        "-- old and new semantics; backfill is correct):",
    ]
    for mora, voices in voice_map.items():
        for i, voice in enumerate(voices):
            # Voice names are alphanumeric + dashes today; escape single quotes
            # defensively in case future ones contain them.
            esc = voice.replace("'", "''")
            lines.append(
                f"UPDATE events SET voice='{esc}' "
                f"WHERE voice IS NULL AND ev IN ('a','g','r') AND target='{mora}' AND idx={i};"
            )
    (WORKER / "migrate-voices.sql").write_text("\n".join(lines) + "\n", encoding="utf-8")


def bundle_admin(voice_map: dict[str, list[str]]) -> None:
    src = SRC / "admin"
    voice_js = json.dumps(voice_map, ensure_ascii=False, separators=(",", ":"))
    html = inline((src / "index.html").read_text(encoding="utf-8"),
                  src, "admin.css", "admin.js",
                  js_prelude=f"window.VOICE_MAP={voice_js};")
    out = DIST / "admin"
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build a self-contained distribution under dist/.")
    ap.add_argument("--no-audio", action="store_true",
                    help="Reuse existing dist/audio (skip transcoding).")
    ap.add_argument("--voicemap-only", action="store_true",
                    help="Only regenerate worker/src/voicemap.js (and worker/migrate-voices.sql); "
                         "skip audio transcoding and HTML bundles. Used by worker CD.")
    args = ap.parse_args()

    jobs, voice_map = collect_jobs()
    if not jobs:
        sys.exit(f"No voices found under {MORAE_GOOD.relative_to(ROOT)}/.")

    if args.voicemap_only:
        write_worker_voicemap(voice_map)
        print(f"Wrote worker/src/voicemap.js and worker/migrate-voices.sql.")
        return

    if args.no_audio:
        if not (DIST / "audio").exists():
            sys.exit("--no-audio requires an existing dist/audio. Build without --no-audio first.")
    else:
        check_ffmpeg()
        if DIST.exists():
            shutil.rmtree(DIST)
        DIST.mkdir()
        transcode_all(jobs)

    counts: dict[str, int] = {}
    for j in jobs:
        counts[j.mora] = counts.get(j.mora, 0) + 1

    write_worker_voicemap(voice_map)
    bundle_index(counts)
    bundle_dashboard()
    bundle_privacy()
    bundle_admin(voice_map)

    html_bytes = (DIST / "index.html").stat().st_size
    audio = sum(f.stat().st_size for f in (DIST / "audio").rglob("*") if f.is_file())
    total = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(
        f"\ndist/ ready: {total / 1024 / 1024:.2f} MB total"
        f" (index.html {html_bytes / 1024:.1f} KB,"
        f" audio {audio / 1024 / 1024:.2f} MB across {len(jobs)} files)"
    )


if __name__ == "__main__":
    main()
