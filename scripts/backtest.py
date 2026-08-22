#!/usr/bin/env python3
"""Ablation backtest for the projection model.

For each held-out target season, every variant predicts all players using only
seasons before the target, then is scored against what actually happened.
Recovery multipliers are re-learned per target from pairs completed before it,
so nothing leaks from the future.

Metrics per position (and overall), averaged across targets:
  spearman  rank correlation between projected and actual season points
  mae       mean absolute error in season points
  maeTop    the same, restricted to the top 36 (QB/TE: 24) by *projection* --
            the players a draft actually turns on

Writes lib/fantasy/data/backtest.json and prints the report.

Usage: python3 scripts/backtest.py [--targets 2022 2023 2024 2025]
"""

import argparse
import json
import os
from collections import defaultdict

from model import History, learn_recovery, historical_ecr, market_points, OFFENSE_POS

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib", "fantasy", "data", "backtest.json")

VARIANTS = {
    0: "Robust baseline (last-3 season totals)",
    1: "+ usage & recency (per-game rate x expected games)",
    2: "+ age curves",
    3: "+ injury recovery",
    4: "+ market consensus (50/50 blend with FantasyPros ECR)",
}
TOP_N = {"QB": 24, "RB": 36, "WR": 36, "TE": 24}


def spearman(xs, ys):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r
    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = sum((a - mx) ** 2 for a in rx)
    vy = sum((b - my) ** 2 for b in ry)
    return cov / (vx * vy) ** 0.5 if vx and vy else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--targets", type=int, nargs="+", default=[2022, 2023, 2024, 2025])
    args = ap.parse_args()
    targets = sorted(args.targets)

    hist = History(min(targets) - 4, max(targets))

    # accumulate per (variant, pos) across targets
    acc = defaultdict(lambda: {"spearman": [], "mae": [], "maeTop": [], "n": 0})

    for target in targets:
        recovery, _ = learn_recovery(hist, target - 1)
        ecr = historical_ecr(target)
        market = market_points(hist, target, recovery, ecr) if ecr else {}
        # eligible: had evidence AND actually played in the target season
        actual = {pid: rec for (pid, s), rec in hist.ps.items() if s == target}
        for variant in VARIANTS:
            if variant == 4 and not market:
                continue
            rows = defaultdict(list)  # pos -> (proj, actual_pts)
            for pid, rec in actual.items():
                proj = hist.project(pid, target, min(variant, 3), recovery)
                if proj is None:
                    continue
                if variant == 4 and pid in market:
                    proj = 0.5 * proj + 0.5 * market[pid]
                rows[rec["pos"]].append((proj, rec["pts"]))
            for pos, pairs in rows.items():
                if len(pairs) < 10:
                    continue
                xs = [p for p, _ in pairs]
                ys = [a for _, a in pairs]
                key = (variant, pos)
                acc[key]["spearman"].append(spearman(xs, ys))
                acc[key]["mae"].append(sum(abs(p - a) for p, a in pairs) / len(pairs))
                top = sorted(pairs, key=lambda t: -t[0])[: TOP_N[pos]]
                acc[key]["maeTop"].append(sum(abs(p - a) for p, a in top) / len(top))
                acc[key]["n"] += len(pairs)

    report = {"targets": targets, "variants": VARIANTS, "byVariant": {}}
    for variant, label in VARIANTS.items():
        per_pos = {}
        for pos in sorted(OFFENSE_POS):
            a = acc.get((variant, pos))
            if not a or not a["spearman"]:
                continue
            per_pos[pos] = {
                "spearman": round(sum(a["spearman"]) / len(a["spearman"]), 4),
                "mae": round(sum(a["mae"]) / len(a["mae"]), 2),
                "maeTop": round(sum(a["maeTop"]) / len(a["maeTop"]), 2),
                "n": a["n"],
            }
        overall = {
            m: round(sum(per_pos[p][m] for p in per_pos) / len(per_pos), 4 if m == "spearman" else 2)
            for m in ("spearman", "mae", "maeTop")
        }
        report["byVariant"][str(variant)] = {"label": label, "positions": per_pos, "overall": overall}

    with open(os.path.abspath(OUT), "w") as f:
        json.dump(report, f, indent=1)

    print(f"\nBacktest over targets {targets} (higher spearman / lower MAE is better)\n")
    print(f"{'variant':52} {'spearman':>9} {'MAE':>7} {'MAE top':>8}")
    for variant, label in VARIANTS.items():
        o = report["byVariant"][str(variant)]["overall"]
        print(f"V{variant}  {label:48} {o['spearman']:>9} {o['mae']:>7} {o['maeTop']:>8}")
    print(f"\nwrote {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
