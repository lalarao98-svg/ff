#!/usr/bin/env python3
"""Predictive projection model over nflverse-data.

Feature layer + projection variants used by both build-dataset.py (to ship
2026 projections) and backtest.py (to prove each modeling step on held-out
seasons):

  V0  robust baseline    Hodges-Lehmann pseudo-median of last-3 season totals
                         (the original FantasyFootballAnalyticsR approach)
  V1  usage/recency      recency- and games-weighted per-game scoring rate
                         x an availability-shrunk expected-games estimate
  V2  + age              per-season rates re-based through position-specific
                         career age curves before averaging
  V3  + injury recovery  if the latest season ended as a major-injury season,
                         apply an empirical year-after multiplier learned from
                         every comparable (position x body part) case since 2010

All downloads are cached in scripts/.cache/ (gitignored).
"""

import csv
import datetime
import gzip
import io
import math
import os
import urllib.request
from collections import Counter, defaultdict

BASE = "https://github.com/nflverse/nflverse-data/releases/download"
DP = "https://raw.githubusercontent.com/dynastyprocess/data/master/files"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")

OFFENSE_POS = {"QB", "RB", "WR", "TE"}

SCORING = {
    "passing_yards": 1 / 25, "passing_tds": 4, "passing_interceptions": -3,
    "rushing_yards": 1 / 10, "rushing_tds": 6,
    "receiving_yards": 1 / 8, "receiving_tds": 6,
    "special_teams_tds": 6, "fumbles_lost_total": -3,
}
TWO_PT_COLS = ("passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions")

# Availability prior: typical games played by an established starter (17-game era).
GAMES_PRIOR = 14.5
GAMES_MIN, GAMES_MAX = 6.0, 17.0
RECENCY = [0.5, 0.3, 0.2]  # T-1, T-2, T-3

# A season counts as a "major injury season" when the player sat at least this
# many games while carrying a named injury on the report.
MAJOR_INJURY_MAX_GAMES = 13

BODY_PARTS = {
    "Knee", "Ankle", "Hamstring", "Shoulder", "Concussion", "Groin",
    "Foot", "Back", "Achilles", "Calf", "Quadricep", "Ribs", "Hip",
    "Neck", "Toe", "Wrist", "Elbow", "Chest", "Abdomen", "Pectoral",
}


def num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else 0.0
    except (TypeError, ValueError):
        return 0.0


def fetch_csv(url, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print(f"fetching {url}")
        with urllib.request.urlopen(url) as resp:
            raw = resp.read()
        if url.endswith(".gz"):
            raw = gzip.decompress(raw)
        with open(path, "wb") as f:
            f.write(raw)
    with open(path, "r", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def season_stats(season):
    return fetch_csv(f"{BASE}/stats_player/stats_player_reg_{season}.csv.gz",
                     f"stats_reg_{season}.csv")


def weekly_stats(season):
    return fetch_csv(f"{BASE}/stats_player/stats_player_week_{season}.csv.gz",
                     f"stats_week_{season}.csv")


def injuries(season):
    suffix = ".csv.gz" if season >= 2023 else ".csv"
    return fetch_csv(f"{BASE}/injuries/injuries_{season}{suffix}",
                     f"injuries_{season}.csv")


def birth_dates():
    rows = fetch_csv(f"{BASE}/players/players.csv.gz", "players.csv")
    return {r["gsis_id"]: r["birth_date"] for r in rows if r.get("gsis_id") and r.get("birth_date")}


def norm_name(name):
    return "".join(c for c in (name or "").upper() if c.isalnum())


def latest_ecr():
    """Current FantasyPros redraft-overall consensus (via DynastyProcess):
    normalized name -> {ecr, sd}. Scraped daily."""
    rows = fetch_csv(f"{DP}/db_fpecr_latest.csv", "db_fpecr_latest.csv")
    out = {}
    for r in rows:
        if r.get("ecr_type") != "ro":
            continue
        out[(norm_name(r.get("player")), r.get("pos"))] = {
            "ecr": num(r.get("ecr")), "sd": num(r.get("sd")),
        }
    return out


def historical_ecr(target_season):
    """August redraft-overall consensus immediately before `target_season`,
    from the DynastyProcess FantasyPros archive (parquet; needs pyarrow).
    Returns normalized (name, pos) -> ecr, or None if unavailable."""
    try:
        import pyarrow.parquet as pq
    except ImportError:
        return None
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, "db_fpecr.parquet")
    if not os.path.exists(path):
        url = f"{DP}/db_fpecr.parquet"
        for attempt in range(3):
            print(f"fetching {url}")
            try:
                with urllib.request.urlopen(url) as resp, open(path + ".part", "wb") as f:
                    while True:
                        chunk = resp.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                os.replace(path + ".part", path)
                break
            except Exception as e:
                print(f"  download failed ({e}), retrying" if attempt < 2 else f"  giving up: {e}")
        else:
            return None
    t = pq.read_table(path, columns=["ecr_type", "scrape_date", "player", "pos", "ecr"])
    d = t.to_pydict()
    # last snapshot in August of the draft year
    best_date = None
    prefix = f"{target_season}-08"
    for i in range(len(d["ecr_type"])):
        if d["ecr_type"][i] == "ro":
            date = str(d["scrape_date"][i])
            if date.startswith(prefix) and (best_date is None or date > best_date):
                best_date = date
    if best_date is None:
        return None
    out = {}
    for i in range(len(d["ecr_type"])):
        if d["ecr_type"][i] == "ro" and str(d["scrape_date"][i]) == best_date:
            out[(norm_name(d["player"][i]), d["pos"][i])] = num(d["ecr"][i])
    return out


def market_points(hist, target, recovery, ecr_by_key):
    """Convert market ranks to points using our own projection curve:
    the market's #r player at a position is credited with the points of our
    #r-projected player there. Returns pid -> market-implied points."""
    projs = defaultdict(list)  # pos -> sorted model projections
    named = {}
    for (pid, season), rec in hist.ps.items():
        if season != target - 1:
            continue
        proj = hist.project(pid, target, 3, recovery)
        if proj is not None:
            projs[rec["pos"]].append(proj)
            named[pid] = (norm_name(rec["name"]), rec["pos"], proj)
    for pos in projs:
        projs[pos].sort(reverse=True)
    # market position-rank from overall ecr ordering
    by_pos_rank = defaultdict(list)
    for (name, pos), val in ecr_by_key.items():
        ecr = val["ecr"] if isinstance(val, dict) else val
        by_pos_rank[pos].append((ecr, name))
    pos_rank = {}
    for pos, lst in by_pos_rank.items():
        for i, (_, name) in enumerate(sorted(lst)):
            pos_rank[(name, pos)] = i
    out = {}
    for pid, (name, pos, _) in named.items():
        r = pos_rank.get((name, pos))
        curve = projs.get(pos)
        if r is not None and curve:
            out[pid] = curve[min(r, len(curve) - 1)]
    return out


def fantasy_points(row):
    pts = sum(num(row.get(col)) * mult for col, mult in SCORING.items())
    pts += 2 * sum(num(row.get(c)) for c in TWO_PT_COLS)
    return pts


def age_curve(pos, age):
    """Career curves, identical to the UI's what-if lab."""
    if pos == "QB":
        if age < 23: return 0.88
        if age < 26: return 0.96
        if age <= 35: return 1.0
        return max(0.78, 1 - 0.02 * (age - 35))
    if pos == "RB":
        if age < 22: return 0.95
        if age <= 26: return 1.0
        if age <= 29: return 1 - 0.05 * (age - 26)
        return max(0.5, 0.85 - 0.08 * (age - 29))
    if pos == "WR":
        if age < 23: return 0.93
        if age <= 29: return 1.0
        return max(0.6, 1 - 0.035 * (age - 29))
    if pos == "TE":
        if age < 24: return 0.9
        if age <= 30: return 1.0
        return max(0.62, 1 - 0.04 * (age - 30))
    return 1.0


class History:
    """player-season features across a span of seasons."""

    def __init__(self, first_season, last_season):
        self.first, self.last = first_season, last_season
        self.births = birth_dates()
        # (pid, season) -> {games, pts, rate, pos, name, team}
        self.ps = {}
        # (pid, season) -> body part of a major injury season, or None
        self.major = {}
        for season in range(first_season, last_season + 1):
            for row in season_stats(season):
                pos = row.get("position_group") or ""
                if pos not in OFFENSE_POS:
                    continue
                games = num(row.get("games"))
                if games < 1:
                    continue
                pts = fantasy_points(row)
                self.ps[(row["player_id"], season)] = {
                    "games": games, "pts": pts, "rate": pts / games, "pos": pos,
                    "name": row.get("player_display_name") or row.get("player_name"),
                    "team": row.get("recent_team") or "FA",
                }
            try:
                inj_rows = injuries(season)
            except urllib.error.HTTPError:
                continue
            parts = defaultdict(Counter)
            for r in inj_rows:
                part = (r.get("report_primary_injury") or "").strip().title()
                if part and r.get("gsis_id"):
                    parts[r["gsis_id"]][part] += 1
            for pid, counts in parts.items():
                rec = self.ps.get((pid, season))
                if rec and rec["games"] <= MAJOR_INJURY_MAX_GAMES:
                    part = counts.most_common(1)[0][0]
                    self.major[(pid, season)] = part if part in BODY_PARTS else "Other"

    def age_at(self, pid, season):
        bd = self.births.get(pid)
        if not bd:
            return None
        try:
            b = datetime.date.fromisoformat(bd)
        except ValueError:
            return None
        ref = datetime.date(season, 9, 1)
        return ref.year - b.year - ((ref.month, ref.day) < (b.month, b.day))

    def evidence(self, pid, target):
        """[(season, rec, recency_weight)] for target-3..target-1, newest first."""
        out = []
        for k, season in enumerate(range(target - 1, target - 4, -1)):
            rec = self.ps.get((pid, season))
            if rec:
                out.append((season, rec, RECENCY[k]))
        return out

    # ---- projection variants ------------------------------------------------

    def project(self, pid, target, variant, recovery=None):
        """Projected season points for `target`, or None without evidence.

        variant: 0 robust totals | 1 usage/recency | 2 +age | 3 +injury
        """
        ev = self.evidence(pid, target)
        if not ev:
            return None
        pos = ev[0][1]["pos"]

        if variant == 0:
            totals = [rec["pts"] for _, rec, _ in ev]
            walsh = sorted((a + b) / 2 for i, a in enumerate(totals) for b in totals[i:])
            n = len(walsh)
            return walsh[n // 2] if n % 2 else (walsh[n // 2 - 1] + walsh[n // 2]) / 2

        age_t = self.age_at(pid, target)
        num_w = den_w = 0.0
        g_num = g_den = 0.0
        for season, rec, rw in ev:
            rate = rec["rate"]
            if variant >= 2 and age_t is not None:
                age_s = self.age_at(pid, season)
                if age_s is not None:
                    rate *= age_curve(pos, age_t) / age_curve(pos, age_s)
            w = rw * rec["games"]  # recency x evidence volume
            num_w += w * rate
            den_w += w
            g_num += rw * rec["games"]
            g_den += rw
        if not den_w:
            return None
        rate = num_w / den_w
        g_hist = g_num / g_den
        n_seasons = len(ev)
        exp_games = (g_hist * n_seasons + GAMES_PRIOR) / (n_seasons + 1)
        exp_games = max(GAMES_MIN, min(GAMES_MAX, exp_games))

        mult = 1.0
        if variant >= 3 and recovery is not None:
            part = self.major.get((pid, target - 1))
            if part:
                mult = recovery.get((pos, part)) or recovery.get(("*", part)) or 1.0
        return rate * exp_games * mult

    def components(self, pid, target, recovery=None):
        """Full detail for the shipped dataset: rate, exp games, age & injury mults."""
        ev = self.evidence(pid, target)
        if not ev:
            return None
        base = self.project(pid, target, 1)
        aged = self.project(pid, target, 2)
        full = self.project(pid, target, 3, recovery)
        pos = ev[0][1]["pos"]
        num_g = sum(rw * rec["games"] for _, rec, rw in ev)
        den_g = sum(rw for _, _, rw in ev)
        n = len(ev)
        exp_games = max(GAMES_MIN, min(GAMES_MAX, (num_g / den_g * n + GAMES_PRIOR) / (n + 1)))
        part = self.major.get((pid, target - 1))
        return {
            "proj": full,
            "projPg": full / exp_games,
            "expGames": exp_games,
            "ageMult": (aged / base) if base else 1.0,
            "injMult": (full / aged) if aged else 1.0,
            "injPart": part,
            "gamesBySeason": {str(s): rec["games"] for s, rec, _ in ev},
            "pos": pos,
        }


def learn_recovery(hist, last_pair_season):
    """Empirical year-after multipliers m(pos, body part), hierarchically shrunk.

    For every major-injury season s with a next season s+1 <= last_pair_season:
      ratio = actual s+1 per-game rate / V2-predicted s+1 per-game rate.
    Cells shrink toward the body-part pool, which shrinks toward 1.0.
    """
    samples = defaultdict(list)
    for (pid, season), part in hist.major.items():
        nxt = season + 1
        if nxt > last_pair_season:
            continue
        actual = hist.ps.get((pid, nxt))
        if not actual or actual["games"] < 4:
            continue
        pred = hist.project(pid, nxt, 2)
        ev = hist.evidence(pid, nxt)
        if pred is None or pred <= 20 or not ev:
            continue
        n_seasons = len(ev)
        num_g = sum(rw * rec["games"] for _, rec, rw in ev)
        den_g = sum(rw for _, _, rw in ev)
        exp_games = max(GAMES_MIN, min(GAMES_MAX, (num_g / den_g * n_seasons + GAMES_PRIOR) / (n_seasons + 1)))
        pred_rate = pred / exp_games
        ratio = max(0.3, min(2.0, actual["rate"] / pred_rate))
        samples[(actual["pos"], part)].append(ratio)

    part_pool = defaultdict(list)
    for (pos, part), rs in samples.items():
        part_pool[part].extend(rs)

    K_CELL, K_PART = 6.0, 20.0
    recovery = {}
    for part, rs in part_pool.items():
        pooled = (sum(rs) + K_PART * 1.0) / (len(rs) + K_PART)
        recovery[("*", part)] = pooled
        for pos in OFFENSE_POS:
            cell = samples.get((pos, part), [])
            recovery[(pos, part)] = (sum(cell) + K_CELL * pooled) / (len(cell) + K_CELL)
    counts = {f"{pos}|{part}": len(rs) for (pos, part), rs in samples.items()}
    return recovery, counts
