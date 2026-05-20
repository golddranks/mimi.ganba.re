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


def collect_jobs() -> list[Job]:
    jobs: list[Job] = []
    for mora_dir in sorted(MORAE_GOOD.iterdir()):
        if not mora_dir.is_dir():
            continue
        entry = MORAE.get(mora_dir.name)
        if not entry:
            continue
        mora, vowel = entry
        wavs = sorted(p for p in mora_dir.iterdir() if p.name.endswith(".wav"))
        for i, src in enumerate(wavs):
            dst = DIST / "audio" / vowel / mora / f"{i}.opus"
            jobs.append(Job(src=src, dst=dst, mora=mora))
    return jobs


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
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    src = re.sub(r"//[^\n]*", "", src)
    # Stash string/template literals so whitespace collapse doesn't touch them.
    preserved: list[str] = []
    def stash(m: re.Match) -> str:
        preserved.append(m.group(0))
        return f"\x00{len(preserved) - 1}\x00"
    src = re.sub(r"`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"", stash, src)
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


def bundle_index(counts: dict[str, int]) -> None:
    html = (SRC / "index.html").read_text(encoding="utf-8")
    css = minify_css((SRC / "app.css").read_text(encoding="utf-8"))
    js = minify_js((SRC / "app.js").read_text(encoding="utf-8"))
    counts_js = json.dumps(counts, ensure_ascii=False, separators=(",", ":"))

    html = re.sub(
        r'<link\s+rel="stylesheet"\s+href="app\.css"\s*/?>',
        lambda _m: f"<style>{css}</style>",
        html, count=1,
    )
    html = re.sub(
        r'<script\s+src="app\.js"></script>',
        lambda _m: f"<script>window.VOICE_COUNTS={counts_js};{js}</script>",
        html, count=1,
    )
    html = re.sub(r">\s+<", "><", html).strip()
    (DIST / "index.html").write_text(html, encoding="utf-8")
    (DIST / ".nojekyll").write_text("")
    shutil.copy(SRC / "favicon.svg", DIST / "favicon.svg")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build a self-contained distribution under dist/.")
    ap.add_argument("--no-audio", action="store_true",
                    help="Reuse existing dist/audio (skip transcoding).")
    args = ap.parse_args()

    jobs = collect_jobs()
    if not jobs:
        sys.exit(f"No voices found under {MORAE_GOOD.relative_to(ROOT)}/.")

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

    bundle_index(counts)

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
