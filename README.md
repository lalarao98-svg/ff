# FieldEdge

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flalarao98-svg%2Fff&env=ANTHROPIC_API_KEY&envDescription=Optional%3A%20powers%20the%20Player%20Lab%27s%20live%20injury%2Fweather%2Frole%20sync&project-name=fieldedge&repository-name=fieldedge)

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
  empirical injury-recovery comps) blended 50/50 with the FantasyPros
  expert-consensus rank (via DynastyProcess) — the strongest variant in the
  backtest; value over replacement; risk (season spread + expert
  disagreement, widened for players returning from major injuries); the
  risk-capped optimum roster; the points-vs-risk frontier; and the
  model-validation table.

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
- `app/api/espn-draft/route.ts` — live ESPN draft feed for the Draft Room
  (see below)

## Deploying

Click the Vercel button above (or import the repo at vercel.com/new) — the
app is a standard Next.js build with the dataset committed, so there is
nothing else to configure. Set `ANTHROPIC_API_KEY` in the project's
environment variables if you want the Player Lab's live sync; without it
everything else works and the sync button explains it is unconfigured.
Every push to `main` redeploys.

## ESPN live draft sync

The Draft Room can mirror a real ESPN Fantasy draft. The server polls ESPN's
v3 league endpoint (mDraftDetail / mSettings / mTeam / mRoster views) every
2.5 seconds; the client polls the server. Configure with environment
variables — the cookies stay server-side and are never sent to the browser:

| Variable | Meaning |
|---|---|
| `ESPN_LEAGUE_ID` | League id (defaults to `872177723`) |
| `ESPN_SEASON` | Season year (defaults to `2026`) |
| `ESPN_SWID` | `SWID` cookie — private leagues only, keep the braces |
| `ESPN_S2` | `espn_s2` cookie — private leagues only |
| `ESPN_MOCK` | `1` serves a growing mock draft for local development |

Find the two cookies while logged into fantasy.espn.com (browser dev tools →
Application → Cookies). In the app: Draft Room → Connect to ESPN → choose
which team is yours. Picks stream in as they happen; recommendations,
survival probabilities, and the rest-of-draft plan recompute on each one.

## Development

```bash
npm install
npm run dev
```

For the Player Lab's live sync, set `ANTHROPIC_API_KEY` in the environment
(e.g. `.env.local`); without it the button reports that sync is unconfigured
and everything else works normally.

## Refreshing the data

A scheduled GitHub Action (`.github/workflows/refresh-data.yml`) rebuilds the
dataset every Tuesday and Friday morning and commits it, so a deployed site
picks up fresh FantasyPros market consensus automatically. Manual refresh:

```bash
npm run data                                # refresh stats + market consensus
python3 scripts/backtest.py                 # re-validate the model (pip install pyarrow)
python3 scripts/build-dataset.py --seasons 2024 2025 2026
```

Downloads regular-season player stats, injuries, and birthdates from
nflverse-data plus the DynastyProcess ECR mirror, and rewrites
`lib/fantasy/data/projections.json`.
