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
  /** Headline projection: backtested model blended 50/50 with market consensus. */
  proj: number;
  /** Pure model projection (before the market blend). */
  modelProj: number;
  projPg: number;
  expGames: number;
  ageMult: number;
  injMult: number;
  injPart: string | null;
  /** FantasyPros redraft-overall expert consensus rank (null if unranked). */
  ecr: number | null;
  /** Expert disagreement on that rank. */
  ecrSd: number | null;
  /** ESPN player id (live draft sync). */
  espnId: number | null;
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

interface RawExtras {
  age?: number;
  wsd?: number;
  espnId?: number;
}

interface ModelFields {
  proj: number;
  projPg: number;
  expGames: number;
  ageMult: number;
  injMult: number;
  injPart?: string;
  blend?: number;
  ecr?: number;
  ecrSd?: number;
}

function buildUniverse(): UniversePlayer[] {
  const players: UniversePlayer[] = DATASET.players.map((raw) => {
    const real = Object.keys(raw.sources)
      .sort()
      .map((season) => computePoints(raw.pos, raw.sources[season], DEFAULT_SCORING))
      .filter((pts) => pts > 0);
    const anchor = real.length ? real : [1];
    const src = anchor.length >= 2 ? anchor : synthSources(anchor[0], raw.id, 5, 0.09);
    const robust = pseudoMedian(src);
    const model = (raw as { model?: ModelFields }).model;
    return {
      id: raw.id,
      name: raw.player,
      pos: raw.pos,
      team: raw.team,
      age: (raw as { age?: number }).age ?? 26,
      src,
      nSrc: real.length,
      robust,
      proj: model?.blend ?? model?.proj ?? robust,
      modelProj: model?.proj ?? robust,
      projPg: model?.projPg ?? robust / GAMES,
      expGames: model?.expGames ?? GAMES,
      ageMult: model?.ageMult ?? 1,
      injMult: model?.injMult ?? 1,
      injPart: model?.injPart ?? null,
      ecr: model?.ecr ?? null,
      ecrSd: model?.ecrSd ?? null,
      espnId: (raw as RawExtras).espnId ?? null,
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
      .sort((a, b) => b.proj - a.proj)
      .forEach((p, i) => {
        p.posRank = i + 1;
      });
  });

  // Risk.R's two signals, z-scored within position then averaged: how much a
  // player's seasons disagree with each other, and how much the experts
  // disagree about him. Rescaled below to mean 5 / sd 2.
  POS_LIST.forEach((pos) => {
    const group = players.filter((p) => p.pos === pos);
    if (group.length < 2) return;
    const mPts = mean(group.map((p) => p.sdPts));
    const sPts = sd(group.map((p) => p.sdPts)) || 1;
    const withEcr = group.filter((p) => p.ecrSd != null);
    const mEcr = withEcr.length > 2 ? mean(withEcr.map((p) => p.ecrSd!)) : 0;
    const sEcr = withEcr.length > 2 ? sd(withEcr.map((p) => p.ecrSd!)) || 1 : 1;
    group.forEach((p) => {
      const zPts = (p.sdPts - mPts) / sPts;
      p.risk = p.ecrSd != null && withEcr.length > 2
        ? (zPts + (p.ecrSd - mEcr) / sEcr) / 2
        : zPts;
    });
  });
  const rawById = new Map(DATASET.players.map((r) => [r.id, r as { wsd?: number }]));
  const zs = players.map((p) => p.risk);
  const zm = mean(zs);
  const zsd = sd(zs) || 1;
  players.forEach((p) => {
    p.risk = (p.risk * 2) / zsd + (5 - zm);
    // Returning from a major injury: the comp multiplier moves the mean a
    // little; the real information is uncertainty, so widen risk too.
    if (p.injMult < 1) p.risk += (1 - p.injMult) * 5;
    p.base = p.projPg;
    p.wsd = rawById.get(p.id)?.wsd ?? weeklySd(p.pos, p.base);
  });

  return players;
}

export const UNIVERSE = buildUniverse();
export const BY_ID = new Map(UNIVERSE.map((p) => [p.id, p]));
export const label = (p: UniversePlayer) => `${p.name} (${p.pos}, ${p.team})`;
export const BY_LABEL = new Map(UNIVERSE.map((p) => [label(p), p.id]));

export const POS_SORTED: Record<string, UniversePlayer[]> = {};
POS_LIST.forEach((pos) => {
  POS_SORTED[pos] = UNIVERSE.filter((p) => p.pos === pos).sort((a, b) => b.proj - a.proj);
});

export const N_MULTI = UNIVERSE.filter((p) => p.nSrc >= 2).length;
export const N_SINGLE = UNIVERSE.filter((p) => p.nSrc === 1).length;
export const DEFAULT_A = POS_SORTED.RB[0].id;
export const DEFAULT_B = POS_SORTED.RB[1].id;
