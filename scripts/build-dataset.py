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
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import History, learn_recovery, fantasy_points, latest_ecr, market_points, norm_name

try:
    from valuation import fit_valuation
except ImportError:  # numpy missing: skip the edge layer rather than fail the build
    fit_valuation = None

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


def fetch_player_ids():
    """gsis_id -> {birth_date, espn_id} from the nflverse players file."""
    out = {}
    for r in fetch_csv_gz(PLAYERS_URL):
        if r.get("gsis_id"):
            out[r["gsis_id"]] = {"birth_date": r.get("birth_date"), "espn_id": r.get("espn_id")}
    return out


def fetch_espn_adp(season):
    """espn_id -> real ESPN average draft position for the coming season.

    Public endpoint, no cookies. Unreachable from some build environments
    (sandboxes); the caller treats an empty result as "no ADP this build"
    and the app falls back to the expert consensus rank. The scheduled
    GitHub Action runs where ESPN is reachable, so the committed dataset
    normally carries real ADP.
    """
    url = (f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/"
           f"seasons/{season}/players?scoringPeriodId=0&view=kona_player_info")
    fltr = {"players": {"limit": 1000, "sortPercOwned": {"sortAsc": False, "sortPriority": 1}}}
    req = urllib.request.Request(url, headers={
        "x-fantasy-filter": json.dumps(fltr),
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            rows = json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001 -- any network/parse failure just skips ADP
        print(f"WARNING: ESPN ADP unavailable ({e}); shipping expert consensus only")
        return {}
    out = {}
    for r in rows if isinstance(rows, list) else rows.get("players", []):
        p = r.get("player") or r
        adp = ((p.get("ownership") or {}).get("averageDraftPosition")
               if isinstance(p, dict) else None)
        pid = p.get("id") if isinstance(p, dict) else None
        if pid and adp and 1 <= adp <= 500:
            out[int(pid)] = float(adp)
    print(f"ESPN ADP: {len(out)} players")
    return out


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

    # Ages (the what-if lab's curves) and ESPN player ids (live draft sync).
    ids = fetch_player_ids()
    import datetime
    ref = datetime.date(latest + 1, 9, 1)
    for p in out:
        rec = ids.get(p["id"]) or {}
        bd = rec.get("birth_date")
        if bd:
            try:
                b = datetime.date.fromisoformat(bd)
                p["age"] = ref.year - b.year - ((ref.month, ref.day) < (b.month, b.day))
            except ValueError:
                pass
        if rec.get("espn_id"):
            try:
                p["espnId"] = int(float(rec["espn_id"]))
            except ValueError:
                pass

    # Real ESPN ADP for the coming draft season: how drafters actually
    # behave, which is what the Draft Room's survival math should model.
    # (The app also refreshes this live through /api/espn-adp.)
    espn_adp = fetch_espn_adp(latest + 1)
    n_adp = 0
    for p in out:
        a = espn_adp.get(p.get("espnId"))
        if a:
            p["adp"] = round(a, 1)
            n_adp += 1
    if espn_adp:
        print(f"ADP matched to {n_adp} players")

    # Predictive model layer: usage/recency + age curves + empirical injury
    # recovery (see scripts/model.py; validated in scripts/backtest.py).
    target = latest + 1
    hist = History(latest - 6, latest)
    recovery, _ = learn_recovery(hist, latest)
    ecr = latest_ecr()
    market = market_points(hist, target, recovery, ecr)
    for p in out:
        if p["pos"] == "K":
            continue
        comp = hist.components(p["id"], target, recovery)
        if comp:
            p["model"] = {
                "proj": round(comp["proj"], 1),
                "projPg": round(comp["projPg"], 2),
                "expGames": round(comp["expGames"], 1),
                "ageMult": round(comp["ageMult"], 3),
                "injMult": round(comp["injMult"], 3),
            }
            if comp["injPart"] and comp["injMult"] != 1.0:
                p["model"]["injPart"] = comp["injPart"]
            # Market consensus: FantasyPros redraft-overall ECR (via
            # DynastyProcess, scraped daily). The shipped projection is the
            # backtested 50/50 blend; ECR sd feeds the risk score.
            mkt = ecr.get((norm_name(p["player"]), p["pos"]))
            if mkt and p["id"] in market:
                blend = 0.5 * comp["proj"] + 0.5 * market[p["id"]]
                p["model"]["blend"] = round(blend, 1)
                p["model"]["ecr"] = mkt["ecr"]
                p["model"]["ecrSd"] = mkt["sd"]

    # Relative-value layer: usage/scheme regression (scripts/valuation.py).
    # Ships each player's target/carry/air shares, team scheme context, the
    # regression-predicted season, and EDGE = predicted minus market-implied
    # points (positive = the market undervalues the usage profile).
    if fit_valuation is not None:
        val_hist = History(2016, latest)
        val_report, val_predict, val_latest = fit_valuation(val_hist, latest)
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib", "fantasy", "data", "valuation.json"), "w") as vf:
            json.dump(val_report, vf, indent=1)
        for p in out:
            f = val_latest.get(p["id"])
            if f:
                p["usage"] = {
                    "tgtSh": round(f["tgtShare"], 4),
                    "carSh": round(f["carryShare"], 4),
                    "airSh": round(f["airShare"], 4),
                    "passRate": round(f["teamPassRate"], 3),
                    "concTgt": round(f["teamConcTgt"], 3),
                    "tdOpp": round(f["tdPerOpp"], 4),
                }
            pred_ppg = val_predict(p["id"])
            if pred_ppg is not None and p.get("model"):
                reg_pts = pred_ppg * p["model"]["expGames"]
                p["model"]["regProj"] = round(reg_pts, 1)
                # Edge ships only where the regression beats the naive baseline
                # out-of-sample (RB/WR/TE). For QBs it does not, and
                # injury-shortened prior seasons make its QB calls misleading.
                if p["id"] in market and p["pos"] in ("RB", "WR", "TE"):
                    p["model"]["edge"] = round(reg_pts - market[p["id"]], 1)

    # Observed weekly scoring volatility from the last two seasons of
    # per-week stats (the what-if lab's simulation width).
    from model import weekly_stats
    weekly_pts = {}
    for season in seasons[-2:]:
        for row in weekly_stats(season):
            pid = row.get("player_id")
            if pid:
                weekly_pts.setdefault(pid, []).append(fantasy_points(row))
    for p in out:
        pts = weekly_pts.get(p["id"], [])
        if len(pts) >= 8:
            m = sum(pts) / len(pts)
            sd = (sum((x - m) ** 2 for x in pts) / (len(pts) - 1)) ** 0.5
            p["wsd"] = round(sd, 2)

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
        if p.get("model"):
            p["_pts"] = p["model"]["proj"]
        else:
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
