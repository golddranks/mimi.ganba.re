"""Find JLPT N3-N5 vocabulary with hard-to-pronounce sounds and minimal-pair partners.

Hard sounds (mora-level): さしすせそ・ちつ・ざじずぜぞ・しゃしゅしょ・じゃじゅじょ・ちゃちゅちょ
(katakana equivalents are normalized first).

Hard minimal pair: differs in exactly one mora, AND the two differing morae are both
drawn from the same vowel-grouped hard cluster (so the contrast is itself a
pronunciation-difficulty axis, e.g. し↔じ, さ↔ちゃ, す↔つ).

Outputs:
  hard_words.tsv          — every N5/N4/N3 word containing a hard mora
  hard_minimal_pairs.tsv  — exhaustive hard minimal pairs. Seed must be N3 or below;
                            partner may be any level (N1-N5). Pairs where both sides
                            are N2+ are excluded.
"""

from __future__ import annotations

import csv
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
REPO_ROOT = BASE.parent.parent

HARD_MORAE_BY_VOWEL = {
    "a": {"さ", "ざ", "しゃ", "じゃ", "ちゃ"},
    "i": {"し", "じ", "ち"},
    "u": {"す", "ず", "つ", "しゅ", "じゅ", "ちゅ"},
    "e": {"せ", "ぜ"},
    "o": {"そ", "ぞ", "しょ", "じょ", "ちょ"},
}

HARD_MORAE: set[str] = set().union(*HARD_MORAE_BY_VOWEL.values())

MORA_TO_VOWEL: dict[str, str] = {
    m: v for v, ms in HARD_MORAE_BY_VOWEL.items() for m in ms
}

SMALL_KANA = set("ゃゅょぁぃぅぇぉ")


def kata_to_hira(s: str) -> str:
    out = []
    for ch in s:
        c = ord(ch)
        if 0x30A1 <= c <= 0x30F6:
            out.append(chr(c - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def to_morae(reading: str) -> list[str]:
    """Tokenize hiragana into morae. Small ゃゅょぁぃぅぇぉ fold onto previous mora.
    っ and ー remain as their own mora."""
    s = kata_to_hira(reading)
    morae: list[str] = []
    for ch in s:
        if ch in SMALL_KANA and morae:
            morae[-1] += ch
        else:
            morae.append(ch)
    return morae


def is_hard_mora(m: str) -> bool:
    return m in HARD_MORAE


def load_level(level: int) -> list[dict]:
    path = REPO_ROOT / "vocab" / f"jlpt_n{level}.tsv"
    with path.open(encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        rows = []
        for r in reader:
            reading = r["reading"].strip()
            if not reading:
                continue
            r["level"] = level
            r["morae"] = to_morae(reading)
            rows.append(r)
    return rows


def has_hard(morae: list[str]) -> bool:
    return any(is_hard_mora(m) for m in morae)


def write_hard_words(rows: list[dict], out: Path) -> int:
    n = 0
    with out.open("w", encoding="utf-8") as f:
        f.write("level\texpression\treading\thard_morae\tmeaning\ttags\n")
        for r in rows:
            if r["level"] not in (3, 4, 5):
                continue
            hard = [m for m in r["morae"] if is_hard_mora(m)]
            if not hard:
                continue
            f.write(
                f"{r['level']}\t{r['expression']}\t{r['reading']}\t"
                f"{','.join(hard)}\t{r['meaning']}\t{r.get('tags', '')}\n"
            )
            n += 1
    return n


def write_minimal_pairs(
    rows: list[dict],
    out: Path,
    seed_levels: set[int],
    partner_levels: set[int],
    exclude: set[tuple[str, str, str, str]] | None = None,
) -> set[tuple[str, str, str, str]]:
    """Write hard minimal pairs where seed level ∈ seed_levels and partner level ∈
    partner_levels. Pairs are unordered-deduped. Pairs in `exclude` are skipped
    (used to make output non-cumulative across cuts). Returns the set of pair keys
    written + excluded so callers can chain."""
    by_len: dict[int, list[dict]] = {}
    for r in rows:
        by_len.setdefault(len(r["morae"]), []).append(r)

    for bucket in by_len.values():
        bucket.sort(key=lambda r: (r["level"], r["expression"]))

    seen_pairs: set[tuple[str, str, str, str]] = set()
    excluded = exclude or set()

    with out.open("w", encoding="utf-8") as f:
        f.write(
            "seed_level\tseed_expression\tseed_reading\t"
            "partner_level\tpartner_expression\tpartner_reading\t"
            "position\tseed_mora\tpartner_mora\n"
        )

        for length, bucket in by_len.items():
            if length < 1:
                continue
            for a in bucket:
                if a["level"] not in seed_levels:
                    continue
                a_morae = a["morae"]
                for b in bucket:
                    if b is a:
                        continue
                    if b["level"] not in partner_levels:
                        continue
                    b_morae = b["morae"]
                    diff_idx = -1
                    diffs = 0
                    for k in range(length):
                        if a_morae[k] != b_morae[k]:
                            diffs += 1
                            if diffs > 1:
                                break
                            diff_idx = k
                    if diffs != 1:
                        continue
                    a_m = a_morae[diff_idx]
                    b_m = b_morae[diff_idx]
                    va = MORA_TO_VOWEL.get(a_m)
                    vb = MORA_TO_VOWEL.get(b_m)
                    if va is None or vb is None or va != vb:
                        continue
                    key = tuple(sorted([
                        (a["expression"], a["reading"]),
                        (b["expression"], b["reading"]),
                    ]))
                    flat = (key[0][0], key[0][1], key[1][0], key[1][1])
                    if flat in seen_pairs:
                        continue
                    seen_pairs.add(flat)
                    if flat in excluded:
                        continue

                    f.write(
                        f"{a['level']}\t{a['expression']}\t{a['reading']}\t"
                        f"{b['level']}\t{b['expression']}\t{b['reading']}\t"
                        f"{diff_idx}\t{a_m}\t{b_m}\n"
                    )
    return seen_pairs


def main() -> None:
    all_rows: list[dict] = []
    for lvl in (1, 2, 3, 4, 5):
        all_rows.extend(load_level(lvl))

    pairs_dir = DATA / "pairs"
    pairs_dir.mkdir(parents=True, exist_ok=True)

    n_hard = write_hard_words(all_rows, DATA / "hard_words.tsv")
    print(f"hard words (N5/N4/N3): {n_hard}")

    # "Upper bound" cuts: the level named is the hardest level included on each side.
    # Output is non-cumulative — each file lists only pairs not present in any
    # easier cut, so concatenating all three reproduces the full set.
    cuts = [
        ("hard_minimal_pairs_n3_n3.tsv", {3, 4, 5}, {3, 4, 5}),
        ("hard_minimal_pairs_n3_n2.tsv", {3, 4, 5}, {2, 3, 4, 5}),
        ("hard_minimal_pairs_n2_n2.tsv", {2, 3, 4, 5}, {2, 3, 4, 5}),
    ]
    accumulated: set[tuple[str, str, str, str]] = set()
    for name, seeds, partners in cuts:
        path = pairs_dir / name
        accumulated = write_minimal_pairs(all_rows, path, seeds, partners, exclude=accumulated)
        new_rows = sum(1 for _ in path.open(encoding="utf-8")) - 1
        print(f"{name}: {new_rows} new (cumulative {len(accumulated)})")


if __name__ == "__main__":
    main()
