"""Generate VOICEVOX TTS audio for every word referenced from data/.

Calls the voicevox_engine TTSEngine in-process (no HTTP server). Sources words
from the union of data/pairs/*.tsv (seed and partner sides) and data/hard_words.tsv,
deduped.

Requires the nix-shell environment defined in shell.nix, which exposes the
voicevox_engine Python package and exports VOICEVOX_VOICELIB_DIR.

Usage:
    python3 phonetic_training/words/06_synthesize.py [--style 3]

Output layout:
    phonetic_training/words/audio/<safe_filename>.wav
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import os
import re
import sys
import time
from pathlib import Path

import soundfile as sf
from voicevox_engine.core.core_initializer import initialize_cores
from voicevox_engine.metas.metas import StyleId
from voicevox_engine.model import AudioQuery
from voicevox_engine.tts_pipeline.tts_engine import make_tts_engines_from_cores

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
PAIRS_DIR = DATA / "pairs"

SAFE_RE = re.compile(r"[^0-9A-Za-z぀-ヿ一-鿿_-]+")


def safe_name(expression: str, reading: str) -> str:
    raw = f"{expression}_{reading}"
    base = SAFE_RE.sub("_", raw).strip("_")
    if not base:
        base = "x"
    h = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
    if SAFE_RE.search(raw):
        base = f"{base}_{h}"
    if len(base) > 80:
        base = base[:70] + "_" + h
    return base


def collect_words() -> list[tuple[str, str]]:
    seen: set[tuple[str, str]] = set()

    hard_words = DATA / "hard_words.tsv"
    if hard_words.exists():
        with hard_words.open(encoding="utf-8") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                expr = row["expression"].strip()
                reading = row["reading"].strip()
                if expr and reading:
                    seen.add((expr, reading))

    for path in sorted(PAIRS_DIR.glob("hard_minimal_pairs_*.tsv")):
        with path.open(encoding="utf-8") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                for prefix in ("seed", "partner"):
                    expr = row[f"{prefix}_expression"].strip()
                    reading = row[f"{prefix}_reading"].strip()
                    if expr and reading:
                        seen.add((expr, reading))

    return sorted(seen)


def build_engine():
    voicelib_env = os.environ.get("VOICEVOX_VOICELIB_DIR")
    if not voicelib_env:
        sys.exit("VOICEVOX_VOICELIB_DIR is not set — enter the nix-shell first.")
    voicelib = Path(voicelib_env)
    if not voicelib.is_dir():
        sys.exit(f"VOICEVOX_VOICELIB_DIR does not exist: {voicelib}")

    cores = initialize_cores(use_gpu=False, enable_mock=False, voicelib_dirs=[voicelib])
    mgr = make_tts_engines_from_cores(cores)
    version = mgr.versions()[0]
    return mgr.get_tts_engine(version)


def synthesize_wav(engine, text: str, style: StyleId) -> bytes:
    phrases = engine.create_accent_phrases(text, style, enable_katakana_english=False)
    query = AudioQuery(
        accent_phrases=phrases,
        speedScale=1.0,
        pitchScale=0.0,
        intonationScale=1.0,
        volumeScale=1.0,
        prePhonemeLength=0.1,
        postPhonemeLength=0.1,
        pauseLength=None,
        pauseLengthScale=1.0,
        outputSamplingRate=engine.default_sampling_rate,
        outputStereo=False,
        kana="",
    )
    wave = engine.synthesize_wave(query, style, enable_interrogative_upspeak=False)
    buf = io.BytesIO()
    sf.write(buf, wave, engine.default_sampling_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--style", type=int, default=3,
                    help="VOICEVOX style ID (default 3 = ずんだもん/ノーマル).")
    ap.add_argument("--out", default=str(BASE / "audio"))
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    words = collect_words()
    print(f"unique words to synthesize: {len(words)}")

    engine = build_engine()
    style = StyleId(args.style)

    made = skipped = failed = 0
    t0 = time.time()
    for expression, reading in words:
        name = safe_name(expression, reading)
        out_path = out_dir / f"{name}.wav"
        if out_path.exists() and out_path.stat().st_size > 0:
            skipped += 1
            continue
        try:
            out_path.write_bytes(synthesize_wav(engine, reading, style))
            made += 1
            if made % 25 == 0:
                rate = made / max(time.time() - t0, 0.001)
                print(f"  {made} synthesized "
                      f"({rate:.1f}/s, skipped {skipped})", flush=True)
        except Exception as e:
            failed += 1
            print(f"  FAIL {expression} ({reading}): {e}",
                  file=sys.stderr, flush=True)

    elapsed = time.time() - t0
    print(f"done: total={len(words)} new={made} skipped={skipped} failed={failed} "
          f"in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
