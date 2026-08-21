#!/usr/bin/env python3
"""Build lib/fantasy/data/projections.json from nflverse-data.

Downloads regular-season player stats for the last three completed NFL
seasons from https://github.com/nflverse/nflverse-data and shapes them into
the multi-source projection format the analytics engine consumes: each
season acts as one "source", so the engine's robust average becomes a
baseline projection and the spread across seasons feeds the risk score.

Usage: python3 scripts/build-dataset.py [--seasons 2023 2024 2025]
"""

import argparse
import csv
import gzip
import io
import json
import math
import os
import urllib.request

RELEASE = "https://github.com/nflverse/nflverse-data/releases/download/stats_player"
PLAYERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv.gz"
OUT = os.path.join(os.path.dirname(__file__), "..", "lib", "fantasy", "data", "projections.json")

OFFENSE_POS = {"QB", "RB", "WR", "TE"}

# nflverse column -> engine stat category
STAT_MAP = {
    "attempts": "passAtt",
    "completions": "passComp",
    "passing_yards": "passYds",
    "passing_tds": "passTds",
    "passing_interceptions": "passInt",
    "carries": "rushAtt",
    "rushing_yards": "rushYds",
    "rushing_tds": "rushTds",
    "receptions": "rec",
    "receiving_yards": "recYds",
    "receiving_tds": "recTds",
    "special_teams_tds": "returnTds",
    "fumbles_lost_total": "fumbles",
    # kickers
    "pat_made": "xp",
    "fg_made": "fg",
    "fg_att": "fgAtt",
    "fg_made_0_19": "fg0019",
    "fg_made_20_29": "fg2029",
    "fg_made_30_39": "fg3039",
    "fg_made_40_49": "fg4049",
}

# Default scoring, mirroring lib/fantasy/scoring.ts -- used only to
# synthesize auction costs (nflverse has no market data).
SCORING = {
    "passYds": 1 / 25, "passTds": 4, "passInt": -3,
    "rushYds": 1 / 10, "rushTds": 6,
    "rec": 0, "recYds": 1 / 8, "recTds": 6,
    "returnTds": 6, "twoPts": 2, "fumbles": -3,
}
# ceil(starters * teams * multiplier) for the default 10-team league
REPLACEMENT_RANK = {"QB": 17, "RB": 28, "WR": 28, "TE": 13}
NUM_TEAMS, DEFAULT_CAP, ROSTER_SIZE = 10, 200, 20


def num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else 0.0
    except (TypeError, ValueError):
        return 0.0


def fetch_csv_gz(url):
    print(f"fetching {url}")
    with urllib.request.urlopen(url) as resp:
        raw = gzip.decompress(resp.read())
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))


def fetch_season(season):
    return fetch_csv_gz(f"{RELEASE}/stats_player_reg_{season}.csv.gz")


def fetch_birth_dates():
    return {
        r["gsis_id"]: r["birth_date"]
        for r in fetch_csv_gz(PLAYERS_URL)
        if r.get("gsis_id") and r.get("birth_date")
    }


def stat_line(row, pos):
    stats = {}
    for col, key in STAT_MAP.items():
        v = num(row.get(col))
        if v:
            stats[key] = round(v, 2)
    fg50 = num(row.get("fg_made_50_59")) + num(row.get("fg_made_60_"))
    if fg50:
        stats["fg50"] = fg50
    two = (num(row.get("passing_2pt_conversions"))
           + num(row.get("rushing_2pt_conversions"))
           + num(row.get("receiving_2pt_conversions")))
    if two:
        stats["twoPts"] = two
    if pos == "K":
        # Kicker scoring in the engine uses xp + fg distance splits only.
        for key in ("passAtt", "passComp", "rushAtt"):
            stats.pop(key, None)
    return stats


def points(stats, pos):
    if pos == "K":
        return (stats.get("xp", 0) + 3 * stats.get("fg0019", 0) + 3 * stats.get("fg2029", 0)
                + 3 * stats.get("fg3039", 0) + 4 * stats.get("fg4049", 0) + 5 * stats.get("fg50", 0))
    return sum(stats.get(k, 0) * mult for k, mult in SCORING.items())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", type=int, nargs="+", default=[2023, 2024, 2025])
    args = ap.parse_args()
    seasons = sorted(args.seasons)
    latest = seasons[-1]

    players = {}
    for season in seasons:
        for row in fetch_season(season):
            pos = row.get("position_group") or ""
            if pos == "SPEC" and row.get("position") == "K":
                pos = "K"
            if pos not in OFFENSE_POS and pos != "K":
                continue
            if num(row.get("games")) < 1:
                continue
            pid = row["player_id"]
            p = players.setdefault(pid, {
                "id": pid,
                "player": row.get("player_display_name") or row.get("player_name"),
                "pos": pos,
                "team": row.get("recent_team") or "FA",
                "avgCost": 1,
                "sources": {},
            })
            stats = stat_line(row, pos)
            if stats:
                p["sources"][str(season)] = stats
                # Latest season wins for team/position (players move and switch roles).
                p["team"] = row.get("recent_team") or p["team"]
                p["pos"] = pos

    # Keep players who took the field in the latest completed season.
    out = [p for p in players.values() if str(latest) in p["sources"]]

    # Age as of September 1 of the draft season (the what-if lab's age curves).
    births = fetch_birth_dates()
    import datetime
    ref = datetime.date(latest + 1, 9, 1)
    for p in out:
        bd = births.get(p["id"])
        if bd:
            try:
                b = datetime.date.fromisoformat(bd)
                p["age"] = ref.year - b.year - ((ref.month, ref.day) < (b.month, b.day))
            except ValueError:
                pass

    # Synthetic auction costs: distribute the league's discretionary dollars
    # in proportion to value over replacement of the robust multi-season
    # average (the same Hodges-Lehmann baseline the engine ranks by, so a
    # star with one injury-shortened year isn't priced at $1).
    def pseudo_median(xs):
        walsh = sorted((a + b) / 2 for i, a in enumerate(xs) for b in xs[i:])
        n = len(walsh)
        mid = n // 2
        return walsh[mid] if n % 2 else (walsh[mid - 1] + walsh[mid]) / 2

    for p in out:
        season_pts = [points(st, p["pos"]) for st in p["sources"].values()]
        p["_pts"] = pseudo_median(season_pts)
    surplus = {}
    for pos, rep_rank in REPLACEMENT_RANK.items():
        group = sorted((p for p in out if p["pos"] == pos), key=lambda p: -p["_pts"])
        if not group:
            continue
        rep_pts = group[min(rep_rank, len(group)) - 1]["_pts"]
        for p in group:
            surplus[p["id"]] = max(0.0, p["_pts"] - rep_pts)
    pool = sum(surplus.values())
    discretionary = NUM_TEAMS * (DEFAULT_CAP - ROSTER_SIZE)
    for p in out:
        share = surplus.get(p["id"], 0.0) / pool if pool else 0.0
        p["avgCost"] = max(1, round(share * discretionary))
        del p["_pts"]

    out.sort(key=lambda p: -p["avgCost"])
    data = {
        "season": latest + 1,
        "sources": {str(s): f"{s} season" for s in seasons},
        "players": out,
    }
    with open(os.path.abspath(OUT), "w") as f:
        json.dump(data, f, separators=(",", ":"))
    from collections import Counter
    print(f"wrote {os.path.abspath(OUT)}: {len(out)} players, "
          f"{os.path.getsize(os.path.abspath(OUT))} bytes, {Counter(p['pos'] for p in out)}")


if __name__ == "__main__":
    main()
