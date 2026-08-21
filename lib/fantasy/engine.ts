/* Projection aggregation, VOR, and risk.
 * Port of the FantasyFootballAnalyticsR calculation pipeline:
 *   Calculate League Projections.R  -> robust multi-source averaging
 *   Risk.R                          -> composite risk score
 *   Value Over Replacement.R        -> VOR and ranks
 *   Avg Cost.R                      -> league-cap cost inflation
 */

import type { LeagueSettings, ProjectedPlayer, RawPlayer, VorPosition } from "./types";
import { VOR_POSITIONS } from "./types";
import { computePoints, replacementRank } from "./scoring";
import { mad, mean, pseudoMedian, pseudoMedianCI, sd, zScores } from "./stats";

export function buildProjections(raw: RawPlayer[], league: LeagueSettings): ProjectedPlayer[] {
  const players: ProjectedPlayer[] = raw.map((p) => {
    const sourcePoints: Record<string, number> = {};
    for (const [src, stats] of Object.entries(p.sources)) {
      sourcePoints[src] = computePoints(p.pos, stats, league.scoring);
    }
    const pts = Object.values(sourcePoints);
    const [lo, hi] = pseudoMedianCI(pts);
    const adps = p.adp ? Object.values(p.adp) : [];
    const sdPts = pts.length >= 2 ? mad(pts) : null;
    return {
      id: p.id,
      player: p.player,
      pos: p.pos,
      team: p.team,
      sourcePoints,
      points: pseudoMedian(pts),
      pointsLo: lo,
      pointsHi: hi,
      positionRank: 0,
      overallRank: 0,
      vor: null,
      pick: adps.length ? mean(adps) : null,
      sdPts: sdPts === 0 ? null : sdPts,
      sdPick: p.adpSd ?? null,
      risk: null,
      avgCost: p.avgCost,
      inflatedCost: 1,
    };
  });

  rankByPoints(players);
  computeVor(players, league);
  computeRisk(players);
  computeInflatedCost(players, league);
  return players;
}

function rankByPoints(players: ProjectedPlayer[]) {
  const byPoints = [...players].sort((a, b) => b.points - a.points);
  const posCount: Record<string, number> = {};
  byPoints.forEach((p, i) => {
    p.overallRank = i + 1;
    posCount[p.pos] = (posCount[p.pos] ?? 0) + 1;
    p.positionRank = posCount[p.pos];
  });
}

function computeVor(players: ProjectedPlayer[], league: LeagueSettings) {
  for (const pos of VOR_POSITIONS) {
    const rep = replacementRank(pos, league);
    const atPos = players.filter((p) => p.pos === pos);
    // Replacement value = mean points across ranks rep-1 .. rep+1, smoothing
    // out a single odd projection at the boundary (as the R script does).
    const nearReplacement = atPos.filter(
      (p) => p.positionRank >= rep - 1 && p.positionRank <= rep + 1,
    );
    if (!nearReplacement.length) continue;
    const replacementValue = mean(nearReplacement.map((p) => p.points));
    for (const p of atPos) p.vor = p.points - replacementValue;
  }

  // Re-rank by VOR within the positions that have one (overall + positional).
  const withVor = players.filter((p) => p.vor != null).sort((a, b) => b.vor! - a.vor!);
  const posCount: Record<string, number> = {};
  withVor.forEach((p, i) => {
    p.overallRank = i + 1;
    posCount[p.pos] = (posCount[p.pos] ?? 0) + 1;
    p.positionRank = posCount[p.pos];
  });
}

/**
 * Risk blends two signals, each z-scored within position so positions are
 * comparable: disagreement between projection sources (MAD of points) and
 * disagreement between drafters (sd of draft pick). The blend is rescaled
 * to mean 5, sd 2 -- so ~5 is typical, <4 is safe, >6 is boom-or-bust.
 */
function computeRisk(players: ProjectedPlayer[]) {
  for (const pos of VOR_POSITIONS) {
    const atPos = players.filter((p) => p.pos === pos);
    const sdPtsZ = zScores(atPos.map((p) => p.sdPts));
    const sdPickZ = zScores(atPos.map((p) => p.sdPick));
    atPos.forEach((p, i) => {
      const zs = [sdPtsZ[i], sdPickZ[i]].filter((z): z is number => z != null);
      p.risk = zs.length ? mean(zs) : null;
    });
  }
  const risks = players.map((p) => p.risk).filter((r): r is number => r != null);
  if (risks.length < 2) return;
  const m = mean(risks);
  const s = sd(risks);
  for (const p of players) {
    if (p.risk != null) p.risk = (p.risk * 2) / s + (5 - m);
  }
}

/**
 * Scale observed auction costs to the league's cap, inflating the top of the
 * draft (top ~33 players go over slot value, the tail goes under).
 */
function computeInflatedCost(players: ProjectedPlayer[], league: LeagueSettings) {
  const capRatio = league.leagueCap / league.defaultCap;
  for (const p of players) {
    const factor = p.overallRank && p.overallRank <= 33 ? 1.1 : p.overallRank && p.overallRank <= 66 ? 1.0 : 0.9;
    const cost = Math.ceil(p.avgCost * capRatio * factor);
    p.inflatedCost = Math.max(1, Number.isFinite(cost) ? cost : 1);
  }
}

/** Per-position VOR tiers: split at the largest point gaps among draft-relevant players. */
export function assignTiers(players: ProjectedPlayer[], pos: VorPosition, numTiers = 5): Map<string, number> {
  const pool = players
    .filter((p) => p.pos === pos && p.vor != null && p.vor > -20)
    .sort((a, b) => b.vor! - a.vor!);
  const tiers = new Map<string, number>();
  if (pool.length < 2) {
    pool.forEach((p) => tiers.set(p.id, 1));
    return tiers;
  }
  const gaps = pool.slice(1).map((p, i) => ({ idx: i + 1, gap: pool[i].vor! - p.vor! }));
  const breaks = new Set(
    gaps.sort((a, b) => b.gap - a.gap).slice(0, numTiers - 1).map((g) => g.idx),
  );
  let tier = 1;
  pool.forEach((p, i) => {
    if (breaks.has(i)) tier++;
    tiers.set(p.id, tier);
  });
  return tiers;
}
