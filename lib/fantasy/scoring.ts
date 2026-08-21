/* League settings and point scoring.
 * Port of R Scripts/Functions/League Settings.R from FantasyFootballAnalyticsR. */

import type { LeagueSettings, Position, ScoringSettings, StatLine } from "./types";

export const DEFAULT_SCORING: ScoringSettings = {
  passYds: 1 / 25,
  passTds: 4,
  passInt: -3,
  rushYds: 1 / 10,
  rushTds: 6,
  rec: 0,
  recYds: 1 / 8,
  recTds: 6,
  returnTds: 6,
  twoPts: 2,
  fumbles: -3,
};

export const DEFAULT_LEAGUE: LeagueSettings = {
  numTeams: 10,
  starters: { QB: 1, RB: 2, WR: 2, TE: 1 },
  numTotalStarters: 7,
  numTotalPlayers: 20,
  defaultCap: 200,
  leagueCap: 225,
  scoring: DEFAULT_SCORING,
};

/* Kicker and DST scoring stays fixed (mirrors the R defaults). */
const K_SCORING: StatLine = { xp: 1, fg0019: 3, fg2029: 3, fg3039: 3, fg4049: 4, fg50: 5 };
const DST_SCORING: StatLine = { dstFumlRec: 2, dstInt: 2, dstSafety: 2, dstSack: 1, dstTd: 6, dstBlk: 1.5 };

const OFFENSE_KEYS: (keyof ScoringSettings)[] = [
  "passYds", "passTds", "passInt", "rushYds", "rushTds",
  "rec", "recYds", "recTds", "returnTds", "twoPts", "fumbles",
];

/** Fantasy points for one source's stat line under the given scoring settings. */
export function computePoints(pos: Position, stats: StatLine, scoring: ScoringSettings): number {
  let pts = 0;
  if (pos === "K") {
    const hasSplits = ["fg0019", "fg2029", "fg3039", "fg4049", "fg50"].some((k) => stats[k] != null);
    for (const [k, mult] of Object.entries(K_SCORING)) pts += (stats[k] ?? 0) * mult!;
    // Sources report either distance splits or a made-FG total; never count both.
    if (!hasSplits) pts += (stats.fg ?? 0) * 3;
    return pts;
  }
  if (pos === "DST") {
    for (const [k, mult] of Object.entries(DST_SCORING)) pts += (stats[k] ?? 0) * mult!;
    return pts;
  }
  for (const k of OFFENSE_KEYS) pts += (stats[k] ?? 0) * scoring[k];
  return pts;
}

/**
 * Replacement-level position rank: the rank at which a player is a typical
 * waiver-wire replacement rather than a starter. Multipliers from the R repo
 * (qb 1.7, rb/wr 1.4, te 1.3 x starters x teams).
 */
export function replacementRank(pos: "QB" | "RB" | "WR" | "TE", league: LeagueSettings): number {
  const mult = { QB: 1.7, RB: 1.4, WR: 1.4, TE: 1.3 }[pos];
  return Math.ceil(league.starters[pos] * league.numTeams * mult);
}

/** Auction budget available for starters: cap minus $1 held for each bench spot. */
export function maxStarterCost(league: LeagueSettings): number {
  return league.leagueCap - (league.numTotalPlayers - league.numTotalStarters);
}
