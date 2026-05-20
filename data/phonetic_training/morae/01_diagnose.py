"""Diagnose mispronunciations with two complementary STT tests.

For each mora wav in audio_cloudtts_morae/:
  1. tile test  — 5× repeat with 0.3s gaps, STT
  2. splice test — pre + gap + mora + gap + post, STT, compare target-mora
                   counts against canonical carrier transcript (so carrier
                   words containing the target are subtracted away)

A row is flagged for manual review if EITHER test fails to detect the
target mora. Output: hard_pronunciation/mispronunciations_v3.tsv.

Carrier audio per voice is cached in .carrier_cache/ along with
canonical.json holding each voice's STT transcript of the bare carrier.
"""

import argparse
import base64
import io
import json
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
REPO_ROOT = BASE.parent.parent
KEY = (REPO_ROOT / ".cloudtts_key").read_text().strip()
STT_URL = f"https://speech.googleapis.com/v1/speech:recognize?key={KEY}"
TTS_URL = f"https://texttospeech.googleapis.com/v1/text:synthesize?key={KEY}"
LIVE = BASE / "audio"
CARRIER_DIR = BASE / "carrier_cache"
DEBUG_DIR = BASE / "debug_audio"

CARRIER_PRE = "次のひらがなをよくきいてください。"
CARRIER_POST = "聞こえましたか？"

ALL_MORAE = [
    "す",
    "ず",
    "つ",
    "しゅ",
    "じゅ",
    "ちゅ",
    "し",
    "じ",
    "ち",
    "さ",
    "ざ",
    "しゃ",
    "じゃ",
    "ちゃ",
    "そ",
    "ぞ",
    "しょ",
    "じょ",
    "ちょ",
]


def tts(voice_short: str, text: str) -> bytes:
    body = {
        "input": {"text": text},
        "voice": {"languageCode": "ja-JP", "name": f"ja-JP-{voice_short}"},
        "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000},
    }
    payload = json.dumps(body).encode()
    delay = 2.0
    for attempt in range(6):
        req = urllib.request.Request(
            TTS_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return base64.b64decode(json.load(r)["audioContent"])
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 5:
                time.sleep(delay)
                delay = min(delay * 2, 60.0)
                continue
            raise
    raise RuntimeError("TTS retries exhausted")


def stt(audio_bytes: bytes, sr: int) -> list[str]:
    body = {
        "config": {
            "encoding": "LINEAR16",
            "sampleRateHertz": sr,
            "languageCode": "ja-JP",
            "model": "latest_short",
            "maxAlternatives": 3,
            "speechContexts": [{"phrases": ALL_MORAE, "boost": 20.0}],
        },
        "audio": {"content": base64.b64encode(audio_bytes).decode()},
    }
    payload = json.dumps(body).encode()
    delay = 2.0
    data: dict = {}
    for attempt in range(5):
        req = urllib.request.Request(
            STT_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 4:
                time.sleep(delay)
                delay = min(delay * 2, 30)
                continue
            raise
    if not data.get("results"):
        return []
    return [a.get("transcript", "") for a in data["results"][0].get("alternatives", [])]


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return a, sr


def to_wav_bytes(samples: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(samples.tobytes())
    return buf.getvalue()


def tile(path: Path, repeats: int = 5, gap_s: float = 0.3) -> tuple[bytes, int]:
    a, sr = read_wav(path)
    gap = np.zeros(int(sr * gap_s), dtype=np.int16)
    parts: list[np.ndarray] = []
    for _ in range(repeats):
        parts.extend([a, gap])
    return to_wav_bytes(np.concatenate(parts), sr), sr


def splice(
    mora_path: Path, pre_path: Path, post_path: Path, gap_s: float = 0.3
) -> tuple[bytes, int]:
    pre, sr = read_wav(pre_path)
    mora, sr_m = read_wav(mora_path)
    post, sr_p = read_wav(post_path)
    assert sr == sr_m == sr_p, f"sr mismatch: {sr}/{sr_m}/{sr_p}"
    gap = np.zeros(int(sr * gap_s), dtype=np.int16)
    return to_wav_bytes(np.concatenate([pre, gap, mora, gap, post]), sr), sr


def kata_to_hira(s: str) -> str:
    out = []
    for ch in s:
        c = ord(ch)
        if 0x30A1 <= c <= 0x30F6:
            out.append(chr(c - 0x60))
        elif ch in "ー・":
            continue
        else:
            out.append(ch)
    return "".join(out)


def normalize(text: str) -> str:
    text = kata_to_hira(text)
    if any(0x4E00 <= ord(c) <= 0x9FFF for c in text):
        try:
            import pyopenjtalk

            njd = pyopenjtalk.run_frontend(text)
            yomi = "".join(item.get("pron", item.get("read", "")) for item in njd)
            text = kata_to_hira(yomi)
        except Exception:
            pass
    return text


def ensure_carrier(voice_short: str) -> tuple[Path, Path]:
    CARRIER_DIR.mkdir(exist_ok=True)
    pre_p = CARRIER_DIR / f"{voice_short}__pre.wav"
    post_p = CARRIER_DIR / f"{voice_short}__post.wav"
    if not pre_p.exists() or pre_p.stat().st_size == 0:
        pre_p.write_bytes(tts(voice_short, CARRIER_PRE))
    if not post_p.exists() or post_p.stat().st_size == 0:
        post_p.write_bytes(tts(voice_short, CARRIER_POST))
    return pre_p, post_p


def ensure_canonical(
    voice_short: str, pre_path: Path, post_path: Path, cache: dict
) -> tuple[str, str]:
    entry = cache.get(voice_short, {})
    pre_canon = entry.get("pre", "")
    post_canon = entry.get("post", "")
    if pre_canon and post_canon:
        return pre_canon, post_canon
    pre_a, sr_a = read_wav(pre_path)
    pre_alts = stt(to_wav_bytes(pre_a, sr_a), sr_a)
    post_a, sr_b = read_wav(post_path)
    post_alts = stt(to_wav_bytes(post_a, sr_b), sr_b)
    pre_canon = normalize(pre_alts[0]) if pre_alts else ""
    post_canon = normalize(post_alts[0]) if post_alts else ""
    cache[voice_short] = {"pre": pre_canon, "post": post_canon}
    return pre_canon, post_canon


def check_tile(alts: list[str], target: str) -> tuple[bool, str]:
    if not alts:
        return True, "(empty)"
    normed = [normalize(a) for a in alts]
    if any(target in n for n in normed):
        return True, " | ".join(f"{a}→{n}" for a, n in zip(alts, normed, strict=False))
    if not any(any(0x3040 <= ord(c) <= 0x30FF for c in n) for n in normed):
        return True, "(non-Japanese)"
    return False, " | ".join(f"{a}→{n}" for a, n in zip(alts, normed, strict=False))


def check_splice(alts: list[str], target: str, canon_pre: str, canon_post: str) -> tuple[bool, str]:
    if not alts:
        return True, "(empty)"
    canon_count = (canon_pre + canon_post).count(target)
    formatted: list[str] = []
    detected = False
    for a in alts:
        n = normalize(a)
        n_count = n.count(target)
        formatted.append(f"{a}→{n} [{target}×{n_count}/carrier×{canon_count}]")
        if n_count > canon_count:
            detected = True
    return detected, " | ".join(formatted)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--save-debug",
        action="store_true",
        help="Write tile.wav and splice.wav for each flagged row "
        "to .debug_audio/<mora>/<voice>__{tile,splice}.wav",
    )
    args = ap.parse_args()

    wavs = sorted(LIVE.rglob("*.wav"))
    print(f"diagnosing {len(wavs)} wavs", flush=True)

    canon_cache_path = CARRIER_DIR / "canonical.json"
    canon_cache: dict = {}
    if canon_cache_path.exists():
        canon_cache = json.loads(canon_cache_path.read_text())

    flagged: list[tuple[str, ...]] = []
    out_path = BASE / "diagnostics.tsv"
    t0 = time.time()

    for i, path in enumerate(wavs, 1):
        mora = path.parent.name
        voice = path.stem
        try:
            pre_p, post_p = ensure_carrier(voice)
            canon_pre, canon_post = ensure_canonical(voice, pre_p, post_p, canon_cache)
        except Exception as e:
            print(f"  CARRIER FAIL {voice}: {e}", file=sys.stderr, flush=True)
            continue

        try:
            tile_bytes, sr1 = tile(path)
            splice_bytes, sr2 = splice(path, pre_p, post_p)
        except Exception as e:
            print(f"  PREP FAIL {voice}/{mora}: {e}", file=sys.stderr, flush=True)
            continue

        try:
            tile_alts = stt(tile_bytes, sr1)
            splice_alts = stt(splice_bytes, sr2)
        except Exception as e:
            print(f"  STT FAIL {voice}/{mora}: {e}", file=sys.stderr, flush=True)
            continue

        tile_ok, tile_str = check_tile(tile_alts, mora)
        splice_ok, splice_str = check_splice(splice_alts, mora, canon_pre, canon_post)

        if not (tile_ok and splice_ok):
            which = []
            if not tile_ok:
                which.append("tile")
            if not splice_ok:
                which.append("splice")
            flagged.append(
                (mora, voice, ",".join(which), tile_str, splice_str, str(path.relative_to(BASE)))
            )
            print(f"  ✗ {mora}/{voice} [{','.join(which)}]", flush=True)
            if args.save_debug:
                dd = DEBUG_DIR / mora
                dd.mkdir(parents=True, exist_ok=True)
                (dd / f"{voice}__tile.wav").write_bytes(tile_bytes)
                (dd / f"{voice}__splice.wav").write_bytes(splice_bytes)

        if i % 25 == 0:
            rpm = i / max(time.time() - t0, 0.001) * 60
            print(f"  [{i}/{len(wavs)}] flagged={len(flagged)} ({rpm:.0f}/min)", flush=True)

    canon_cache_path.write_text(json.dumps(canon_cache, ensure_ascii=False, indent=2))
    with out_path.open("w", encoding="utf-8") as f:
        f.write("mora\tvoice\tfailed\ttile_heard\tsplice_heard\tpath\n")
        for row in flagged:
            f.write("\t".join(row) + "\n")
    print(f"\nwrote {out_path} with {len(flagged)} flagged", flush=True)


if __name__ == "__main__":
    main()
