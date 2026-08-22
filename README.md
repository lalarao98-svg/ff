# FieldEdge

Fantasy football analytics on [nflverse-data](https://github.com/nflverse/nflverse-data),
with the draft pipeline ported from
[FantasyFootballAnalyticsR](https://github.com/dadrivr/FantasyFootballAnalyticsR)
(fantasyfootballanalytics.net). Paper-white house design: black rules, red accent.

Each player's last three completed NFL regular seasons act as independent
projection "sources"; a single-season player gets a deterministic spread
around their anchor.

## Tabs

- **Player Lab** — Monte Carlo weekly projection (6,000 sims) under what-if
  factors: injury status, age curve, wind/precipitation/dome, opponent
  defense, Vegas implied total, game script, snap share. Includes a live
  injury + weather sync via the Claude API with web search.
- **Start / Sit** — head-to-head outcome distributions, win probability, and
  floor/median/ceiling under each player's saved scenario.
- **Draft Board** — backtested model projections (usage & recency-weighted
  per-game rates x availability-shrunk expected games, position age curves,
  empirical injury-recovery comps), value over replacement, risk
  (season-to-season spread widened for players returning from major
  injuries), the risk-capped optimum roster, the points-vs-risk frontier,
  and the model-validation table.

## Layout

- `components/fieldedge/FieldEdge.jsx` — the app UI (single component, three tabs)
- `lib/fantasy/universe.ts` — player universe built from the bundled dataset
- `lib/fantasy/` — the ported analytics library: scoring, robust statistics
  (`stats.ts`), the projection engine (`engine.ts`), and an exact
  auction-roster optimizer (`optimizer.ts`, knapsack DP replacing the
  original's Rglpk binary LP)
- `scripts/model.py` — the predictive model: feature layer, age curves, and
  injury-recovery multipliers learned from every comparable
  position-x-body-part case in nflverse injury reports since 2009
- `scripts/backtest.py` — ablation backtest on held-out seasons; writes
  `lib/fantasy/data/backtest.json` (shown in the app's validation table)
- `scripts/build-dataset.py` — regenerates `lib/fantasy/data/projections.json`
  (stats, ages, weekly volatility, and model fields) from nflverse-data
- `app/api/live-report/route.ts` — server route for the live sync
  (needs `ANTHROPIC_API_KEY`)

## Development

```bash
npm install
npm run dev
```

For the Player Lab's live sync, set `ANTHROPIC_API_KEY` in the environment
(e.g. `.env.local`); without it the button reports that sync is unconfigured
and everything else works normally.

## Refreshing the data

```bash
npm run data                                # last 3 completed seasons
python3 scripts/backtest.py                 # re-validate the model
python3 scripts/build-dataset.py --seasons 2024 2025 2026
```

Downloads regular-season player stats and birthdates from nflverse-data and
rewrites `lib/fantasy/data/projections.json`.
