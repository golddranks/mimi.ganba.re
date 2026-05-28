#!/usr/bin/env python3
"""Transcode WAV → Opus for the static site bundle.

Reads build/voices.json (produced by scripts/voicemap.py) and writes
dist/audio/<vowel>/<mora>/<i>.opus. Idempotent: skips an output if it
already exists and is newer than its source, so re-running on a warm
dist/audio/ is cheap (no ffmpeg invocations).

Requires: ffmpeg with libopus on PATH.
"""

import json
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MORAE_GOOD = ROOT / "data" / "phonetic_training" / "morae" / "good"
BUILD = ROOT / "build"
DIST = ROOT / "dist"

BITRATE_KBPS = 48


@dataclass
class Job:
    src: Path
    dst: Path


def check_ffmpeg() -> None:
    try:
        subprocess.run(["ffmpeg", "-version"], check=True, capture_output=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        sys.exit("ffmpeg not found on PATH. Install ffmpeg (with libopus) and retry.")


def needs_rebuild(job: Job) -> bool:
    """True if dst is missing or older than src."""
    if not job.dst.exists():
        return True
    return job.dst.stat().st_mtime < job.src.stat().st_mtime


def collect_jobs() -> list[Job]:
    """Build the full job list from build/voices.json — every (mora, voice)
    in the manifest gets its opus filename. needs_rebuild() filters later."""
    manifest_path = BUILD / "voices.json"
    if not manifest_path.exists():
        sys.exit(
            f"{manifest_path.relative_to(ROOT)} missing; "
            f"run scripts/voicemap.py first."
        )
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    jobs: list[Job] = []
    for kunrei, info in data.items():
        vowel = kunrei[-1]   # kunrei's last char IS the vowel (sa→a, sya→a, syu→u)
        hira = info["hiragana"]
        for i, stem in enumerate(info["voices"]):
            src = MORAE_GOOD / hira / f"{stem}.wav"
            dst = DIST / "audio" / vowel / kunrei / f"{i}.opus"
            jobs.append(Job(src=src, dst=dst))
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


def main() -> None:
    all_jobs = collect_jobs()
    pending = [j for j in all_jobs if needs_rebuild(j)]
    if not pending:
        print(f"dist/audio: up to date ({len(all_jobs)} files).")
        return

    check_ffmpeg()
    print(f"Transcoding {len(pending)}/{len(all_jobs)} files → Opus @ {BITRATE_KBPS}k mono …")
    failures: list[tuple[Path, str]] = []
    with ProcessPoolExecutor() as pool:
        for n, (dst, err) in enumerate(pool.map(transcode, pending), 1):
            if err:
                failures.append((dst, err))
            if n % 50 == 0 or n == len(pending):
                print(f"  {n}/{len(pending)}")
    if failures:
        for dst, err in failures[:5]:
            print(f"  FAIL {dst.relative_to(DIST)}: {err[:200]}", file=sys.stderr)
        sys.exit(f"{len(failures)} transcode(s) failed.")
    total = sum(f.stat().st_size for f in (DIST / "audio").rglob("*") if f.is_file())
    print(f"dist/audio: {total / 1024 / 1024:.2f} MB across {len(all_jobs)} files")


if __name__ == "__main__":
    main()
