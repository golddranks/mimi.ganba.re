"""Filter hard_minimal_pairs_*.tsv files using word_judgments.tsv.

Pairs are kept only when BOTH seed and partner have keep=yes. Writes one
filtered file per cut: data/pairs/<original_stem>_filtered.tsv.
"""
from __future__ import annotations

import csv
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
PAIRS_DIR = DATA / "pairs"
JUDGMENTS_DIR = DATA / "judgments"


def main() -> None:
    keep: dict[tuple[str, str], dict] = {}
    with (JUDGMENTS_DIR / "word_judgments.tsv").open(encoding="utf-8") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            keep[(row["expression"], row["reading"])] = row

    for path in sorted(PAIRS_DIR.glob("hard_minimal_pairs_*.tsv")):
        if path.stem.endswith("_filtered"):
            continue
        out = PAIRS_DIR / f"{path.stem}_filtered.tsv"
        kept = dropped = 0
        with path.open(encoding="utf-8") as fin, out.open("w", encoding="utf-8") as fout:
            reader = csv.DictReader(fin, delimiter="\t")
            assert reader.fieldnames is not None
            extra = ["seed_example", "partner_example"]
            fout.write("\t".join(list(reader.fieldnames) + extra) + "\n")
            for row in reader:
                seed = keep.get((row["seed_expression"], row["seed_reading"]))
                partner = keep.get((row["partner_expression"], row["partner_reading"]))
                if (not seed or not partner
                        or seed.get("keep") != "yes"
                        or partner.get("keep") != "yes"):
                    dropped += 1
                    continue
                kept += 1
                values = [row[c] for c in reader.fieldnames] + [
                    seed.get("example_sentence", ""),
                    partner.get("example_sentence", ""),
                ]
                fout.write("\t".join(values) + "\n")
        total = kept + dropped
        pct = 100 * kept / total if total else 0
        print(f"{path.name} -> {out.name}: kept {kept}/{total} ({pct:.0f}%)")


if __name__ == "__main__":
    main()
