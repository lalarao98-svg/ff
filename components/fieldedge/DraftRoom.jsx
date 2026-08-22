"use client";
import { useEffect, useMemo, useState } from "react";
import { BOARD, advanceToMyPick, isMyPick, recommend, simulateDraft, teamOnClock } from "@/lib/fantasy/draft";
import { BY_ID, label } from "@/lib/fantasy/universe";
import { SectionBar, SliderRow, Stat, T } from "./atoms";

const STORE_KEY = "fieldedge-draft-room";

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

  useEffect(() => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ teams, slot, rounds, picks }));
    } catch {
      /* storage unavailable: the room still works, it just won't survive a reload */
    }
  }, [teams, slot, rounds, picks]);

  const cfg = { teams, slot: Math.min(slot, teams), rounds };
  const total = teams * rounds;
  const onClock = picks.length;
  const done = onClock >= total;
  const myTurn = !done && isMyPick(onClock, cfg);
  const clockTeam = done ? -1 : teamOnClock(onClock, teams);
  const round = Math.floor(onClock / teams) + 1;

  const rec = useMemo(
    () => (!done && myTurn ? recommend(cfg, picks) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teams, slot, rounds, picks, done, myTurn],
  );
  const outlookPlain = useMemo(
    () => simulateDraft(cfg, picks),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teams, slot, rounds, picks],
  );
  // On your turn, show the plan that follows the top recommendation.
  const outlook = rec?.baseline ?? outlookPlain;

  const takenIds = useMemo(() => new Set(picks.map((p) => p.playerId)), [picks]);
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return BOARD.filter((p) => !takenIds.has(p.id) && p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [query, takenIds]);

  const record = (playerId) => {
    if (done) return;
    setPicks((ps) => [...ps, { overall: ps.length, team: teamOnClock(ps.length, teams), playerId }]);
    setQuery("");
  };
  const autoToMyTurn = () => setPicks((ps) => [...ps, ...advanceToMyPick(cfg, ps)]);
  const undo = () => setPicks((ps) => ps.slice(0, -1));
  const reset = () => setPicks([]);

  const myRoster = picks
    .filter((p) => p.team === cfg.slot - 1)
    .map((p) => BY_ID.get(p.playerId))
    .filter(Boolean);

  const cell = { fontSize: 12, padding: "6px 4px", borderBottom: "1px solid " + T.hair };
  const btn = {
    background: T.paper, border: "1px solid " + T.black, color: T.black, borderRadius: 2,
    padding: "8px 12px", cursor: "pointer", fontSize: 11, fontFamily: "'Calibre','Inter',Arial,sans-serif",
    fontWeight: 500,
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 48, marginTop: 40 }}>
      {/* -------- left: setup + controls -------- */}
      <div style={{ flex: "1 1 300px", minWidth: 280 }}>
        <SectionBar num="01" title="Draft Setup" />
        <div className="display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 24 }}>Your seat</div>
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
        <SectionBar num="02" title="Draft Room" />
        <div className="display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.05, marginBottom: 8 }}>
          {done ? "Draft complete" : `Pick ${onClock + 1} of ${total} — round ${round}`}
        </div>
        <div className="data" style={{ fontSize: 12, color: myTurn ? T.red : T.warmGray, fontWeight: myTurn ? 700 : 400, marginBottom: 16 }}>
          {done ? "Every seat is filled." : myTurn ? "YOU ARE ON THE CLOCK" : `Team ${clockTeam + 1} is on the clock`}
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
          <Stat label="Projected roster value" value={outlook.value.toFixed(0)} sub="starters full + bench discounted" marker />
          <Stat label="My picks made" value={`${myRoster.length} / ${rounds}`} />
          <Stat label="Players off the board" value={picks.length} />
        </div>

        {/* record an actual pick for whoever is on the clock */}
        {!done && (
          <div style={{ marginBottom: 24 }}>
            <div className="subhead" style={{ marginBottom: 6 }}>
              Record what actually happened — {myTurn ? "your pick" : `team ${clockTeam + 1}'s pick`}
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
            <table style={{ width: "100%", borderCollapse: "collapse" }} className="data">
              <thead>
                <tr>
                  {["", "Player", "Pos", "Proj", "Final value", "Cost of waiting", ""].map((h, i) => (
                    <th key={i} style={{ ...cell, borderBottom: "1px solid " + T.black, textAlign: i >= 3 && i <= 5 ? "right" : "left", fontSize: 11, fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rec.candidates.slice(0, 8).map((c, i) => (
                  <tr key={c.p.id} style={{ background: i === 0 ? "rgba(240,62,62,0.06)" : "transparent" }}>
                    <td style={{ ...cell, color: T.warmGray, width: 24 }}>{i + 1}</td>
                    <td style={{ ...cell, fontWeight: i === 0 ? 700 : 500 }}>
                      {c.p.name}
                      {c.p.injPart ? <span title={"returning from " + c.p.injPart} style={{ color: T.flag }}> †</span> : null}
                    </td>
                    <td style={{ ...cell, color: T.warmGray }}>{c.p.pos}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{c.p.proj.toFixed(0)}</td>
                    <td style={{ ...cell, textAlign: "right", fontWeight: i === 0 ? 700 : 400 }}>{c.finalValue.toFixed(0)}</td>
                    <td style={{ ...cell, textAlign: "right", color: c.waitCost > 25 ? T.flag : T.warmGray }}>{c.waitCost.toFixed(0)}</td>
                    <td style={{ ...cell, textAlign: "right" }}>
                      <button onClick={() => record(c.p.id)} style={{ ...btn, padding: "4px 10px", background: i === 0 ? T.black : T.paper, color: i === 0 ? T.paper : T.black }}>Draft</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="data" style={{ fontSize: 9, color: T.warmGray, marginTop: 4 }}>
              Final value: your completed roster if you take this player now and everything else follows the
              model. Cost of waiting: projected points lost at this position by passing until your next turn.
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
                    <td style={{ ...cell, textAlign: "right", width: 56 }}>{s.p.proj.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* pick log */}
        {picks.length > 0 && (
          <div>
            <div className="subhead" style={{ marginBottom: 8 }}>Pick log</div>
            <table style={{ width: "100%", borderCollapse: "collapse" }} className="data">
              <tbody>
                {[...picks].slice(-14).reverse().map((pk) => {
                  const p = BY_ID.get(pk.playerId);
                  const mine = pk.team === cfg.slot - 1;
                  return (
                    <tr key={pk.overall}>
                      <td style={{ ...cell, color: T.warmGray, width: 60 }}>#{pk.overall + 1}</td>
                      <td style={{ ...cell, color: mine ? T.red : T.warmGray, width: 70, fontWeight: mine ? 700 : 400 }}>{mine ? "YOU" : `Team ${pk.team + 1}`}</td>
                      <td style={{ ...cell, fontWeight: 500 }}>{p ? p.name : pk.playerId}</td>
                      <td style={{ ...cell, color: T.warmGray, width: 40 }}>{p?.pos ?? ""}</td>
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
