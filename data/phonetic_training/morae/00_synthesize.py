"""Synthesize single morae across all ja-JP Cloud TTS voices.

Output: phonetic_training/morae/audio/<group>/<mora>/<voice>.wav
"""
from __future__ import annotations

import base64
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO_ROOT = BASE.parent.parent
KEY = (REPO_ROOT / ".cloudtts_key").read_text().strip()
LIST_URL = (f"https://texttospeech.googleapis.com/v1/voices"
            f"?languageCode=ja-JP&key={KEY}")
SYNTH_URL = (f"https://texttospeech.googleapis.com/v1/text:synthesize"
             f"?key={KEY}")

GROUPS = {
    "u": ["す", "ず", "つ", "しゅ", "じゅ", "ちゅ"],
    "i": ["し", "じ", "ち"],
    "a": ["さ", "ざ", "しゃ", "じゃ", "ちゃ"],
    "o": ["そ", "ぞ", "しょ", "じょ", "ちょ"],
}

SAFE_RE = re.compile(r"[^0-9A-Za-z぀-ヿ一-鿿_-]+")
def safe(s: str) -> str:
    s = SAFE_RE.sub("_", s).strip("_")
    return s or "x"


def list_voices() -> list[str]:
    with urllib.request.urlopen(LIST_URL, timeout=30) as r:
        return [v["name"] for v in json.load(r).get("voices", [])]


def synth(text: str, voice_name: str) -> bytes:
    body = {
        "input": {"text": text},
        "voice": {"languageCode": "ja-JP", "name": voice_name},
        "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000},
    }
    payload = json.dumps(body).encode()
    delay = 2.0
    for attempt in range(6):
        req = urllib.request.Request(SYNTH_URL, data=payload,
                                     headers={"Content-Type": "application/json"},
                                     method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return base64.b64decode(json.load(resp)["audioContent"])
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 5:
                ra = e.headers.get("Retry-After")
                wait = float(ra) if ra and ra.replace(".", "").isdigit() else delay
                time.sleep(min(wait, 30.0))
                delay = min(delay * 2, 60.0)
                continue
            raise
    raise RuntimeError("exhausted retries")


def main() -> None:
    voice_names = list_voices()
    out_root = BASE / "audio"
    out_root.mkdir(exist_ok=True)
    total_morae = sum(len(v) for v in GROUPS.values())
    total = total_morae * len(voice_names)
    print(f"morae: {total_morae}, voices: {len(voice_names)}, files: {total}")

    done = made = skipped = failed = 0
    t0 = time.time()
    for group_name, morae in GROUPS.items():
        for mora in morae:
            mora_dir = out_root / group_name / safe(mora)
            mora_dir.mkdir(parents=True, exist_ok=True)
            for vname in voice_names:
                done += 1
                short = vname.replace("ja-JP-", "")
                out_path = mora_dir / f"{short}.wav"
                if out_path.exists() and out_path.stat().st_size > 0:
                    skipped += 1
                    continue
                try:
                    out_path.write_bytes(synth(mora, vname))
                    made += 1
                    if made % 25 == 0 or done == total:
                        rpm = made / max(time.time() - t0, 0.001) * 60
                        print(f"  [{done}/{total}] made={made} ({rpm:.1f}/min)",
                              flush=True)
                except urllib.error.HTTPError as e:
                    failed += 1
                    body = e.read().decode("utf-8", errors="replace")[:200]
                    print(f"  FAIL {mora}/{short}: {e.code} {body}",
                          file=sys.stderr, flush=True)
                except Exception as e:
                    failed += 1
                    print(f"  FAIL {mora}/{short}: {e}",
                          file=sys.stderr, flush=True)

    elapsed = time.time() - t0
    print(f"done: total={total} new={made} skipped={skipped} failed={failed} "
          f"in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
