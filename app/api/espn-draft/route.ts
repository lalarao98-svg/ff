import { NextResponse } from "next/server";
import { DATASET } from "@/lib/fantasy";

export const dynamic = "force-dynamic";

/* Live ESPN Fantasy draft state, fetched server-side so the ESPN auth
 * cookies (ESPN_SWID / ESPN_S2) never reach the client. The client polls
 * this route; this route polls ESPN's v3 league endpoint with the
 * mDraftDetail, mSettings, mTeam, and mRoster views, cached for 2.5s so a
 * roomful of tabs cannot hammer ESPN. */

const DEFAULT_LEAGUE_ID = "872177723";
const POLL_MS = 2500;
const IR_SLOT = "21";

interface EspnPayload {
  ok: true;
  syncedAt: number;
  season: number;
  leagueId: string;
  inProgress: boolean;
  drafted: boolean;
  teams: { id: number; name: string; abbrev: string }[];
  /** teamIds in round-1 pick order. */
  order: number[];
  rounds: number;
  picks: { overall: number; teamId: number; playerId: number }[];
}

let cache: { at: number; body: EspnPayload } | null = null;
const MOCK_START = Date.now();

function mockPayload(season: number, leagueId: string): EspnPayload {
  // Deterministically growing mock draft for local development (ESPN_MOCK=1):
  // one new consensus pick every 8 seconds.
  const ranked = [...DATASET.players]
    .filter((p) => (p as { model?: { ecr?: number } }).model?.ecr != null && (p as { espnId?: number }).espnId)
    .sort((a, b) => (a as never as { model: { ecr: number } }).model.ecr - (b as never as { model: { ecr: number } }).model.ecr);
  const teams = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `Mock Team ${i + 1}`, abbrev: `MT${i + 1}` }));
  const order = teams.map((t) => t.id);
  const n = Math.min(150, 4 + Math.floor((Date.now() - MOCK_START) / 8000));
  const picks = ranked.slice(0, n).map((p, i) => {
    const round = Math.floor(i / 10);
    const j = i % 10;
    const teamIdx = round % 2 === 0 ? j : 9 - j;
    return { overall: i, teamId: order[teamIdx], playerId: (p as { espnId?: number }).espnId! };
  });
  return {
    ok: true, syncedAt: Date.now(), season, leagueId, inProgress: true, drafted: false,
    teams, order, rounds: 15, picks,
  };
}

export async function GET() {
  const season = Number(process.env.ESPN_SEASON) || 2026;
  const leagueId = process.env.ESPN_LEAGUE_ID || DEFAULT_LEAGUE_ID;

  if (cache && Date.now() - cache.at < POLL_MS) {
    return NextResponse.json(cache.body, { headers: { "Cache-Control": "no-store" } });
  }

  if (process.env.ESPN_MOCK === "1") {
    const body = mockPayload(season, leagueId);
    cache = { at: Date.now(), body };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  }

  const url =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}` +
    `/segments/0/leagues/${leagueId}?view=mDraftDetail&view=mSettings&view=mTeam&view=mRoster`;

  const headers: Record<string, string> = { Accept: "application/json" };
  // Private leagues need both cookies; these stay server-side only.
  if (process.env.ESPN_SWID && process.env.ESPN_S2) {
    headers.Cookie = `SWID=${process.env.ESPN_SWID}; espn_s2=${process.env.ESPN_S2}`;
  }

  let raw: {
    draftDetail?: { drafted?: boolean; inProgress?: boolean; picks?: { overallPickNumber?: number; teamId?: number; playerId?: number }[] };
    settings?: { draftSettings?: { pickOrder?: number[] }; rosterSettings?: { lineupSlotCounts?: Record<string, number> } };
    teams?: { id: number; name?: string; location?: string; nickname?: string; abbrev?: string }[];
  };
  try {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "ESPN rejected the request — for a private league set ESPN_SWID and ESPN_S2."
          : `ESPN returned ${res.status}.`;
      return NextResponse.json({ ok: false, error: hint }, { status: 502 });
    }
    raw = await res.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Could not reach ESPN." }, { status: 502 });
  }

  const slotCounts = raw.settings?.rosterSettings?.lineupSlotCounts ?? {};
  const rounds =
    Object.entries(slotCounts)
      .filter(([slot]) => slot !== IR_SLOT)
      .reduce((a, [, n]) => a + (n || 0), 0) || 16;

  const body: EspnPayload = {
    ok: true,
    syncedAt: Date.now(),
    season,
    leagueId,
    inProgress: !!raw.draftDetail?.inProgress,
    drafted: !!raw.draftDetail?.drafted,
    teams: (raw.teams ?? []).map((t) => ({
      id: t.id,
      name: t.name || [t.location, t.nickname].filter(Boolean).join(" ") || `Team ${t.id}`,
      abbrev: t.abbrev || String(t.id),
    })),
    order: raw.settings?.draftSettings?.pickOrder ?? [],
    rounds,
    picks: (raw.draftDetail?.picks ?? [])
      .filter((p) => p.playerId != null && p.teamId != null)
      .sort((a, b) => (a.overallPickNumber ?? 0) - (b.overallPickNumber ?? 0))
      .map((p, i) => ({ overall: (p.overallPickNumber ?? i + 1) - 1, teamId: p.teamId!, playerId: p.playerId! })),
  };

  cache = { at: Date.now(), body };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
