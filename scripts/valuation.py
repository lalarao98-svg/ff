#!/usr/bin/env python3
"""Relative-value model: usage & team-scheme regressions.

Builds predictor variables from every player-season since 2017 -- usage
shares (target share %, carry share, air-yards share, scrimmage-yards
share), efficiency/luck (TDs per touch), and team scheme (pass rate, and
how concentrated the team's targets and yards are among its skill players,
measured as a Herfindahl index) -- then regresses next-season points per
game on them, position by position.

Two products:
  1. A findings report (which variables actually predict future
     performance, out-of-sample) -> lib/fantasy/data/valuation.json,
     rendered in the app's Methodology tab.
  2. A per-player EDGE for the coming draft: regression-predicted season
     points minus market-implied points. Positive = the market is
     undervaluing the player's underlying usage profile.

Run standalone for the report: python3 scripts/valuation.py   (needs numpy)
"""

import json
import os
from collections import defaultdict

import numpy as np

from model import OFFENSE_POS, History, fantasy_points, num, season_stats

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib", "fantasy", "data", "valuation.json")

FIRST_FEATURE_SEASON = 2017
MIN_GAMES = 4
SKILL = {"RB", "WR", "TE"}

FEATURES = {
    "QB": ["ppg", "games", "age", "qbRushYpg", "tdPerOpp", "teamPassRate"],
    "RB": ["ppg", "games", "age", "carryShare", "tgtShare", "tdPerOpp", "teamPassRate", "teamConcYds"],
    "WR": ["ppg", "games", "age", "tgtShare", "airShare", "yardsShare", "tdPerOpp", "teamPassRate", "teamConcTgt"],
    "TE": ["ppg", "games", "age", "tgtShare", "airShare", "yardsShare", "tdPerOpp", "teamPassRate", "teamConcTgt"],
}

FEATURE_LABELS = {
    "ppg": "Prior points per game",
    "games": "Games played",
    "age": "Age",
    "qbRushYpg": "QB rushing yds/gm",
    "carryShare": "Carry share %",
    "tgtShare": "Target share %",
    "airShare": "Air-yards share %",
    "yardsShare": "Scrimmage-yards share %",
    "tdPerOpp": "TDs per opportunity",
    "teamPassRate": "Team pass rate",
    "teamConcTgt": "Team target concentration",
    "teamConcYds": "Team yardage concentration",
}


def build_features(hist, first, last):
    """(pid, season) -> feature dict, using team aggregates within the season."""
    feats = {}
    for season in range(first, last + 1):
        rows = [r for r in season_stats(season) if (r.get("position_group") or "") in OFFENSE_POS and num(r.get("games")) >= 1]
        team = defaultdict(lambda: defaultdict(float))
        skill_tgt = defaultdict(list)
        skill_yds = defaultdict(list)
        for r in rows:
            t = r.get("recent_team") or "?"
            team[t]["passAtt"] += num(r.get("attempts"))
            team[t]["carries"] += num(r.get("carries"))
            team[t]["targets"] += num(r.get("targets"))
            team[t]["air"] += num(r.get("receiving_air_yards"))
            scrim = num(r.get("rushing_yards")) + num(r.get("receiving_yards"))
            team[t]["scrim"] += scrim
            if (r.get("position_group") or "") in SKILL:
                skill_tgt[t].append(num(r.get("targets")))
                skill_yds[t].append(scrim)

        conc_tgt, conc_yds = {}, {}
        for t in team:
            tot_t = sum(skill_tgt[t]) or 1
            tot_y = sum(skill_yds[t]) or 1
            conc_tgt[t] = sum((x / tot_t) ** 2 for x in skill_tgt[t])
            conc_yds[t] = sum((x / tot_y) ** 2 for x in skill_yds[t])

        for r in rows:
            games = num(r.get("games"))
            if games < MIN_GAMES:
                continue
            pid = r["player_id"]
            pos = r.get("position_group")
            t = r.get("recent_team") or "?"
            tm = team[t]
            targets = num(r.get("targets"))
            carries = num(r.get("carries"))
            pass_att = num(r.get("attempts"))
            tds = num(r.get("passing_tds")) + num(r.get("rushing_tds")) + num(r.get("receiving_tds"))
            opps = pass_att + carries + targets
            age = hist.age_at(pid, season)
            feats[(pid, season)] = {
                "pos": pos,
                "ppg": fantasy_points(r) / games,
                "games": games,
                "age": age if age is not None else 26,
                "qbRushYpg": num(r.get("rushing_yards")) / games,
                "carryShare": carries / (tm["carries"] or 1),
                "tgtShare": targets / (tm["targets"] or 1),
                "airShare": num(r.get("receiving_air_yards")) / (tm["air"] or 1),
                "yardsShare": (num(r.get("rushing_yards")) + num(r.get("receiving_yards"))) / (tm["scrim"] or 1),
                "tdPerOpp": tds / opps if opps else 0.0,
                "teamPassRate": tm["passAtt"] / ((tm["passAtt"] + tm["carries"]) or 1),
                "teamConcTgt": conc_tgt.get(t, 0.0),
                "teamConcYds": conc_yds.get(t, 0.0),
            }
    return feats


def _design(rows, names):
    X = np.array([[r[n] for n in names] for r in rows], dtype=float)
    mu, sd = X.mean(axis=0), X.std(axis=0)
    sd[sd == 0] = 1
    return (X - mu) / sd, mu, sd


def _ols(Xz, y):
    A = np.hstack([np.ones((len(Xz), 1)), Xz])
    beta = np.linalg.lstsq(A + 0.0, y, rcond=None)[0]
    return beta  # [intercept, coefs...]


def _r2(y, yhat):
    ss = np.sum((y - y.mean()) ** 2)
    return 1 - np.sum((y - yhat) ** 2) / ss if ss else 0.0


def fit_valuation(hist, last_completed):
    """Fit per-position regressions on all transitions up to `last_completed`
    and return (report, predict_fn) where predict_fn(pid) -> predicted next
    season ppg (or None)."""
    feats = build_features(hist, FIRST_FEATURE_SEASON, last_completed)

    # transitions: features in season s -> ppg in season s+1
    samples = defaultdict(list)  # pos -> [(featrow, next_ppg, outcome_season)]
    for (pid, season), f in feats.items():
        nxt = hist.ps.get((pid, season + 1))
        if not nxt or nxt["games"] < MIN_GAMES:
            continue
        samples[f["pos"]].append((f, nxt["pts"] / nxt["games"], season + 1))

    report = {"firstSeason": FIRST_FEATURE_SEASON, "lastOutcome": last_completed, "positions": {}}
    models = {}
    for pos, names in FEATURES.items():
        rows = samples.get(pos, [])
        if len(rows) < 60:
            continue
        y_all = np.array([r[1] for r in rows])
        Xz_all, mu, sd = _design([r[0] for r in rows], names)

        # out-of-sample: hold out the final outcome season
        test_mask = np.array([r[2] == last_completed for r in rows])
        if test_mask.sum() >= 20:
            beta_tr = _ols(Xz_all[~test_mask], y_all[~test_mask])
            yhat = beta_tr[0] + Xz_all[test_mask] @ beta_tr[1:]
            r2_test = _r2(y_all[test_mask], yhat)
            # baseline: prior ppg alone
            ppg_ix = names.index("ppg")
            beta_b = _ols(Xz_all[~test_mask][:, [ppg_ix]], y_all[~test_mask])
            r2_base = _r2(y_all[test_mask], beta_b[0] + Xz_all[test_mask][:, [ppg_ix]] @ beta_b[1:])
        else:
            r2_test = r2_base = None

        beta = _ols(Xz_all, y_all)
        models[pos] = {"names": names, "mu": mu, "sd": sd, "beta": beta}

        feat_rows = []
        for i, n in enumerate(names):
            uni = float(np.corrcoef(Xz_all[:, i], y_all)[0, 1])
            feat_rows.append({"feature": FEATURE_LABELS[n], "coefStd": round(float(beta[i + 1]), 3), "r": round(uni, 3)})
        feat_rows.sort(key=lambda r: -abs(r["coefStd"]))
        report["positions"][pos] = {
            "n": len(rows),
            "r2Test": round(float(r2_test), 3) if r2_test is not None else None,
            "r2Baseline": round(float(r2_base), 3) if r2_base is not None else None,
            "features": feat_rows,
        }

    latest = {pid: f for (pid, s), f in feats.items() if s == last_completed}

    def predict(pid):
        f = latest.get(pid)
        if not f or f["pos"] not in models:
            return None
        m = models[f["pos"]]
        x = (np.array([f[n] for n in m["names"]]) - m["mu"]) / m["sd"]
        return float(m["beta"][0] + x @ m["beta"][1:])

    return report, predict, latest


def main():
    hist = History(FIRST_FEATURE_SEASON - 1, 2025)
    report, _, _ = fit_valuation(hist, 2025)
    with open(os.path.abspath(OUT), "w") as f:
        json.dump(report, f, indent=1)
    for pos, p in report["positions"].items():
        print(f"\n{pos}  (n={p['n']}, out-of-sample R2 {p['r2Test']} vs prior-ppg-only {p['r2Baseline']})")
        for fr in p["features"]:
            print(f"   {fr['feature']:32} coef {fr['coefStd']:+.3f}   univariate r {fr['r']:+.3f}")
    print(f"\nwrote {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
