#!/usr/bin/env python3
"""Build data/mate-N.json files from the Lichess puzzle database.

Source: https://database.lichess.org/#puzzles (CC0).

Usage:
    curl -s https://database.lichess.org/lichess_db_puzzle.csv.zst \
      | zstd -dc | awk 'NR==1 || /mateIn/' > mates.csv
    python3 scripts/build_puzzles.py mates.csv

Lichess tags mates as mateIn1..mateIn5, where mateIn5 means "5 or more".
The solution line is exact, so mate depth is derived from its length:
Moves = [opponent setup move, then 2N-1 solution plies].

Puzzle IDs are stable Lichess IDs. Progress in localStorage is keyed by ID,
so re-running this script (adding, removing or reordering puzzles) never
corrupts saved progress.
"""

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

MAX_DEPTH = 10
TARGET_PER_DEPTH = 300
BUCKET_WIDTH = 100  # rating points; used to spread picks across difficulty

# Filters, strictest first. A depth relaxes to the next tier only if the
# stricter one leaves it short of TARGET_PER_DEPTH.
TIERS = [
    dict(max_rd=80, min_pop=85, min_plays=500),
    dict(max_rd=90, min_pop=75, min_plays=200),
    dict(max_rd=110, min_pop=50, min_plays=50),
    dict(max_rd=999, min_pop=0, min_plays=0),
]

OUT_DIR = Path(__file__).resolve().parent.parent / "data"


def mate_depth(moves, themes):
    if len(moves) % 2:
        return None
    n = len(moves) // 2
    if n < 1 or n > MAX_DEPTH:
        return None
    # Guard against mislabelled rows: the theme must agree with the line length.
    if f"mateIn{min(n, 5)}" not in themes:
        return None
    return n


def spread_pick(rows, target):
    """Pick up to `target` rows, round-robin across rating buckets so every
    difficulty band is represented, preferring popular puzzles in each band."""
    buckets = defaultdict(list)
    for r in rows:
        buckets[r["rating"] // BUCKET_WIDTH].append(r)
    for b in buckets.values():
        b.sort(key=lambda r: (-r["pop"], -r["plays"]))
    picked = []
    keys = sorted(buckets)
    i = 0
    while len(picked) < target and any(buckets[k] for k in keys):
        k = keys[i % len(keys)]
        if buckets[k]:
            picked.append(buckets[k].pop(0))
        i += 1
    return picked


def main(csv_path):
    by_depth = defaultdict(list)
    with open(csv_path, newline="") as f:
        for row in csv.DictReader(f):
            moves = row["Moves"].split()
            themes = row["Themes"].split()
            n = mate_depth(moves, themes)
            if n is None:
                continue
            by_depth[n].append(
                dict(
                    id=row["PuzzleId"],
                    fen=row["FEN"],
                    moves=row["Moves"],
                    rating=int(row["Rating"]),
                    rd=int(row["RatingDeviation"]),
                    pop=int(row["Popularity"]),
                    plays=int(row["NbPlays"]),
                )
            )

    OUT_DIR.mkdir(exist_ok=True)
    index = []
    for n in range(1, MAX_DEPTH + 1):
        rows = by_depth.get(n, [])
        pool = []
        for tier in TIERS:
            pool = [
                r
                for r in rows
                if r["rd"] <= tier["max_rd"]
                and r["pop"] >= tier["min_pop"]
                and r["plays"] >= tier["min_plays"]
            ]
            if len(pool) >= TARGET_PER_DEPTH:
                break
        picked = spread_pick(pool, TARGET_PER_DEPTH)
        picked.sort(key=lambda r: (r["rating"], r["id"]))
        puzzles = [[r["id"], r["fen"], r["moves"], r["rating"]] for r in picked]
        (OUT_DIR / f"mate-{n}.json").write_text(
            json.dumps({"depth": n, "puzzles": puzzles}, separators=(",", ":"))
        )
        index.append(
            dict(
                depth=n,
                count=len(puzzles),
                minRating=puzzles[0][3] if puzzles else None,
                maxRating=puzzles[-1][3] if puzzles else None,
            )
        )
        print(f"mate in {n:>2}: {len(rows):>7} available, {len(puzzles):>4} picked")

    (OUT_DIR / "index.json").write_text(json.dumps({"depths": index}, indent=1))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
