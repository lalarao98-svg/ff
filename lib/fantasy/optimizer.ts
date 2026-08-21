/* Optimum auction roster.
 * Port of optimizeTeam() from FantasyFootballAnalyticsR (Functions.R), which
 * solved a binary LP with Rglpk: maximize projected points subject to
 *   - each drafted player's risk <= maxRisk  (a per-player filter)
 *   - at least the required starters per position, exact QB count
 *   - exactly numTotalStarters players in total
 *   - total cost <= cap minus $1 per bench spot
 * Here the same optimum is found exactly with dynamic programming: a
 * per-position knapsack over (players taken, budget spent), then a
 * convolution across positions for every feasible slot allocation.
 */

import type { LeagueSettings, ProjectedPlayer, RosterSolution, VorPosition } from "./types";
import { VOR_POSITIONS } from "./types";
import { maxStarterCost } from "./scoring";

const NEG = -Infinity;

interface PosTable {
  players: ProjectedPlayer[];
  /** best[k][c]: max points using exactly k players of this position at total cost c. */
  best: Float64Array[];
  /** took[i][k][c]: whether player i is in the optimum for state (k, c) — for reconstruction. */
  took: Uint8Array[][];
}

function buildPosTable(players: ProjectedPlayer[], maxK: number, maxCost: number): PosTable {
  const best: Float64Array[] = [];
  for (let k = 0; k <= maxK; k++) {
    best.push(new Float64Array(maxCost + 1).fill(NEG));
  }
  best[0].fill(0);
  const took: Uint8Array[][] = [];
  players.forEach((p) => {
    const cost = p.inflatedCost;
    const tookRow: Uint8Array[] = [];
    for (let k = 0; k <= maxK; k++) tookRow.push(new Uint8Array(maxCost + 1));
    // 0/1 knapsack: iterate k and c downward so each player is used at most once.
    for (let k = maxK; k >= 1; k--) {
      for (let c = maxCost; c >= cost; c--) {
        const cand = best[k - 1][c - cost] + p.points;
        if (cand > best[k][c]) {
          best[k][c] = cand;
          tookRow[k][c] = 1;
        }
      }
    }
    took.push(tookRow);
  });
  return { players, best, took };
}

function reconstruct(table: PosTable, k0: number, c0: number): ProjectedPlayer[] {
  const picks: ProjectedPlayer[] = [];
  let k = k0;
  let c = c0;
  for (let i = table.players.length - 1; i >= 0 && k > 0; i--) {
    if (table.took[i][k][c]) {
      picks.push(table.players[i]);
      k -= 1;
      c -= table.players[i].inflatedCost;
    }
  }
  return picks;
}

export interface OptimizerOptions {
  maxRisk: number;
  /** Players already gone in the draft (excluded from the pool). */
  omit?: Set<string>;
  /** Budget override; defaults to leagueCap minus $1 per bench spot. */
  budget?: number;
}

export function optimizeRoster(
  projections: ProjectedPlayer[],
  league: LeagueSettings,
  opts: OptimizerOptions,
): RosterSolution {
  const budget = Math.max(1, Math.floor(opts.budget ?? maxStarterCost(league)));
  // A player with no risk score (a single season of data) only qualifies
  // when the cap is fully off -- mirroring R's na.omit under a finite cap.
  const pool = projections.filter(
    (p) =>
      (VOR_POSITIONS as readonly string[]).includes(p.pos) &&
      (p.risk != null ? p.risk <= opts.maxRisk : opts.maxRisk === Infinity) &&
      p.points > 0 &&
      !opts.omit?.has(p.id),
  );

  const total = league.numTotalStarters;
  const minSlots = league.starters;
  // Per-position ceiling on how many can be started: the flex room above the minimums.
  const flexRoom = total - VOR_POSITIONS.reduce((a, pos) => a + minSlots[pos], 0);
  const maxK: Record<VorPosition, number> = {
    QB: minSlots.QB, // R model: exactly numQBstarters QBs
    RB: minSlots.RB + Math.max(0, flexRoom),
    WR: minSlots.WR + Math.max(0, flexRoom),
    TE: minSlots.TE + Math.max(0, flexRoom),
  };

  const tables = {} as Record<VorPosition, PosTable>;
  for (const pos of VOR_POSITIONS) {
    tables[pos] = buildPosTable(pool.filter((p) => p.pos === pos), maxK[pos], budget);
  }

  let best: { pts: number; picks: ProjectedPlayer[]; cost: number } | null = null;

  // Enumerate feasible slot splits (QB fixed; RB/WR/TE >= minimum, summing to total).
  for (let kRB = minSlots.RB; kRB <= maxK.RB; kRB++) {
    for (let kWR = minSlots.WR; kWR <= maxK.WR; kWR++) {
      const kTE = total - minSlots.QB - kRB - kWR;
      if (kTE < minSlots.TE || kTE > maxK.TE) continue;
      const ks: Record<VorPosition, number> = { QB: minSlots.QB, RB: kRB, WR: kWR, TE: kTE };

      // Convolve budgets across positions: consider every split of the cap.
      let acc = new Float64Array(budget + 1).fill(NEG);
      acc[0] = 0;
      const spendAt: Int32Array[] = [];
      for (const pos of VOR_POSITIONS) {
        const row = tables[pos].best[ks[pos]];
        const next = new Float64Array(budget + 1).fill(NEG);
        const chosen = new Int32Array(budget + 1).fill(-1);
        for (let c = 0; c <= budget; c++) {
          if (acc[c] === NEG) continue;
          for (let s = 0; s + c <= budget; s++) {
            if (row[s] === NEG) continue;
            const cand = acc[c] + row[s];
            if (cand > next[c + s]) {
              next[c + s] = cand;
              chosen[c + s] = s;
            }
          }
        }
        spendAt.push(chosen);
        acc = next;
      }

      let bestC = -1;
      for (let c = 0; c <= budget; c++) {
        if (acc[c] !== NEG && (bestC === -1 || acc[c] > acc[bestC])) bestC = c;
      }
      if (bestC === -1) continue;

      // Walk back through the per-position spends to recover the lineup.
      let c = bestC;
      const picks: ProjectedPlayer[] = [];
      for (let s = VOR_POSITIONS.length - 1; s >= 0; s--) {
        const pos = VOR_POSITIONS[s];
        const spent = spendAt[s][c];
        picks.push(...reconstruct(tables[pos], ks[pos], spent));
        c -= spent;
      }

      if (!best || acc[bestC] > best.pts) {
        best = { pts: acc[bestC], picks, cost: bestC };
      }
    }
  }

  if (!best) {
    return { players: [], totalPoints: 0, totalCost: 0, feasible: false };
  }
  const players = best.picks.sort(
    (a, b) => VOR_POSITIONS.indexOf(a.pos as VorPosition) - VOR_POSITIONS.indexOf(b.pos as VorPosition) || b.points - a.points,
  );
  return {
    players,
    totalPoints: best.pts,
    totalCost: players.reduce((a, p) => a + p.inflatedCost, 0),
    feasible: true,
  };
}
