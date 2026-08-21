/* Types for the fantasy football analytics engine.
 * Ported from FantasyFootballAnalyticsR (fantasyfootballanalytics.net). */

export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DST";

export const VOR_POSITIONS = ["QB", "RB", "WR", "TE"] as const;
export type VorPosition = (typeof VOR_POSITIONS)[number];

/** Stat categories present in the bundled dataset (subset of the R repo's scoreCategories). */
export type StatLine = Partial<Record<string, number>>;

export interface RawPlayer {
  id: string;
  player: string;
  pos: Position;
  team: string;
  /** ADP by service (yahoo / espn / fp / ffc), overall pick number. */
  adp?: Record<string, number>;
  /** Std dev of draft pick (FantasyFootballCalculator crowd data). */
  adpSd?: number;
  /** Auction cost at the default cap (market data, or estimated from value over replacement). */
  avgCost: number;
  /** Per-source raw stat projections. */
  sources: Record<string, StatLine>;
}

export interface ProjectionDataset {
  season: number;
  sources: Record<string, string>;
  players: RawPlayer[];
}

/** Scoring multipliers, points per unit of each stat category. */
export interface ScoringSettings {
  passYds: number;
  passTds: number;
  passInt: number;
  rushYds: number;
  rushTds: number;
  rec: number;
  recYds: number;
  recTds: number;
  returnTds: number;
  twoPts: number;
  fumbles: number;
}

export interface LeagueSettings {
  numTeams: number;
  starters: Record<VorPosition, number>;
  /** Total starting-lineup spots counted by the optimizer (allows flex beyond position minimums). */
  numTotalStarters: number;
  /** Full roster size including bench (reserves $1 per bench spot in auctions). */
  numTotalPlayers: number;
  /** Typical auction cap for the source cost data (ESPN/Yahoo default). */
  defaultCap: number;
  /** Your league's auction cap. */
  leagueCap: number;
  scoring: ScoringSettings;
}

export interface ProjectedPlayer {
  id: string;
  player: string;
  pos: Position;
  team: string;
  /** Points by source name. */
  sourcePoints: Record<string, number>;
  /** Hodges-Lehmann robust average of source points. */
  points: number;
  /** Wilcoxon signed-rank CI bounds across sources (min/max Walsh averages at small n). */
  pointsLo: number;
  pointsHi: number;
  positionRank: number;
  overallRank: number;
  /** Value over a typical replacement starter; only for QB/RB/WR/TE. */
  vor: number | null;
  /** Average draft pick across services. */
  pick: number | null;
  /** MAD of points across sources. */
  sdPts: number | null;
  /** Std dev of draft pick. */
  sdPick: number | null;
  /** Composite risk, rescaled to mean 5, sd 2 (higher = riskier). */
  risk: number | null;
  avgCost: number;
  /** Cost adjusted to league cap with early-round inflation. */
  inflatedCost: number;
}

export interface RosterSolution {
  players: ProjectedPlayer[];
  totalPoints: number;
  totalCost: number;
  feasible: boolean;
}
