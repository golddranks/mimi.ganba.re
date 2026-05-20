"""Collect every unique (expression, reading) referenced from
data/pairs/hard_minimal_pairs_*.tsv, look up meaning/level/tags from
jlpt_n{1..5}/vocab.tsv (at repo root), and emit
data/judgments/words_to_judge.tsv.
"""

from __future__ import annotations

import csv
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
PAIRS_DIR = DATA / "pairs"
JUDGMENTS_DIR = DATA / "judgments"
REPO_ROOT = BASE.parent.parent


def load_vocab_index() -> dict[tuple[str, str], dict]:
    idx: dict[tuple[str, str], dict] = {}
    for level in (1, 2, 3, 4, 5):
        path = REPO_ROOT / "vocab" / f"jlpt_n{level}.tsv"
        if not path.exists():
            continue
        with path.open(encoding="utf-8") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                key = (row["expression"].strip(), row["reading"].strip())
                if not key[0] or not key[1]:
                    continue
                if key in idx:
                    continue
                idx[key] = {
                    "level": level,
                    "meaning": row.get("meaning", "").strip(),
                    "tags": row.get("tags", "").strip(),
                }
    return idx


def main() -> None:
    vocab = load_vocab_index()

    pairs_words: set[tuple[str, str]] = set()
    for path in sorted(PAIRS_DIR.glob("hard_minimal_pairs_*.tsv")):
        with path.open(encoding="utf-8") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                for prefix in ("seed", "partner"):
                    expr = row[f"{prefix}_expression"].strip()
                    reading = row[f"{prefix}_reading"].strip()
                    if expr and reading:
                        pairs_words.add((expr, reading))

    JUDGMENTS_DIR.mkdir(parents=True, exist_ok=True)
    out = JUDGMENTS_DIR / "words_to_judge.tsv"
    missing = 0
    with out.open("w", encoding="utf-8") as f:
        f.write("expression\treading\tlevel\tmeaning\ttags\n")
        for expr, reading in sorted(pairs_words):
            v = vocab.get((expr, reading))
            if v is None:
                missing += 1
                f.write(f"{expr}\t{reading}\t\t\t\n")
                continue
            f.write(f"{expr}\t{reading}\t{v['level']}\t{v['meaning']}\t{v['tags']}\n")
    print(f"wrote {out} ({len(pairs_words)} words, {missing} missing vocab entries)")


if __name__ == "__main__":
    main()
