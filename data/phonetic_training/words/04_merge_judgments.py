"""Merge per-batch judgment TSVs into hard_pronunciation/word_judgments.tsv.

Verifies every input row got judged exactly once.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
JUDGMENTS_DIR = BASE / "data" / "judgments"
BATCH_DIR = JUDGMENTS_DIR / "batches"


def load_tsv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def main() -> None:
    inputs = sorted(BATCH_DIR.glob("batch_??.tsv"))
    judged = sorted(BATCH_DIR.glob("batch_??_judged.tsv"))
    if len(inputs) != len(judged):
        sys.exit(f"input batches: {len(inputs)} but judged: {len(judged)}")

    expected: set[tuple[str, str]] = set()
    for p in inputs:
        for row in load_tsv(p):
            expected.add((row["expression"], row["reading"]))

    seen: dict[tuple[str, str], dict] = {}
    duplicates: list[tuple[str, str]] = []
    for p in judged:
        for row in load_tsv(p):
            key = (row["expression"], row["reading"])
            if key in seen:
                duplicates.append(key)
            seen[key] = row

    missing = expected - set(seen.keys())
    extra = set(seen.keys()) - expected

    print(f"expected: {len(expected)}, judged: {len(seen)}")
    print(f"missing:  {len(missing)}")
    if missing:
        for k in sorted(missing):
            print(f"  MISS  {k}")
    print(f"extra:    {len(extra)}")
    if extra:
        for k in sorted(extra):
            print(f"  EXTRA {k}")
    print(f"duplicates: {len(duplicates)}")

    out = JUDGMENTS_DIR / "word_judgments.tsv"
    yes_n = no_n = 0
    with out.open("w", encoding="utf-8") as f:
        f.write("expression\treading\tkeep\texample_sentence\tnote\n")
        for key in sorted(expected):
            r = seen.get(key)
            if r is None:
                f.write(f"{key[0]}\t{key[1]}\t\t\tMISSING_JUDGMENT\n")
                continue
            keep = r.get("keep", "").strip()
            if keep == "yes":
                yes_n += 1
            elif keep == "no":
                no_n += 1
            f.write(
                f"{r['expression']}\t{r['reading']}\t{keep}\t"
                f"{r.get('example_sentence', '')}\t{r.get('note', '')}\n"
            )
    print(f"wrote {out}: yes={yes_n} no={no_n}")


if __name__ == "__main__":
    main()
