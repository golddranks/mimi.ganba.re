# Evaluation pipeline v2 — local multi-judge vetting (plan, 2026-06-10)

Goal: grow the per-mora inventory of vetted recordings enough to flip
`GRIND_ENABLED` (src/main/grind.js). Grind drills one confusable pair
repeatedly, so the thin morae are the gate — current `good/` counts are
wildly uneven:

    しょ 3 · ちゃ 13 · す 13 · ち 14 · しゅ 18 … さ 32   (416 total)

## Why v1 isn't enough

`01_diagnose.py` rests on one cloud STT service, and orthographic STT is
structurally bad at isolated morae: its language model expects words, so it
"corrects" a clean しょ into something else and the file gets flagged. The
flag distribution mirrors the inventory holes almost exactly (113 genuinely
flagged: しょ 25 · ちゃ 16 · じょ 14 · しゅ 12 · す 11 …) — i.e. the
weakest morae are weak largely *because* the validator mis-hears them, and
many flags are likely false. The fix is more judges, locally runnable, and
framed around the actual task instead of open transcription.

## Architecture: three independent local judges

The task is never "transcribe this"; it is "which of the 19 known morae is
this, and does it survive against the same-vowel siblings the app actually
shows as distractors?" — a closed-set discrimination problem.

1. **Promptable audio-LLM** — Qwen3-Omni-30B-A3B-Instruct, Q4_K_M GGUF
   (18.6 GB; official ggml-org conversion; audio input merged into
   llama.cpp 2026-04, via `llama-server` / `llama-mtmd-cli` + mmproj).
   Closed-set prompt at temperature 0, e.g.
   「この音声は しゃ・しゅ・しょ のどれに聞こえますか。一つだけ答えて」.
   Also promptable for what STT can't ask: clipping/noise/artifacts,
   devoiced vowels, naturalness. Caveat: llama.cpp marks audio input
   "highly experimental" — hence the calibration step below.
   Fallback if it misbehaves: Qwen2.5-Omni-7B (~6 GB, longer-supported).
   Re-check later: Qwen3.5-Omni (2026-03; Plus/Flash/Light) — newest Omni
   line, llama.cpp support not landed at time of writing. (Qwen 3.6 is the
   newest *text* line; no audio.)

2. **Closed-set CTC scorer** — the hallucination-free core signal. A CTC
   phoneme model (wav2vec2-XLSR phoneme variant, Meta MMS, or ReazonSpeech
   CTC — Japanese-specialised; all <2 GB) scores each candidate mora's
   phone string against the audio directly: compare P(ɕo) vs P(ɕɯ) vs
   P(ɕa…) over the same-vowel sibling set, no decoding, no LM. Produces a
   *margin* (how decisively the target wins), which doubles as a quality
   ranking — grind wants the cleanest exemplars of a pair, and this orders
   them.

3. **Transcription cross-check** — keep the v1 tile/splice trick (it is a
   good idea independent of engine) on a Japanese-capable local model:
   kotoba-whisper (JP-distilled Whisper) or Qwen3-ASR (landed in llama.cpp
   alongside Omni; Whisper-like encoder), with kana normalisation.

All three fit resident simultaneously in ~25 GB (machine budget: 64 GB
unified, 49 GB Metal working set), so a batch pass is one invocation.

## Aggregation

Per WAV: unanimous pass → `good/`; unanimous fail → reject; any
disagreement → `needs_review/` with all three verdicts + the CTC margins in
the report. Human listening shrinks to genuine edge cases. The same harness
re-runs unchanged whenever new voices are synthesised.

## Calibration before trusting anything

Run all judges over (a) the 113 currently-flagged files and (b) a random
~50 sample of current `good/` as a sanity reference. Output one comparison
table: per-file verdict per judge, CTC margin, Google's v1 verdict. No file
moves until the judges' false-flag behaviour on isolated morae is
understood. The disagreement set from this run is the first (small)
listening queue.

## Two inventory levers, in order

1. **Rescue the 113 flagged** — no synthesis, no API key; attacks exactly
   the holes (rescuing half of しょ's 25 takes it 3 → ~15). The calibration
   run above largely does this for free.
2. **Re-synthesise with new voices** — `00_synthesize.py` enumerates all
   ja-JP Cloud TTS voices live, so re-running picks up voices added since
   (Chirp3-HD keeps growing). Blocked on restoring `.cloudtts_key` at the
   repo root. New files then flow through the same v2 judges.

## After classification (unchanged from v1)

`scripts/voicemap.py` → build → the documented idx-migration flow
(worker/README, migrate-voices.sql; legacy 'p' rows stay voice=NULL) →
deploy. Note idx values shift when the voice set changes; the app stores
voice names at insert time, but (mora, idx) consumers — native pair
ranking, voice-attempts — key on the *current* map by design. Once new
files land, pickVoice's min-coverage bias and the native-tester pair
ranking (0/0-pairs-first, per-tester dedup) will direct play and native
vetting at exactly the new material.

## Open questions

- Which CTC checkpoint discriminates yōon best (XLSR-phoneme vs MMS vs
  ReazonSpeech) — decide empirically in calibration.
- Whether judge 1 should also vote on naturalness/artifacts as a separate
  axis (probably yes, as a soft flag, not a gate).
- Threshold for "unanimous" when the CTC margin is tiny — margin floor TBD
  from the calibration distribution.
