/* Player universe for the FieldEdge UI, built from the bundled nflverse-data
 * dataset (last three completed NFL regular seasons; each season is one
 * projection "source"). Pipeline mirrors FantasyFootballAnalyticsR:
 * Hodges-Lehmann robust average, MAD spread, risk z-scored within position
 * and rescaled to mean 5 / sd 2. */

import { DATASET } from "./index";
import { computePoints, DEFAULT_SCORING } from "./scoring";
import { mad, mean, pseudoMedian, sd } from "./stats";
import type { Position } from "./types";

export const GAMES = 17;
export const CORE = ["QB", "RB", "WR", "TE"];
export const POS_LIST = ["QB", "RB", "WR", "TE", "K"];
export const DATA_SEASON = DATASET.season;
export const SEASONS_USED = Object.keys(DATASET.sources);

export interface UniversePlayer {
  id: string;
  name: string;
  pos: Position;
  team: string;
  age: number;
  /** Season fantasy-point totals acting as sources (real + deterministic spread). */
  src: number[];
  /** How many real seasons back this player's sources. */
  nSrc: number;
  robust: number;
  mean: number;
  sdPts: number;
  posRank: number;
  risk: number;
  /** Per-game baseline for the weekly what-if model. */
  base: number;
  /** Weekly standard deviation for the Monte Carlo sim. */
  wsd: number;
  windSens: number;
}

/* deterministic RNG (also used by the Monte Carlo sim in the UI) */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function strHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const WIND_SENS: Record<string, number> = { QB: 0.85, RB: 0.3, WR: 0.95, TE: 0.95, K: 0.95 };

function weeklySd(pos: string, base: number): number {
  if (pos === "QB") return 4.5 + 0.18 * base;
  if (pos === "RB") return 3.0 + 0.28 * base;
  if (pos === "WR") return 3.0 + 0.32 * base;
  if (pos === "TE") return 2.5 + 0.3 * base;
  if (pos === "K") return 3.0;
  return 3.0;
}

/* A single real season gets a deterministic spread of pseudo-sources around
 * its anchor, so the robust-average machinery still has something to chew. */
function synthSources(anchor: number, id: string, n: number, vol: number): number[] {
  const out = [anchor];
  const rng = mulberry32(strHash(id) + 777);
  for (let i = 1; i < n; i++) out.push(Math.max(1, anchor * (1 + (rng() + rng() - 1) * vol * 2.2)));
  return out;
}

function buildUniverse(): UniversePlayer[] {
  const players: UniversePlayer[] = DATASET.players.map((raw) => {
    const real = Object.keys(raw.sources)
      .sort()
      .map((season) => computePoints(raw.pos, raw.sources[season], DEFAULT_SCORING))
      .filter((pts) => pts > 0);
    const anchor = real.length ? real : [1];
    const src = anchor.length >= 2 ? anchor : synthSources(anchor[0], raw.id, 5, 0.09);
    return {
      id: raw.id,
      name: raw.player,
      pos: raw.pos,
      team: raw.team,
      age: (raw as { age?: number }).age ?? 26,
      src,
      nSrc: real.length,
      robust: pseudoMedian(src),
      mean: mean(src),
      sdPts: mad(src),
      posRank: 0,
      risk: 5,
      base: 0,
      wsd: 0,
      windSens: WIND_SENS[raw.pos] ?? 0.5,
    };
  });

  POS_LIST.forEach((pos) => {
    players
      .filter((p) => p.pos === pos)
      .sort((a, b) => b.robust - a.robust)
      .forEach((p, i) => {
        p.posRank = i + 1;
      });
  });

  // Risk.R: z-score the source spread within position, rescale to mean 5 / sd 2.
  POS_LIST.forEach((pos) => {
    const group = players.filter((p) => p.pos === pos);
    if (group.length < 2) return;
    const m = mean(group.map((p) => p.sdPts));
    const s = sd(group.map((p) => p.sdPts)) || 1;
    group.forEach((p) => {
      p.risk = (p.sdPts - m) / s;
    });
  });
  const zs = players.map((p) => p.risk);
  const zm = mean(zs);
  const zsd = sd(zs) || 1;
  players.forEach((p) => {
    p.risk = (p.risk * 2) / zsd + (5 - zm);
    p.base = p.robust / GAMES;
    p.wsd = weeklySd(p.pos, p.base);
  });

  return players;
}

export const UNIVERSE = buildUniverse();
export const BY_ID = new Map(UNIVERSE.map((p) => [p.id, p]));
export const label = (p: UniversePlayer) => `${p.name} (${p.pos}, ${p.team})`;
export const BY_LABEL = new Map(UNIVERSE.map((p) => [label(p), p.id]));

export const POS_SORTED: Record<string, UniversePlayer[]> = {};
POS_LIST.forEach((pos) => {
  POS_SORTED[pos] = UNIVERSE.filter((p) => p.pos === pos).sort((a, b) => b.robust - a.robust);
});

export const N_MULTI = UNIVERSE.filter((p) => p.nSrc >= 2).length;
export const N_SINGLE = UNIVERSE.filter((p) => p.nSrc === 1).length;
export const DEFAULT_A = POS_SORTED.RB[0].id;
export const DEFAULT_B = POS_SORTED.RB[1].id;
