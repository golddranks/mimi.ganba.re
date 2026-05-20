"""Split words_to_judge.tsv into N batch files for parallel subagent dispatch."""
import csv
from pathlib import Path

BASE = Path(__file__).resolve().parent
JUDGMENTS_DIR = BASE / "data" / "judgments"
BATCH_DIR = JUDGMENTS_DIR / "batches"
BATCH_DIR.mkdir(parents=True, exist_ok=True)

N_BATCHES = 8

with (JUDGMENTS_DIR / "words_to_judge.tsv").open(encoding="utf-8") as f:
    rows = list(csv.DictReader(f, delimiter="\t"))

batches: list[list[dict]] = [[] for _ in range(N_BATCHES)]
for i, r in enumerate(rows):
    batches[i % N_BATCHES].append(r)

header = "expression\treading\tlevel\tmeaning\ttags\n"
for i, b in enumerate(batches):
    p = BATCH_DIR / f"batch_{i:02d}.tsv"
    with p.open("w", encoding="utf-8") as f:
        f.write(header)
        for r in b:
            f.write(f"{r['expression']}\t{r['reading']}\t{r['level']}\t{r['meaning']}\t{r['tags']}\n")
    print(f"  {p.name}: {len(b)} words")
