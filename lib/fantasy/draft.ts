/* Snake-draft room engine.
 *
 * Opponents draft by market consensus: best available FantasyPros ECR,
 * with light need-based caps (no 2nd QB or TE before round 9, kickers only
 * in the last two rounds). Your picks are recommended by full-draft rollout:
 * for each candidate, simulate the entire remaining draft (opponents by
 * consensus, your future turns filled greedily by marginal roster value)
 * and rank candidates by the final projected value of your completed roster.
 * Every actual pick you record replaces the assumption for that slot, and
 * everything downstream re-simulates.
 */

import { UNIVERSE, type UniversePlayer } from "./universe";

export interface DraftConfig {
  teams: number;
  /** Your draft slot, 1-based. */
  slot: number;
  rounds: number;
}

export interface DraftPick {
  overall: number; // 0-based
  team: number; // 0-based
  playerId: string;
}

const BENCH_WEIGHT = 0.35;
const STARTERS = { QB: 1, RB: 2, WR: 2, TE: 1 };
const FLEX_POS = new Set(["RB", "WR", "TE"]);
/** A bench player is only worth what he'd add if pressed into the lineup, so
 * bench value is measured above the waiver-wire baseline at his position. */
const REPLACEMENT_RANK: Record<string, number> = { QB: 17, RB: 35, WR: 35, TE: 13, K: 12 };
const MY_CAPS: Record<string, number> = { QB: 2, TE: 2, K: 1 };

/** 0-based team index on the clock for 0-based overall pick i. */
export function teamOnClock(i: number, teams: number): number {
  const round = Math.floor(i / teams);
  const j = i % teams;
  return round % 2 === 0 ? j : teams - 1 - j;
}

export function isMyPick(i: number, cfg: DraftConfig): boolean {
  return teamOnClock(i, cfg.teams) === cfg.slot - 1;
}

/** Overall pick numbers (0-based) belonging to your slot. */
export function myPickNumbers(cfg: DraftConfig): number[] {
  const out: number[] = [];
  for (let i = 0; i < cfg.teams * cfg.rounds; i++) if (isMyPick(i, cfg)) out.push(i);
  return out;
}

/* Market board: ECR ascending; unranked players after, by projection. */
const BOARD: UniversePlayer[] = [...UNIVERSE].sort((a, b) => {
  if (a.ecr != null && b.ecr != null) return a.ecr - b.ecr;
  if (a.ecr != null) return -1;
  if (b.ecr != null) return 1;
  return b.proj - a.proj;
});

const POS_BASELINE: Record<string, number> = {};
for (const [pos, rank] of Object.entries(REPLACEMENT_RANK)) {
  const group = UNIVERSE.filter((p) => p.pos === pos).sort((a, b) => b.proj - a.proj);
  POS_BASELINE[pos] = group[Math.min(rank, group.length) - 1]?.proj ?? 0;
}

/** Value of a set of players as a fantasy roster: starters at full projection
 * (1QB / 2RB / 2WR / 1TE / 1FLEX / 1K), bench heavily discounted. */
export function rosterValue(players: UniversePlayer[]): { total: number; lineup: { slot: string; p: UniversePlayer }[] } {
  const byPos: Record<string, UniversePlayer[]> = { QB: [], RB: [], WR: [], TE: [], K: [] };
  for (const p of players) byPos[p.pos]?.push(p);
  for (const pos in byPos) byPos[pos].sort((a, b) => b.proj - a.proj);

  const lineup: { slot: string; p: UniversePlayer }[] = [];
  const used = new Set<string>();
  for (const [pos, n] of Object.entries(STARTERS)) {
    for (let k = 0; k < n; k++) {
      const p = byPos[pos][k];
      if (p) {
        lineup.push({ slot: pos, p });
        used.add(p.id);
      }
    }
  }
  const flex = players
    .filter((p) => FLEX_POS.has(p.pos) && !used.has(p.id))
    .sort((a, b) => b.proj - a.proj)[0];
  if (flex) {
    lineup.push({ slot: "FLEX", p: flex });
    used.add(flex.id);
  }
  if (byPos.K[0]) {
    lineup.push({ slot: "K", p: byPos.K[0] });
    used.add(byPos.K[0].id);
  }
  let total = lineup.reduce((a, s) => a + s.p.proj, 0);
  for (const p of players)
    if (!used.has(p.id)) total += BENCH_WEIGHT * Math.max(0, p.proj - (POS_BASELINE[p.pos] ?? 0));
  return { total, lineup };
}

function marginalValue(roster: UniversePlayer[], baseTotal: number, p: UniversePlayer): number {
  return rosterValue([...roster, p]).total - baseTotal;
}

/** Consensus opponent: best available ECR under light roster-shape caps. */
function opponentPick(
  available: UniversePlayer[],
  taken: Set<string>,
  counts: Record<string, number>,
  round: number,
  rounds: number,
): UniversePlayer | null {
  const lastRounds = round >= rounds - 2;
  for (const p of available) {
    if (taken.has(p.id)) continue;
    if (p.pos === "K" && !lastRounds) continue;
    if (p.pos === "QB" && (counts.QB ?? 0) >= (round < 8 ? 1 : 3)) continue;
    if (p.pos === "TE" && (counts.TE ?? 0) >= (round < 8 ? 1 : 3)) continue;
    if ((counts[p.pos] ?? 0) >= 7) continue;
    return p;
  }
  for (const p of available) if (!taken.has(p.id)) return p;
  return null;
}

/** My greedy rollout choice: highest marginal roster value; K only late. */
function myGreedyPick(
  available: UniversePlayer[],
  taken: Set<string>,
  roster: UniversePlayer[],
  round: number,
  rounds: number,
): UniversePlayer | null {
  const baseTotal = rosterValue(roster).total;
  const lastRounds = round >= rounds - 2;
  const myCounts: Record<string, number> = {};
  for (const p of roster) myCounts[p.pos] = (myCounts[p.pos] ?? 0) + 1;
  let best: UniversePlayer | null = null;
  let bestVal = -Infinity;
  let seen = 0;
  for (const p of available) {
    if (taken.has(p.id)) continue;
    if (p.pos === "K" && !lastRounds) continue;
    if (MY_CAPS[p.pos] != null && (myCounts[p.pos] ?? 0) >= MY_CAPS[p.pos]) continue;
    const v = marginalValue(roster, baseTotal, p);
    if (v > bestVal) {
      bestVal = v;
      best = p;
    }
    if (++seen >= 60) break; // the board is consensus-sorted; deeper is never better
  }
  // Force a kicker with the final pick if still missing.
  if (round === rounds - 1 && !(myCounts.K ?? 0)) {
    const k = available.find((p) => !taken.has(p.id) && p.pos === "K");
    if (k) return k;
  }
  return best;
}

export interface SimResult {
  /** Your projected picks for the rest of the draft: [round, player]. */
  plan: { round: number; overall: number; p: UniversePlayer }[];
  roster: UniversePlayer[];
  value: number;
  lineup: { slot: string; p: UniversePlayer }[];
  /** Pool as predicted at each of your future picks (for wait-cost math). */
  availableAtMyPicks: Map<number, UniversePlayer[]>;
}

/**
 * Simulate the remaining draft from the recorded picks. `forcedNext`, if
 * given, is taken with your next pick; your later turns use the greedy
 * rollout. Opponents always follow the consensus model.
 */
export function simulateDraft(cfg: DraftConfig, picks: DraftPick[], forcedNext?: string): SimResult {
  const taken = new Set(picks.map((p) => p.playerId));
  const counts: Record<string, Record<string, number>> = {};
  const rosters: Record<number, UniversePlayer[]> = {};
  for (const pk of picks) {
    const pl = BOARD.find((p) => p.id === pk.playerId);
    if (!pl) continue;
    (counts[pk.team] ??= {})[pl.pos] = (counts[pk.team]?.[pl.pos] ?? 0) + 1;
    (rosters[pk.team] ??= []).push(pl);
  }
  const me = cfg.slot - 1;
  const plan: SimResult["plan"] = [];
  const availableAtMyPicks = new Map<number, UniversePlayer[]>();
  let forced = forcedNext;

  const total = cfg.teams * cfg.rounds;
  for (let i = picks.length; i < total; i++) {
    const team = teamOnClock(i, cfg.teams);
    const round = Math.floor(i / cfg.teams);
    let choice: UniversePlayer | null;
    if (team === me) {
      availableAtMyPicks.set(i, BOARD.filter((p) => !taken.has(p.id)).slice(0, 250));
      if (forced) {
        choice = BOARD.find((p) => p.id === forced) ?? null;
        forced = undefined;
      } else {
        choice = myGreedyPick(BOARD, taken, rosters[me] ?? [], round, cfg.rounds);
      }
      if (choice) plan.push({ round: round + 1, overall: i, p: choice });
    } else {
      choice = opponentPick(BOARD, taken, counts[team] ?? {}, round, cfg.rounds);
    }
    if (!choice) continue;
    taken.add(choice.id);
    (counts[team] ??= {})[choice.pos] = (counts[team]?.[choice.pos] ?? 0) + 1;
    (rosters[team] ??= []).push(choice);
  }

  const mine = rosters[me] ?? [];
  const rv = rosterValue(mine);
  return { plan, roster: mine, value: rv.total, lineup: rv.lineup, availableAtMyPicks };
}

export interface Candidate {
  p: UniversePlayer;
  /** Final projected roster value if this pick is made now. */
  finalValue: number;
  /** Points lost at this position by passing until your next pick. */
  waitCost: number;
  /** Projected points above the positional replacement baseline. */
  vor: number;
  /** How far the market expects this player to fall past the current pick
   * (positive = value vs consensus, negative = a reach). */
  adpDelta: number | null;
  /** Probability the player is still available at your next pick, from a
   * Normal(ecr, sd) selection model over the market consensus. */
  survival: number | null;
}

function normalCdf(z: number): number {
  // Abramowitz-Stegun approximation; plenty for a survival readout.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

/** P(player still on the board at pick `atPick` | available at pick `nowPick`),
 * modeling his selection pick as Normal(ecr, max(6, 2.5 x expert sd)). */
export function survivalProb(p: UniversePlayer, nowPick: number, atPick: number): number | null {
  if (p.ecr == null) return null;
  const sd = Math.max(6, 2.5 * (p.ecrSd ?? 3));
  const pNow = 1 - normalCdf((nowPick - p.ecr) / sd);
  const pAt = 1 - normalCdf((atPick - p.ecr) / sd);
  if (pNow <= 1e-9) return 0;
  return Math.max(0, Math.min(1, pAt / pNow));
}

export interface Recommendation {
  onClockOverall: number;
  round: number;
  candidates: Candidate[];
  baseline: SimResult;
}

/** Ranked recommendations for your next pick given the recorded picks. */
export function recommend(cfg: DraftConfig, picks: DraftPick[]): Recommendation | null {
  const total = cfg.teams * cfg.rounds;
  let i = picks.length;
  while (i < total && !isMyPick(i, cfg)) i++;
  if (i >= total) return null;

  const baseline = simulateDraft(cfg, picks);
  const taken = new Set(picks.map((p) => p.playerId));
  const nowAvailable = BOARD.filter((p) => !taken.has(p.id));

  // Best available later at each position (opponents keep drafting between
  // your turns), for the wait-cost readout.
  const myFuture = [...baseline.availableAtMyPicks.keys()].sort((a, b) => a - b);
  const nextPool = myFuture.length > 1 ? baseline.availableAtMyPicks.get(myFuture[1]) ?? [] : [];
  const bestLater: Record<string, number> = {};
  for (const p of nextPool) bestLater[p.pos] = Math.max(bestLater[p.pos] ?? 0, p.proj);

  // Candidate set: strongest by marginal value plus the market's top board.
  const me = cfg.slot - 1;
  const myRoster: UniversePlayer[] = [];
  for (const pk of picks) {
    if (pk.team === me) {
      const pl = BOARD.find((p) => p.id === pk.playerId);
      if (pl) myRoster.push(pl);
    }
  }
  const baseTotal = rosterValue(myRoster).total;
  const scored = nowAvailable.slice(0, 120).map((p) => ({ p, mv: marginalValue(myRoster, baseTotal, p) }));
  scored.sort((a, b) => b.mv - a.mv);
  const shortlist = [...new Set([...scored.slice(0, 14).map((s) => s.p), ...nowAvailable.slice(0, 6)])].slice(0, 16);

  const nowPickNo = i + 1; // 1-based, matches ECR's pick scale
  const nextPickNo = myFuture.length > 1 ? myFuture[1] + 1 : null;
  const candidates: Candidate[] = shortlist.map((p) => {
    const sim = simulateDraft(cfg, picks, p.id);
    const bestNow = Math.max(...nowAvailable.filter((q) => q.pos === p.pos).slice(0, 40).map((q) => q.proj));
    return {
      p,
      finalValue: sim.value,
      waitCost: Math.max(0, bestNow - (bestLater[p.pos] ?? 0)),
      vor: p.proj - (POS_BASELINE[p.pos] ?? 0),
      adpDelta: p.ecr != null ? Math.round(nowPickNo - p.ecr) : null,
      survival: nextPickNo != null ? survivalProb(p, nowPickNo, nextPickNo) : null,
    };
  });
  candidates.sort((a, b) => b.finalValue - a.finalValue);
  const best = candidates[0] ? simulateDraft(cfg, picks, candidates[0].p.id) : baseline;
  return { onClockOverall: i, round: Math.floor(i / cfg.teams) + 1, candidates, baseline: best };
}

/** Append consensus opponent picks until it is your turn (or the draft ends). */
export function advanceToMyPick(cfg: DraftConfig, picks: DraftPick[]): DraftPick[] {
  const total = cfg.teams * cfg.rounds;
  const taken = new Set(picks.map((p) => p.playerId));
  const counts: Record<number, Record<string, number>> = {};
  for (const pk of picks) {
    const pl = BOARD.find((p) => p.id === pk.playerId);
    if (pl) (counts[pk.team] ??= {})[pl.pos] = (counts[pk.team]?.[pl.pos] ?? 0) + 1;
  }
  const added: DraftPick[] = [];
  let i = picks.length;
  while (i < total && !isMyPick(i, cfg)) {
    const team = teamOnClock(i, cfg.teams);
    const round = Math.floor(i / cfg.teams);
    const choice = opponentPick(BOARD, taken, counts[team] ?? {}, round, cfg.rounds);
    if (!choice) break;
    added.push({ overall: i, team, playerId: choice.id });
    taken.add(choice.id);
    (counts[team] ??= {})[choice.pos] = (counts[team]?.[choice.pos] ?? 0) + 1;
    i++;
  }
  return added;
}

export { BOARD };
