import { NextResponse } from "next/server";
import { DATASET } from "@/lib/fantasy";

export const dynamic = "force-dynamic";

/* Real ESPN average draft position, fetched server-side from ESPN's public
 * players endpoint (no cookies needed) and cached for six hours -- ADP
 * moves slowly. The Draft Room overlays this onto the bundled dataset so
 * the survival math models what drafters actually do, not what experts
 * rank. ESPN_MOCK=1 serves the bundled consensus ranks as pseudo-ADP so
 * the wiring can be exercised offline. */

const TTL_MS = 6 * 60 * 60 * 1000;

interface AdpPayload {
  ok: true;
  syncedAt: number;
  season: number;
  source: "espn" | "mock";
  /** espnId -> average draft position. */
  adp: Record<string, number>;
}

let cache: { at: number; body: AdpPayload } | null = null;

function mockPayload(season: number): AdpPayload {
  const adp: Record<string, number> = {};
  for (const p of DATASET.players) {
    const ecr = (p as { model?: { ecr?: number } }).model?.ecr;
    const espnId = (p as { espnId?: number }).espnId;
    if (ecr != null && espnId) adp[String(espnId)] = ecr;
  }
  return { ok: true, syncedAt: Date.now(), season, source: "mock", adp };
}

export async function GET() {
  const season = Number(process.env.ESPN_SEASON) || 2026;

  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.body, { headers: { "Cache-Control": "no-store" } });
  }

  if (process.env.ESPN_MOCK === "1") {
    const body = mockPayload(season);
    cache = { at: Date.now(), body };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  }

  const url =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}` +
    `/players?scoringPeriodId=0&view=kona_player_info`;
  const filter = { players: { limit: 1000, sortPercOwned: { sortAsc: false, sortPriority: 1 } } };

  let rows: unknown;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "x-fantasy-filter": JSON.stringify(filter) },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `ESPN returned ${res.status}.` }, { status: 502 });
    }
    rows = await res.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Could not reach ESPN." }, { status: 502 });
  }

  const adp: Record<string, number> = {};
  const list = Array.isArray(rows) ? rows : ((rows as { players?: unknown[] })?.players ?? []);
  for (const r of list) {
    const p = ((r as { player?: unknown }).player ?? r) as {
      id?: number;
      ownership?: { averageDraftPosition?: number };
    };
    const a = p?.ownership?.averageDraftPosition;
    if (p?.id && a && a >= 1 && a <= 500) adp[String(p.id)] = Math.round(a * 10) / 10;
  }

  const body: AdpPayload = { ok: true, syncedAt: Date.now(), season, source: "espn", adp };
  cache = { at: Date.now(), body };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
