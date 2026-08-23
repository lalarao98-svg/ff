"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BOARD, advanceToMyPick, isMyPick, myPickNumbers, planExpected, recommend, teamOnClock } from "@/lib/fantasy/draft";
import { BY_ID, UNIVERSE, label } from "@/lib/fantasy/universe";
import { SectionBar, SliderRow, Stat, T } from "./atoms";

const STORE_KEY = "fieldedge-draft-room";
const POLL_MS = 2500;

const ESPN_TO_ID = new Map(UNIVERSE.filter((p) => p.espnId != null).map((p) => [p.espnId, p.id]));

function loadSaved() {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(window.localStorage.getItem(STORE_KEY) || "null");
  } catch {
    return null;
  }
}

export default function DraftRoom() {
  const saved = useMemo(() => loadSaved(), []);
  const [teams, setTeams] = useState(saved?.teams ?? 10);
  const [slot, setSlot] = useState(saved?.slot ?? 5);
  const [rounds, setRounds] = useState(saved?.rounds ?? 15);
  const [picks, setPicks] = useState(saved?.picks ?? []);
  const [query, setQuery] = useState("");

  /* ---------------- ESPN live sync ---------------- */
  const [liveOn, setLiveOn] = useState(saved?.liveOn ?? false);
  const [myTeamId, setMyTeamId] = useState(saved?.myTeamId ?? null);
  const [live, setLive] = useState(null); // last payload from /api/espn-draft
  const [liveStatus, setLiveStatus] = useState("off"); // off | connecting | connected | error
  const [liveError, setLiveError] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const syncing = useRef(false);

  const syncNow = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      const res = await fetch("/api/espn-draft", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `sync failed (${res.status})`);
      setLive(data);
      setLiveStatus("connected");
      setLiveError(null);
      setLastSync(Date.now());
    } catch (e) {
      setLiveStatus("error");
      setLiveError(String(e.message || e));
    } finally {
      syncing.current = false;
    }
  }, []);

  useEffect(() => {
    if (!liveOn) return;
    const t0 = setTimeout(syncNow, 0); // first sync immediately, outside the effect body
    const t = setInterval(syncNow, POLL_MS);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [liveOn, syncNow]);

  const toggleLive = () => {
    setLiveOn((v) => {
      const next = !v;
      setLiveStatus(next ? "connecting" : "off");
      return next;
    });
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ teams, slot, rounds, picks, liveOn, myTeamId }));
    } catch {
      /* storage unavailable: the room still works, it just won't survive a reload */
    }
  }, [teams, slot, rounds, picks, liveOn, myTeamId]);

  /* Translate the ESPN feed into engine state. ESPN picks that map to no
   * ranked player (DSTs, deep stashes) still consume their draft slot via a
   * synthetic id, so the pick math stays aligned. */
  const liveReady = liveOn && liveStatus === "connected" && live && live.order?.length > 0;
  const liveSlot = liveReady && myTeamId != null ? live.order.indexOf(myTeamId) + 1 : 0;
  const liveActive = !!(liveReady && liveSlot > 0);

  const livePicks = useMemo(() => {
    if (!liveActive) return null;
    const teamIndex = new Map(live.order.map((id, i) => [id, i]));
    return live.picks.map((pk) => ({
      overall: pk.overall,
      team: teamIndex.get(pk.teamId) ?? teamOnClock(pk.overall, live.order.length),
      playerId: ESPN_TO_ID.get(pk.playerId) ?? `espn:${pk.playerId}`,
    }));
  }, [liveActive, live]);

  const effTeams = liveActive ? live.order.length : teams;
  const effSlot = liveActive ? liveSlot : Math.min(slot, teams);
  const effRounds = liveActive ? live.rounds : rounds;
  const effPicks = liveActive ? livePicks : picks;
  const unmapped = liveActive ? livePicks.filter((p) => String(p.playerId).startsWith("espn:")).length : 0;

  const cfg = { teams: effTeams, slot: effSlot, rounds: effRounds };
  const total = effTeams * effRounds;
  const onClock = effPicks.length;
  const done = onClock >= total;
  const myTurn = !done && isMyPick(onClock, cfg);
  const clockTeam = done ? -1 : teamOnClock(onClock, effTeams);
  const round = Math.floor(onClock / effTeams) + 1;
  const myNextOverall = useMemo(
    () => myPickNumbers(cfg).find((i) => i >= onClock) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effTeams, effSlot, effRounds, onClock],
  );

  const rec = useMemo(
    () => (!done && myTurn ? recommend(cfg, effPicks) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effTeams, effSlot, effRounds, effPicks, done, myTurn],
  );
  const outlookPlain = useMemo(
    () => planExpected(cfg, effPicks),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effTeams, effSlot, effRounds, effPicks],
  );
  // On your turn, show the plan that follows the top recommendation.
  const outlook = rec?.baseline ?? outlookPlain;

  const takenIds = useMemo(() => new Set(effPicks.map((p) => p.playerId)), [effPicks]);
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return BOARD.filter((p) => !takenIds.has(p.id) && p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [query, takenIds]);

  const record = (playerId) => {
    if (done || liveActive) return;
    setPicks((ps) => [...ps, { overall: ps.length, team: teamOnClock(ps.length, teams), playerId }]);
    setQuery("");
  };
  const autoToMyTurn = () => setPicks((ps) => [...ps, ...advanceToMyPick(cfg, ps)]);
  const undo = () => setPicks((ps) => ps.slice(0, -1));
  const reset = () => setPicks([]);

  const myRoster = effPicks
    .filter((p) => p.team === cfg.slot - 1)
    .map((p) => BY_ID.get(p.playerId))
    .filter(Boolean);

  const teamName = (idx) => {
    if (liveActive) {
      const id = live.order[idx];
      return live.teams.find((t) => t.id === id)?.abbrev ?? `Team ${idx + 1}`;
    }
    return `Team ${idx + 1}`;
  };

  const cell = { fontSize: 12, padding: "6px 4px", borderBottom: "1px solid " + T.hair };
  const btn = {
    background: T.paper, border: "1px solid " + T.black, color: T.black, borderRadius: 2,
    padding: "8px 12px", cursor: "pointer", fontSize: 11, fontFamily: "'Calibre','Inter',Arial,sans-serif",
    fontWeight: 500,
  };
  const dot = (color) => ({ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block", marginRight: 6 });
  const statusColor = liveStatus === "connected" ? T.pos : liveStatus === "error" ? T.neg : liveStatus === "connecting" ? T.flag : T.warmGray;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 48, marginTop: 40 }}>
      {/* -------- left: setup + controls -------- */}
      <div style={{ flex: "1 1 300px", minWidth: 280 }}>
        <SectionBar num="01" title="ESPN Live Sync" />
        <div className="display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Real draft, live</div>
        <div className="data" style={{ fontSize: 12, marginBottom: 8 }}>
          <span style={dot(statusColor)} />
          {liveStatus === "off" && "Not connected"}
          {liveStatus === "connecting" && "Connecting…"}
          {liveStatus === "connected" && `Connected — league ${live?.leagueId}${live?.inProgress ? " · draft in progress" : live?.drafted ? " · draft complete" : " · pre-draft"}`}
          {liveStatus === "error" && (liveError || "Connection error")}
        </div>
        {lastSync && liveOn && (
          <div className="data" style={{ fontSize: 10, color: T.warmGray, marginBottom: 8 }}>
            Last sync {new Date(lastSync).toLocaleTimeString()} · polling every {POLL_MS / 1000}s
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <button
            onClick={toggleLive}
            style={{ ...btn, background: liveOn ? T.paper : T.black, color: liveOn ? T.black : T.paper, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 10 }}>
            {liveOn ? "Disconnect" : "Connect to ESPN"}
          </button>
          {liveOn && <button style={btn} onClick={syncNow}>Sync now</button>}
        </div>
        {liveReady && (
          <div style={{ marginBottom: 16 }}>
            <div className="subhead" style={{ marginBottom: 6 }}>Which team is yours?</div>
            <select
              value={myTeamId ?? ""}
              onChange={(e) => setMyTeamId(e.target.value ? Number(e.target.value) : null)}
              className="data"
              aria-label="Select your ESPN team"
              style={{ width: "100%", padding: "8px 10px", fontSize: 13, background: T.paper, border: "1px solid " + T.black, borderRadius: 2 }}>
              <option value="">— pick your team —</option>
              {live.teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.abbrev})</option>
              ))}
            </select>
          </div>
        )}
        {liveActive && unmapped > 0 && (
          <div className="data" style={{ fontSize: 10, color: T.flag, marginBottom: 12 }}>
            {unmapped} ESPN pick{unmapped > 1 ? "s" : ""} (D/ST or unranked players) hold their draft slots but
            match no ranked player.
          </div>
        )}
        <p className="body-serif" style={{ margin: "0 0 20px" }}>
          {liveActive
            ? "The room mirrors your real ESPN draft: league size, your slot, and every selection come from the live feed, and recommendations recompute on each new pick."
            : "Connect during your real ESPN draft and the room follows it automatically. Or run it manually below."}
        </p>

        <SectionBar num="02" title="Draft Setup" />
        <div className="display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 24 }}>
          {liveActive ? "Your seat (from ESPN)" : "Your seat"}
        </div>
        {liveActive ? (
          <div className="data" style={{ fontSize: 12, marginBottom: 16, lineHeight: 1.8 }}>
            {live.order.length} teams · you draft from slot {liveSlot} · {live.rounds} rounds
          </div>
        ) : (
          <>
            <SliderRow label="Teams" value={teams} min={8} max={14}
              onChange={(v) => { setTeams(v); setSlot((sl) => Math.min(sl, v)); setPicks([]); }} />
            <SliderRow label="Your pick" value={Math.min(slot, teams)} min={1} max={teams}
              fmt={(v) => `slot ${v} of ${teams}`} onChange={(v) => { setSlot(v); setPicks([]); }} />
            <SliderRow label="Rounds" value={rounds} min={7} max={17}
              onChange={(v) => { setRounds(v); setPicks([]); }} />
            <p className="body-serif" style={{ margin: "0 0 16px" }}>
              Opponents are assumed to take the best available player by market consensus (FantasyPros
              ECR), with light roster sense — no second QB or TE early, kickers at the end. Every pick
              you record replaces that assumption, and the whole plan re-optimizes.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
              {!myTurn && !done && <button style={{ ...btn, background: T.black, color: T.paper, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 10 }} onClick={autoToMyTurn}>Auto-pick to my turn</button>}
              <button style={btn} onClick={undo} disabled={!picks.length}>Undo</button>
              <button style={btn} onClick={reset} disabled={!picks.length}>Reset draft</button>
            </div>
          </>
        )}

        <div className="subhead" style={{ marginBottom: 6 }}>My roster ({myRoster.length})</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }} className="data">
          <tbody>
            {outlook.lineup.map(({ slot: sl, p }) => (
              <tr key={sl + p.id}>
                <td style={{ ...cell, color: T.warmGray, width: 48 }}>{sl}</td>
                <td style={{ ...cell, fontWeight: myRoster.some((m) => m.id === p.id) ? 700 : 400, color: myRoster.some((m) => m.id === p.id) ? T.black : T.warmGray }}>
                  {p.name}{myRoster.some((m) => m.id === p.id) ? "" : " *"}
                </td>
                <td style={{ ...cell, textAlign: "right" }}>{p.proj.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="data" style={{ fontSize: 9, color: T.warmGray, marginTop: 4 }}>
          * projected, not yet drafted. Bench players beyond the lineup are counted at a discount.
        </div>
      </div>

      {/* -------- right: the room -------- */}
      <div style={{ flex: "2 1 480px", minWidth: 320 }}>
        <SectionBar num="03" title="Draft Room" />
        <div className="display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.05, marginBottom: 8 }}>
          {done ? "Draft complete" : `Pick ${onClock + 1} of ${total} — round ${round}`}
        </div>
        <div className="data" style={{ fontSize: 12, color: myTurn ? T.red : T.warmGray, fontWeight: myTurn ? 700 : 400, marginBottom: 16 }}>
          {done ? "Every seat is filled." : myTurn ? "YOU ARE ON THE CLOCK" : `${teamName(clockTeam)} is on the clock`}
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
          <Stat label="Projected roster value" value={outlook.value.toFixed(0)} sub="starters full + bench discounted" marker />
          <Stat label="Current pick" value={done ? "—" : `#${onClock + 1}`} sub={done ? "" : `round ${round}`} />
          <Stat label="My next pick" value={myNextOverall != null ? `#${myNextOverall + 1}` : "—"} sub={myNextOverall != null ? `${myNextOverall - onClock} picks away` : "none left"} />
          <Stat label="Off the board" value={effPicks.length} />
        </div>

        {/* record an actual pick (manual mode only — ESPN feeds picks when live) */}
        {!done && !liveActive && (
          <div style={{ marginBottom: 24 }}>
            <div className="subhead" style={{ marginBottom: 6 }}>
              Record what actually happened — {myTurn ? "your pick" : `${teamName(clockTeam)}'s pick`}
            </div>
            <input value={query} onChange={(e) => setQuery(e.target.value)} className="data"
              placeholder="Type a player name…" aria-label="Record a pick"
              style={{ width: "100%", boxSizing: "border-box", background: T.paper, border: "1px solid " + T.black, borderRadius: 2, padding: "8px 10px", fontSize: 13 }} />
            {searchResults.length > 0 && (
              <div style={{ border: "1px solid " + T.hair, borderTop: "none" }}>
                {searchResults.map((p) => (
                  <button key={p.id} onClick={() => record(p.id)}
                    style={{ display: "block", width: "100%", textAlign: "left", background: T.paper, border: "none", borderBottom: "1px solid " + T.hair, padding: "7px 10px", cursor: "pointer", fontSize: 12, fontFamily: "'Calibre','Inter',Arial,sans-serif" }}>
                    {label(p)} <span style={{ color: T.warmGray }}>· proj {p.proj.toFixed(0)}{p.ecr != null ? ` · ECR ${p.ecr.toFixed(0)}` : ""}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* recommendations at my pick */}
        {myTurn && rec && (
          <div style={{ marginBottom: 28 }}>
            <div className="subhead" style={{ marginBottom: 8 }}>Recommended — ranked by final roster value</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }} className="data">
                <thead>
                  <tr>
                    {["", "Player", "Pos", "Proj", "VOR", "± Mkt", "Edge", "P(next)", "Final", "Wait", ""].map((h, i) => (
                      <th key={i} style={{ ...cell, borderBottom: "1px solid " + T.black, textAlign: i >= 3 && i <= 9 ? "right" : "left", fontSize: 11, fontWeight: 500, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rec.candidates.slice(0, 8).map((c, i) => (
                    <tr key={c.p.id} style={{ background: i === 0 ? "rgba(240,62,62,0.06)" : "transparent" }}>
                      <td style={{ ...cell, color: T.warmGray, width: 20 }}>{i + 1}</td>
                      <td style={{ ...cell, fontWeight: i === 0 ? 700 : 500, whiteSpace: "nowrap" }}>
                        {c.p.name}
                        {c.p.injPart ? <span title={"returning from " + c.p.injPart} style={{ color: T.flag }}> †</span> : null}
                      </td>
                      <td style={{ ...cell, color: T.warmGray }}>{c.p.pos}</td>
                      <td style={{ ...cell, textAlign: "right" }}>{c.p.proj.toFixed(0)}</td>
                      <td style={{ ...cell, textAlign: "right" }}>{c.vor.toFixed(0)}</td>
                      <td style={{ ...cell, textAlign: "right", color: c.adpDelta == null ? T.warmGray : c.adpDelta >= 0 ? T.pos : T.neg }}>
                        {c.adpDelta == null ? "—" : (c.adpDelta >= 0 ? "+" : "") + c.adpDelta}
                      </td>
                      <td style={{ ...cell, textAlign: "right", color: c.p.edge == null ? T.warmGray : c.p.edge >= 0 ? T.pos : T.neg }}>
                        {c.p.edge == null ? "—" : (c.p.edge >= 0 ? "+" : "") + c.p.edge.toFixed(0)}
                      </td>
                      <td style={{ ...cell, textAlign: "right", color: c.survival != null && c.survival >= 0.6 ? T.pos : T.warmGray }}>
                        {c.survival == null ? "—" : Math.round(c.survival * 100) + "%"}
                      </td>
                      <td style={{ ...cell, textAlign: "right", fontWeight: i === 0 ? 700 : 400 }}>{c.finalValue.toFixed(0)}</td>
                      <td style={{ ...cell, textAlign: "right", color: c.waitCost > 25 ? T.flag : T.warmGray }}>{c.waitCost.toFixed(0)}</td>
                      <td style={{ ...cell, textAlign: "right" }}>
                        {!liveActive && (
                          <button onClick={() => record(c.p.id)} style={{ ...btn, padding: "4px 10px", background: i === 0 ? T.black : T.paper, color: i === 0 ? T.paper : T.black }}>Draft</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="data" style={{ fontSize: 9, color: T.warmGray, marginTop: 4 }}>
              VOR: points above positional replacement. ± Mkt: picks of value vs consensus (negative = reach).
              Edge: the usage-regression&rsquo;s points vs the market price (RB/WR/TE; positive = undervalued).
              P(next): chance he survives to your next pick. Final: your completed roster if you take him now.
              Wait: points lost at his position by passing until your next turn. Players the market prices
              well after this pick rank below the in-reach names — P(next) says how safely you can wait.
              {liveActive ? " Make the pick in ESPN — it lands here on the next sync." : ""}
            </div>
          </div>
        )}

        {/* the plan */}
        {!done && outlook.plan.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div className="subhead" style={{ marginBottom: 8 }}>Projected plan for your remaining picks</div>
            <table style={{ width: "100%", borderCollapse: "collapse" }} className="data">
              <tbody>
                {outlook.plan.map((s) => (
                  <tr key={s.overall}>
                    <td style={{ ...cell, color: T.warmGray, width: 90 }}>R{s.round} · #{s.overall + 1}</td>
                    <td style={{ ...cell, fontWeight: 500 }}>{s.p.name}</td>
                    <td style={{ ...cell, color: T.warmGray, width: 40 }}>{s.p.pos}</td>
                    <td style={{ ...cell, textAlign: "right", color: T.warmGray, width: 70, whiteSpace: "nowrap" }}>
                      {s.ecr != null ? `ADP ${Math.round(s.ecr)}` : ""}
                    </td>
                    <td style={{ ...cell, textAlign: "right", width: 56 }}>{s.p.proj.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="data" style={{ fontSize: 9, color: T.warmGray, marginTop: 4 }}>
              Each row is the expected value of that pick; the player named is who it most likely lands,
              with his market consensus rank (ADP) — the plan never reaches far ahead of it.
            </div>
          </div>
        )}

        {/* pick log */}
        {effPicks.length > 0 && (
          <div>
            <div className="subhead" style={{ marginBottom: 8 }}>Pick log</div>
            <table style={{ width: "100%", borderCollapse: "collapse" }} className="data">
              <tbody>
                {[...effPicks].slice(-14).reverse().map((pk) => {
                  const p = BY_ID.get(pk.playerId);
                  const mine = pk.team === cfg.slot - 1;
                  return (
                    <tr key={pk.overall}>
                      <td style={{ ...cell, color: T.warmGray, width: 60 }}>#{pk.overall + 1}</td>
                      <td style={{ ...cell, color: mine ? T.red : T.warmGray, width: 90, fontWeight: mine ? 700 : 400 }}>{mine ? "YOU" : teamName(pk.team)}</td>
                      <td style={{ ...cell, fontWeight: 500 }}>{p ? p.name : `ESPN player ${String(pk.playerId).replace("espn:", "")}`}</td>
                      <td style={{ ...cell, color: T.warmGray, width: 40 }}>{p?.pos ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
