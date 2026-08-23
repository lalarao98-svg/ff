/* Snake-draft room engine.
 *
 * Opponents draft by market behavior: real ESPN ADP where available (baked
 * in at data-build time and refreshed live through /api/espn-adp), falling
 * back to the FantasyPros expert consensus rank -- with light need-based
 * caps (no 2nd QB or TE before round 9, kickers only in the last two
 * rounds). The same rank, treated probabilistically, prices every future
 * pick: each position's expected best-available projection at a later pick
 * integrates over every player's survival odds (Normal(market rank, expert
 * disagreement)). Your plan is built by lookahead over an opportunity-cost
 * rollout -- take the position whose value decays fastest, never reaching
 * far ahead of a player's market rank -- and candidates for the current
 * pick are ranked by the final projected value of the completed roster.
 * Every actual pick you record replaces an assumption, and everything
 * downstream re-solves.
 */

import { UNIVERSE, type UniversePlayer } from "./universe";

/** The market-behavior rank: where drafters actually take the player (ESPN
 * ADP), or where experts rank him when no ADP is known. */
export function marketRank(p: UniversePlayer): number | null {
  return p.adp ?? p.ecr;
}

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

/* Market board: market rank ascending; unranked players after, by
 * projection. Re-sorted in place when live ADP arrives (applyAdp). */
function boardCompare(a: UniversePlayer, b: UniversePlayer): number {
  const ra = marketRank(a);
  const rb = marketRank(b);
  if (ra != null && rb != null) return ra - rb;
  if (ra != null) return -1;
  if (rb != null) return 1;
  return b.proj - a.proj;
}
const BOARD: UniversePlayer[] = [...UNIVERSE].sort(boardCompare);

/** Overlay live ESPN ADP (espnId -> adp) onto the universe: the board
 * re-sorts and every cached survival probability is invalidated. Returns
 * how many players were updated. */
export function applyAdp(map: Map<number, number>): number {
  let n = 0;
  for (const p of UNIVERSE) {
    if (p.espnId != null && map.has(p.espnId)) {
      const adp = map.get(p.espnId)!;
      if (adp >= 1 && adp <= 500 && p.adp !== adp) {
        p.adp = adp;
        n++;
      }
    }
  }
  if (n) {
    BOARD.sort(boardCompare);
    SURV_CACHE.clear();
  }
  return n;
}

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
 * modeling his selection pick as Normal(market rank, max(6, 2.5 x expert sd)). */
export function survivalProb(p: UniversePlayer, nowPick: number, atPick: number): number | null {
  const rank = marketRank(p);
  if (rank == null) return null;
  const key = `${p.id}:${nowPick}:${atPick}`;
  const hit = SURV_CACHE.get(key);
  if (hit !== undefined) return hit;
  const sd = Math.max(6, 2.5 * (p.ecrSd ?? 3));
  const pNow = 1 - normalCdf((nowPick - rank) / sd);
  const pAt = 1 - normalCdf((atPick - rank) / sd);
  const out = pNow <= 1e-9 ? 0 : Math.max(0, Math.min(1, pAt / pNow));
  if (SURV_CACHE.size > 60000) SURV_CACHE.clear();
  SURV_CACHE.set(key, out);
  return out;
}
const SURV_CACHE = new Map<string, number>();

export interface EvBest {
  /** Expected projection of the best player still available at the pick. */
  ev: number;
  /** The player the pick most likely lands: highest-projected with survival
   * >= 0.5 whose consensus rank is within reach of the pick (ADP honesty --
   * the plan never assumes taking someone far ahead of where the market
   * drafts him; waiting is priced by the survival math instead). */
  likely: UniversePlayer | null;
}

/** How many picks ahead of a player's consensus rank a planned pick may
 * reach. Tight early (nobody takes ADP-26 Josh Allen in round 1-2), looser
 * late where consensus ranks are noisy anyway. */
export function maxReach(atPickNo: number): number {
  return Math.max(5, 0.1 * atPickNo);
}

/** For each position: the expected best-available projection at a future
 * pick, integrating over every player's probability of surviving that long
 * (best = highest projection; P(best is p) = P(p survives) x P(all better
 * players are gone)). This is what makes waiting on a position priceable. */
export function expectedBestByPos(taken: Set<string>, nowPickNo: number, atPickNo: number): Record<string, EvBest> {
  const out: Record<string, EvBest> = {};
  const reach = maxReach(atPickNo);
  for (const pos of ["QB", "RB", "WR", "TE", "K"]) {
    const pool = BOARD.filter((p) => p.pos === pos && !taken.has(p.id))
      .sort((a, b) => b.proj - a.proj)
      .slice(0, 30);
    let allBetterGone = 1;
    let ev = 0;
    let likely: UniversePlayer | null = null;
    for (const p of pool) {
      const rank = marketRank(p);
      const pa = rank == null ? 1 : survivalProb(p, nowPickNo, atPickNo) ?? 1;
      ev += p.proj * pa * allBetterGone;
      if (likely == null && pa >= 0.5 && (rank == null || rank - atPickNo <= reach)) likely = p;
      allBetterGone *= 1 - pa;
      if (allBetterGone < 1e-4) break;
    }
    if (pool.length) ev += pool[pool.length - 1].proj * allBetterGone;
    out[pos] = { ev, likely };
  }
  return out;
}

export interface PlanResult {
  plan: {
    round: number;
    overall: number;
    p: { id: string; name: string; pos: string; proj: number };
    /** Market rank (ESPN ADP, or expert consensus) of the likely player. */
    ecr: number | null;
  }[];
  value: number;
  lineup: { slot: string; p: UniversePlayer }[];
}

const PLAN_POS = ["QB", "RB", "WR", "TE", "K"];

function eligiblePositions(counts: Record<string, number>, round: number, rounds: number): string[] {
  const lastRounds = round >= rounds - 1;
  return PLAN_POS.filter((pos) => {
    if (pos === "K" && !lastRounds) return false;
    if (MY_CAPS[pos] != null && (counts[pos] ?? 0) >= MY_CAPS[pos]) return false;
    return true;
  });
}

/** Pick a position for pick `m` by opportunity cost: the position whose
 * marginal roster value decays the most between this pick and my next one
 * (`m2`). Absolute marginal value is the wrong rule -- an empty QB slot
 * always looks enormous in raw points, but QBs keep falling for rounds, so
 * what matters is how much of the value is still there if you wait. */
function pickByUrgency(
  roster: UniversePlayer[],
  taken: Set<string>,
  m: number,
  m2: number | null,
  nowPickNo: number,
  eligible: string[],
): { pos: string; ev: EvBest } | null {
  const evs = expectedBestByPos(taken, nowPickNo, m + 1);
  const evsNext = m2 != null ? expectedBestByPos(taken, nowPickNo, m2 + 1) : null;
  // ADP discipline: only positions with a within-reach likely target are
  // draftable here (unless none has one -- then take the best regardless).
  const inReach = eligible.filter((pos) => evs[pos].likely != null);
  const pool = inReach.length ? inReach : eligible;
  const baseTotal = rosterValue(roster).total;
  let bestPos: string | null = null;
  let bestScore = -Infinity;
  let bestMarg = -Infinity;
  for (const pos of pool) {
    const margNow =
      rosterValue([...roster, { pos, proj: evs[pos].ev, id: `ev:${pos}:${m}` } as unknown as UniversePlayer]).total -
      baseTotal;
    const margLater = evsNext
      ? rosterValue([...roster, { pos, proj: evsNext[pos].ev, id: `ev:${pos}:${m2}` } as unknown as UniversePlayer])
          .total - baseTotal
      : 0;
    const score = margNow - margLater;
    if (score > bestScore || (score === bestScore && margNow > bestMarg)) {
      bestScore = score;
      bestMarg = margNow;
      bestPos = pos;
    }
  }
  return bestPos ? { pos: bestPos, ev: evs[bestPos] } : null;
}

/** Fill the given future picks with EV pseudo-players via the urgency rule.
 * This is the rollout inside the lookahead planner below. */
function greedyFillValue(
  cfg: DraftConfig,
  roster: UniversePlayer[],
  taken: Set<string>,
  futurePicks: number[],
  nowPickNo: number,
): number {
  const r = [...roster];
  const t = new Set(taken);
  for (let j = 0; j < futurePicks.length; j++) {
    const m = futurePicks[j];
    const m2 = j + 1 < futurePicks.length ? futurePicks[j + 1] : null;
    const round = Math.floor(m / cfg.teams) + 1;
    const counts: Record<string, number> = {};
    for (const p of r) counts[p.pos] = (counts[p.pos] ?? 0) + 1;
    if (round === cfg.rounds && !(counts.K ?? 0)) {
      const k = BOARD.find((p) => p.pos === "K" && !t.has(p.id));
      if (k) {
        r.push(k);
        t.add(k.id);
        continue;
      }
    }
    const choice = pickByUrgency(r, t, m, m2, nowPickNo, eligiblePositions(counts, round, cfg.rounds));
    if (!choice) continue;
    r.push({ id: `ev:${choice.pos}:${m}`, name: "", pos: choice.pos, proj: choice.ev.ev } as unknown as UniversePlayer);
    if (choice.ev.likely) t.add(choice.ev.likely.id);
  }
  return rosterValue(r).total;
}

/**
 * Probability-aware plan for your remaining picks. Two ideas keep it honest
 * against ADP. First, each future pick sees the EXPECTED best-available
 * projection per position -- every player weighted by his probability of
 * surviving that long under a Normal(consensus rank, expert disagreement)
 * model -- rather than assuming players vanish in strict consensus order.
 * Second, each position is chosen by one-step lookahead: take it, greedily
 * complete the rest of the plan, and keep whichever choice maximizes the
 * FINAL roster value. That comparison is what prices waiting correctly: a
 * QB's expected value decays slowly across rounds (the market drafts them
 * late), so spending an early pick on one forfeits fast-decaying RB/WR
 * value and the lookahead defers the QB -- no hand-coded round rules.
 */
export function planExpected(cfg: DraftConfig, picks: DraftPick[], forcedNextId?: string): PlanResult {
  const taken = new Set(picks.map((p) => p.playerId));
  const me = cfg.slot - 1;
  const roster: UniversePlayer[] = [];
  for (const pk of picks) {
    if (pk.team !== me) continue;
    const pl = BOARD.find((p) => p.id === pk.playerId);
    if (pl) roster.push(pl);
  }
  const n0 = picks.length;
  const nowPickNo = n0 + 1;
  const myPicks = myPickNumbers(cfg).filter((i) => i >= n0);
  const plan: PlanResult["plan"] = [];
  let forced = forcedNextId;

  for (let j = 0; j < myPicks.length; j++) {
    const m = myPicks[j];
    const rest = myPicks.slice(j + 1);
    const round = Math.floor(m / cfg.teams) + 1;
    const counts: Record<string, number> = {};
    for (const p of roster) counts[p.pos] = (counts[p.pos] ?? 0) + 1;

    if (forced) {
      const pl = BOARD.find((p) => p.id === forced);
      forced = undefined;
      if (pl) {
        roster.push(pl);
        taken.add(pl.id);
        plan.push({ round, overall: m, p: pl, ecr: marketRank(pl) });
        continue;
      }
    }

    // Force a kicker with the final pick if still missing.
    if (round === cfg.rounds && !(counts.K ?? 0)) {
      const k = BOARD.find((p) => p.pos === "K" && !taken.has(p.id));
      if (k) {
        roster.push(k);
        taken.add(k.id);
        plan.push({ round, overall: m, p: k, ecr: marketRank(k) });
        continue;
      }
    }

    const evs = expectedBestByPos(taken, nowPickNo, m + 1);
    const elig = eligiblePositions(counts, round, cfg.rounds);
    const inReach = elig.filter((pos) => evs[pos].likely != null);
    const pool = inReach.length ? inReach : elig;
    let bestPos: string | null = null;
    let bestVal = -Infinity;
    for (const pos of pool) {
      const pseudo = { id: `ev:${pos}:${m}`, name: "", pos, proj: evs[pos].ev } as unknown as UniversePlayer;
      const trialTaken = evs[pos].likely ? new Set([...taken, evs[pos].likely.id]) : taken;
      const val = greedyFillValue(cfg, [...roster, pseudo], trialTaken, rest, nowPickNo);
      if (val > bestVal) {
        bestVal = val;
        bestPos = pos;
      }
    }
    if (!bestPos) continue;
    const chosen = evs[bestPos];
    const pseudo = {
      id: `ev:${bestPos}:${m}`,
      name: chosen.likely ? chosen.likely.name : `Best ${bestPos} available`,
      pos: bestPos,
      proj: chosen.ev,
    } as unknown as UniversePlayer;
    roster.push(pseudo);
    plan.push({ round, overall: m, p: pseudo, ecr: chosen.likely ? marketRank(chosen.likely) : null });
    if (chosen.likely) taken.add(chosen.likely.id);
  }

  const rv = rosterValue(roster);
  return { plan, value: rv.total, lineup: rv.lineup };
}

export interface Recommendation {
  onClockOverall: number;
  round: number;
  candidates: Candidate[];
  baseline: PlanResult;
}

/** Ranked recommendations for your next pick given the recorded picks. */
export function recommend(cfg: DraftConfig, picks: DraftPick[]): Recommendation | null {
  const total = cfg.teams * cfg.rounds;
  let i = picks.length;
  while (i < total && !isMyPick(i, cfg)) i++;
  if (i >= total) return null;

  const taken = new Set(picks.map((p) => p.playerId));
  const nowAvailable = BOARD.filter((p) => !taken.has(p.id));
  const nowPickNo = i + 1;
  const future = myPickNumbers(cfg).filter((m) => m > i);
  const nextPickNo = future.length ? future[0] + 1 : null;
  const evNext = nextPickNo != null ? expectedBestByPos(taken, nowPickNo, nextPickNo) : null;

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
  // Candidates worth pricing: the market's own menu (top of the consensus
  // board), the best-projected player at each position, and the best raw
  // marginal adds. Marginal value alone would flood the list with QBs --
  // absolute points, not draft value.
  const topPos: UniversePlayer[] = [];
  for (const pos of ["QB", "RB", "WR", "TE"])
    topPos.push(...nowAvailable.filter((q) => q.pos === pos).sort((a, b) => b.proj - a.proj).slice(0, 2));
  const shortlist = [
    ...new Set([...nowAvailable.slice(0, 10), ...topPos, ...scored.slice(0, 8).map((s) => s.p)]),
  ].slice(0, 20);

  const candidates: Candidate[] = shortlist.map((p) => {
    // Rank candidates by the urgency rollout of the rest of the draft --
    // the same engine as the plan, cheap enough to run for every candidate
    // on every live pick.
    const finalValue = greedyFillValue(cfg, [...myRoster, p], new Set([...taken, p.id]), future, nowPickNo);
    const bestNow = Math.max(...nowAvailable.filter((q) => q.pos === p.pos).slice(0, 40).map((q) => q.proj));
    return {
      p,
      finalValue,
      waitCost: evNext ? Math.max(0, bestNow - evNext[p.pos].ev) : 0,
      vor: p.proj - (POS_BASELINE[p.pos] ?? 0),
      adpDelta: marketRank(p) != null ? Math.round(nowPickNo - marketRank(p)!) : null,
      survival: nextPickNo != null ? survivalProb(p, nowPickNo, nextPickNo) : null,
    };
  });
  // ADP discipline mirrors the planner: a candidate the market prices far
  // after this pick is a "wait -- he'll still be there" case (his P(next)
  // column says how confidently), so in-reach candidates rank first and
  // reaches sort below them, whatever their roster math says.
  const reachLimit = maxReach(nowPickNo);
  const isReach = (c: Candidate) => marketRank(c.p) != null && marketRank(c.p)! - nowPickNo > reachLimit;
  candidates.sort((a, b) => {
    const ra = isReach(a) ? 1 : 0;
    const rb = isReach(b) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return b.finalValue - a.finalValue;
  });
  const baseline = candidates[0] ? planExpected(cfg, picks, candidates[0].p.id) : planExpected(cfg, picks);
  return { onClockOverall: i, round: Math.floor(i / cfg.teams) + 1, candidates, baseline };
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
