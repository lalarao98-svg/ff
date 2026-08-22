"use client";
import React, { useState, useMemo, useCallback } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  UNIVERSE, BY_ID, BY_LABEL, POS_SORTED, N_MULTI, N_SINGLE, DEFAULT_A, DEFAULT_B,
  CORE, POS_LIST, DATA_SEASON, SEASONS_USED, label, mulberry32, strHash,
} from "@/lib/fantasy/universe";
import BACKTEST from "@/lib/fantasy/data/backtest.json";

/* ============================================================
   FIELD EDGE - Fantasy Football Analytics
   House design system: paper white, black rules, red accent only.
   Player universe: the bundled nflverse-data dataset - each of the
   last three completed NFL regular seasons acts as one projection
   source; single-season players get a deterministic spread around
   their anchor (see lib/fantasy/universe.ts).
   Pipeline ported from FantasyFootballAnalyticsR:
   - Calculate League Projections.R -> Hodges-Lehmann robust average
   - Risk.R -> MAD across sources, z by position, rescaled mean 5 / sd 2
   - Value Over Replacement.R -> empirical baseline at replacement rank +/-1
   - League Settings.R -> replacement ranks QB ceil(T*1.7), RB/WR ceil(2.5T*1.4), TE ceil(1.3T)
   - Optimum Roster.R / Optimum Risk.R -> per-player risk cap, points-vs-risk frontier
   ============================================================ */

const INJURY = {
  healthy:      { label: "Healthy",      play: 0.99, eff: 1.00, sdMult: 1.00 },
  probable:     { label: "Probable",     play: 0.96, eff: 0.97, sdMult: 1.08 },
  questionable: { label: "Questionable", play: 0.72, eff: 0.88, sdMult: 1.25 },
  doubtful:     { label: "Doubtful",     play: 0.25, eff: 0.80, sdMult: 1.35 },
  out:          { label: "Out",          play: 0.00, eff: 0.00, sdMult: 1.00 },
};

const DEFAULT_SETTINGS = {
  injury: "healthy", ageShift: 0, windMph: 5, precip: "none", dome: false,
  oppDefRank: 16, teamTotal: 23, script: "neutral", snapDelta: 0,
  roleMult: 1, roleNote: null,
};

const T = {
  red: "#F03E3E", black: "#000000", warmGray: "#A39382", paper: "#FFFFFF",
  plum: "#522A45", lightBlue: "#B8C5D8", pink: "#E0BCB0", brightBlue: "#149FDA",
  gold: "#D5AB32", cat2: "#4497F9",
  pos: "#4F7A3D", neg: "#A8483D", flag: "#E08214",
  hair: "rgba(163,147,130,0.4)",
};

/* ---------- shared math ---------- */

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function quantile(sorted, q) {
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}


/* Replacement ranks per League Settings.R */
function replacementRanks(teams) {
  return {
    QB: Math.ceil(1 * teams * 1.7),
    RB: Math.ceil(2.5 * teams * 1.4),
    WR: Math.ceil(2.5 * teams * 1.4),
    TE: Math.ceil(1 * teams * 1.3),
  };
}

/* VOR.R: baseline = mean of model-projected points at replacement rank -1..+1, empirical */
function computeVOR(teams) {
  const repl = replacementRanks(teams);
  const baselines = {};
  CORE.forEach(pos => {
    const arr = POS_SORTED[pos];
    const rr = Math.min(repl[pos], arr.length - 2);
    baselines[pos] = (arr[rr - 2].proj + arr[rr - 1].proj + arr[rr].proj) / 3;
  });
  const rows = UNIVERSE.map(p => ({
    ...p,
    baseline: CORE.includes(p.pos) ? baselines[p.pos] : null,
    vor: CORE.includes(p.pos) ? p.proj - baselines[p.pos] : null,
  }));
  rows.sort((a, b) => (b.vor ?? -1e9) - (a.vor ?? -1e9));
  return { rows, repl };
}

/* Optimum Roster.R: per-player risk constraint -> filter then fill */
function optimizeRoster(riskCap) {
  const pool = pos => POS_SORTED[pos].filter(r => r.risk <= riskCap);
  const qb = pool("QB").slice(0, 1);
  const rb = pool("RB").slice(0, 2);
  const wr = pool("WR").slice(0, 2);
  const te = pool("TE").slice(0, 1);
  if (qb.length < 1 || rb.length < 2 || wr.length < 2 || te.length < 1) return null;
  const used = new Set([...qb, ...rb, ...wr, ...te].map(r => r.id));
  const flex = ["RB", "WR", "TE"].flatMap(pos => POS_SORTED[pos])
    .filter(r => r.risk <= riskCap && !used.has(r.id))
    .sort((a, b) => b.proj - a.proj)[0];
  if (!flex) return null;
  const roster = [...qb, ...rb, ...wr, ...te, flex];
  return { roster, total: roster.reduce((a, r) => a + r.proj, 0) };
}

function riskFrontier() {
  const risks = UNIVERSE.filter(p => CORE.includes(p.pos)).map(r => r.risk);
  const lo = Math.floor(Math.min(...risks) * 4) / 4;
  const hi = Math.ceil(Math.max(...risks) * 4) / 4;
  const pts = [];
  for (let cap = lo; cap <= hi + 1e-9; cap += 0.25) {
    const opt = optimizeRoster(cap);
    pts.push({ cap: cap.toFixed(2), total: opt ? opt.total : null });
  }
  return pts;
}
const FRONTIER = riskFrontier();
const RISK_LO = Number(FRONTIER[0].cap);
const RISK_HI = Number(FRONTIER[FRONTIER.length - 1].cap);

/* ---------- weekly what-if model ---------- */

function ageCurve(pos, age) {
  if (pos === "QB") {
    if (age < 23) return 0.88;
    if (age < 26) return 0.96;
    if (age <= 35) return 1.0;
    return Math.max(0.78, 1 - 0.02 * (age - 35));
  }
  if (pos === "RB") {
    if (age < 22) return 0.95;
    if (age <= 26) return 1.0;
    if (age <= 29) return 1 - 0.05 * (age - 26);
    return Math.max(0.5, 0.85 - 0.08 * (age - 29));
  }
  if (pos === "WR") {
    if (age < 23) return 0.93;
    if (age <= 29) return 1.0;
    return Math.max(0.6, 1 - 0.035 * (age - 29));
  }
  if (pos === "TE") {
    if (age < 24) return 0.9;
    if (age <= 30) return 1.0;
    return Math.max(0.62, 1 - 0.04 * (age - 30));
  }
  return 1.0;
}

function computeFactors(player, s) {
  const inj = INJURY[s.injury];
  const whatIfAge = player.age + s.ageShift;
  const ageMult = ageCurve(player.pos, whatIfAge) / ageCurve(player.pos, player.age);

  let windMult = 1, precipMult = 1;
  if (!s.dome) {
    if (s.windMph > 8) windMult = Math.max(0.7, 1 - (s.windMph - 8) * 0.012 * player.windSens);
    if (s.precip === "rain") precipMult = 1 - 0.07 * player.windSens + (player.pos === "RB" ? 0.03 : 0);
    if (s.precip === "snow") precipMult = 1 - 0.13 * player.windSens + (player.pos === "RB" ? 0.05 : 0);
  }

  const defMult = 1 + (s.oppDefRank - 16.5) * 0.0097;
  const envMult = 1 + (s.teamTotal - 23) * 0.02;
  let scriptMult = 1;
  if (s.script === "favored") scriptMult = player.pos === "RB" ? 1.07 : 0.97;
  if (s.script === "trailing") scriptMult = player.pos === "RB" ? 0.94 : 1.07;
  const snapMult = 1 + s.snapDelta / 100;
  const roleMult = s.roleMult ?? 1;

  const factors = [
    { key: "role",   label: s.roleNote ? "2026 role: " + s.roleNote : "2026 role (unchanged)", mult: roleMult },
    { key: "age",    label: "Age curve (" + whatIfAge + " y/o)", mult: ageMult },
    { key: "inj",    label: "Injury effectiveness",              mult: inj.eff || 1 },
    { key: "wind",   label: s.dome ? "Wind (dome)" : "Wind " + s.windMph + " mph", mult: windMult },
    { key: "precip", label: s.dome ? "Precipitation (dome)" : "Precipitation: " + s.precip, mult: precipMult },
    { key: "def",    label: "Opponent defense #" + s.oppDefRank, mult: defMult },
    { key: "env",    label: "Implied total " + s.teamTotal,      mult: envMult },
    { key: "script", label: "Game script",                       mult: scriptMult },
    { key: "snap",   label: "Snap share " + (s.snapDelta >= 0 ? "+" : "") + s.snapDelta + "%", mult: snapMult },
  ];

  const totalMult = factors.reduce((m, f) => m * f.mult, 1);
  return { factors, totalMult, playProb: inj.play, sdMult: inj.sdMult * (s.windMph > 15 && !s.dome ? 1.1 : 1) };
}

function simulate(player, s, nSims = 6000) {
  const rng = mulberry32(strHash(player.id) + 42);
  const { totalMult, playProb, sdMult } = computeFactors(player, s);
  const mean = player.base * totalMult;
  const sd = player.wsd * sdMult * Math.max(0.5, totalMult);
  const out = new Array(nSims);
  for (let i = 0; i < nSims; i++) {
    if (rng() > playProb) { out[i] = 0; continue; }
    const u1 = Math.max(rng(), 1e-9), u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    let v = mean + sd * z;
    if (rng() < 0.07) v += rng() * sd * 1.4;
    out[i] = Math.max(0, v);
  }
  return out;
}

function summarize(sims, base) {
  const sorted = [...sims].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sims.reduce((a, b) => a + b, 0) / n;
  return {
    mean,
    p10: quantile(sorted, 0.10), p50: quantile(sorted, 0.50), p90: quantile(sorted, 0.90),
    boom: sims.filter(v => v >= base * 1.25).length / n,
    bust: sims.filter(v => v < base * 0.5).length / n,
  };
}

function makeBins(simsA, simsB, nBins = 22) {
  const all = simsB ? simsA.concat(simsB) : simsA;
  const max = Math.max(10, quantile([...all].sort((a, b) => a - b), 0.985));
  const w = max / nBins;
  const bins = Array.from({ length: nBins }, (_, i) => ({
    x: (i * w + w / 2).toFixed(1), lo: i * w, a: 0, b: 0,
  }));
  const drop = (sims, key) => sims.forEach(v => {
    const i = Math.min(nBins - 1, Math.floor(v / w));
    bins[i][key] += 100 / sims.length;
  });
  drop(simsA, "a");
  if (simsB) drop(simsB, "b");
  return bins;
}

/* ---------- structural atoms ---------- */

function SectionBar({ num, title }) {
  return (
    <div>
      <div style={{ height: 8, background: T.black }} />
      <div style={{ height: 8 }} />
      <div className="eyebrow" style={{ color: T.red, marginBottom: 4 }}>{num} / {title}</div>
    </div>
  );
}

function SliderRow({ label, value, min, max, step = 1, onChange, fmt }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span className="subhead">{label}</span>
        <span className="data" style={{ fontWeight: 500 }}>{fmt ? fmt(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} style={{ width: "100%" }} aria-label={label} />
    </div>
  );
}

function Chip({ active, onClick, children, tone }) {
  return (
    <button onClick={onClick} className="chip"
      style={{
        background: active ? (tone || T.black) : T.paper,
        color: active ? T.paper : T.black,
        borderColor: active ? (tone || T.black) : T.hair,
      }}>{children}</button>
  );
}

function Stat({ label, value, sub, tone, marker }) {
  return (
    <div style={{ flex: 1, minWidth: 120, borderTop: "1px solid " + T.black, paddingTop: 8 }}>
      <div className="subhead" style={{ color: T.warmGray, display: "flex", alignItems: "center", gap: 6 }}>
        {marker && <span style={{ width: 4, height: 4, background: T.red, display: "inline-block" }} />}
        {label}
      </div>
      <div className="data" style={{ fontSize: 26, fontWeight: 700, color: tone || T.black, lineHeight: 1.1, marginTop: 2 }}>{value}</div>
      {sub && <div className="data" style={{ fontSize: 10, color: T.warmGray }}>{sub}</div>}
    </div>
  );
}

function PlayerPicker({ id, value, onPick, ariaLabel }) {
  const [text, setText] = useState(value ? label(BY_ID.get(value)) : "");
  return (
    <div>
      <input list="universe-list" value={text} className="data"
        aria-label={ariaLabel}
        placeholder="Type a player name"
        onChange={e => {
          setText(e.target.value);
          const hit = BY_LABEL.get(e.target.value);
          if (hit) onPick(hit);
        }}
        style={{ width: "100%", boxSizing: "border-box", background: T.paper, color: T.black, border: "1px solid " + T.black, borderRadius: 2, padding: "8px 10px", fontSize: 13 }} />
    </div>
  );
}

function FieldStrip({ stats }) {
  const max = Math.max(30, Math.ceil(stats.p90 / 5) * 5 + 5);
  const pct = v => Math.min(100, (v / max) * 100) + "%";
  const ticks = [];
  for (let t = 0; t <= max; t += 5) ticks.push(t);
  return (
    <div style={{ marginTop: 24 }}>
      <div className="subhead" style={{ marginBottom: 8 }}>Projection range — floor to ceiling</div>
      <div style={{ position: "relative", height: 64, borderBottom: "1px solid " + T.black }}>
        {ticks.map(t => (
          <div key={t} style={{ position: "absolute", left: pct(t), top: 8, bottom: 0, width: 1, background: T.hair }}>
            <span className="data" style={{ position: "absolute", bottom: 2, left: 3, fontSize: 9, color: T.warmGray }}>{t}</span>
          </div>
        ))}
        <div style={{
          position: "absolute", left: pct(stats.p10), width: "calc(" + pct(stats.p90) + " - " + pct(stats.p10) + ")",
          top: 18, height: 20, background: T.lightBlue,
        }} />
        <div style={{ position: "absolute", left: pct(stats.p50), top: 12, height: 32, width: 2, background: T.red }} />
        <div className="data" style={{ position: "absolute", left: pct(stats.p10), top: 0, fontSize: 10 }}>{stats.p10.toFixed(1)}</div>
        <div className="data" style={{ position: "absolute", left: pct(stats.p50), top: 0, transform: "translateX(-50%)", fontSize: 10, fontWeight: 500, color: T.red }}>{stats.p50.toFixed(1)}</div>
        <div className="data" style={{ position: "absolute", left: pct(stats.p90), top: 0, transform: "translateX(-100%)", fontSize: 10 }}>{stats.p90.toFixed(1)}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span className="data" style={{ fontSize: 9, color: T.warmGray }}>FLOOR P10</span>
        <span className="data" style={{ fontSize: 9, color: T.red }}>MEDIAN</span>
        <span className="data" style={{ fontSize: 9, color: T.warmGray }}>CEILING P90</span>
      </div>
    </div>
  );
}

function FactorBars({ factors }) {
  return (
    <div>
      {factors.map(f => {
        const pct = (f.mult - 1) * 100;
        const w = Math.min(50, Math.abs(pct) * 2.2);
        const posv = pct >= 0;
        return (
          <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid " + T.hair }}>
            <div className="data" style={{ width: 170, fontSize: 12, fontWeight: 500, flexShrink: 0 }}>{f.label}</div>
            <div style={{ flex: 1, position: "relative", height: 10 }}>
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: T.black }} />
              <div style={{
                position: "absolute", top: 0, height: 10,
                left: posv ? "50%" : "calc(50% - " + w + "%)", width: w + "%",
                background: Math.abs(pct) < 0.5 ? T.hair : posv ? T.pos : T.neg,
              }} />
            </div>
            <div className="data" style={{ width: 56, fontSize: 12, textAlign: "right", color: Math.abs(pct) < 0.5 ? T.warmGray : posv ? T.pos : T.neg }}>
              {(pct >= 0 ? "+" : "") + pct.toFixed(1)}%
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SignedNum({ v, digits = 1 }) {
  if (v == null || Number.isNaN(v)) return <span style={{ color: T.flag }}>—</span>;
  if (v < 0) return <span style={{ color: T.neg }}>({Math.abs(v).toFixed(digits)})</span>;
  return <span>{v.toFixed(digits)}</span>;
}

/* ---------- live sync via Claude API ---------- */

async function fetchLiveReport(player) {
  const res = await fetch("/api/live-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: player.name, pos: player.pos, team: player.team }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "live sync failed");
  return data;
}

/* ---------- main ---------- */

export default function FieldEdge() {
  const [tab, setTab] = useState("lab");
  const [selA, setSelA] = useState(DEFAULT_A);
  const [selB, setSelB] = useState(DEFAULT_B);
  const [settingsMap, setSettingsMap] = useState({});
  const [threshold, setThreshold] = useState(15);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState(null);
  const [syncErr, setSyncErr] = useState(null);

  const [teams, setTeams] = useState(10);
  const [riskCap, setRiskCap] = useState(5.5);
  const [sortKey, setSortKey] = useState("vor");
  const [sortAsc, setSortAsc] = useState(false);
  const [posFilter, setPosFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const getS = useCallback(id => settingsMap[id] || DEFAULT_SETTINGS, [settingsMap]);
  const patchS = (id, patch) => setSettingsMap(m => ({ ...m, [id]: { ...(m[id] || DEFAULT_SETTINGS), ...patch } }));

  const playerA = BY_ID.get(selA);
  const playerB = BY_ID.get(selB);
  const sA = getS(selA), sB = getS(selB);

  const simsA = useMemo(() => simulate(playerA, sA), [playerA, sA]);
  const simsB = useMemo(() => simulate(playerB, sB), [playerB, sB]);
  const statsA = useMemo(() => summarize(simsA, playerA.base), [simsA, playerA]);
  const statsB = useMemo(() => summarize(simsB, playerB.base), [simsB, playerB]);
  const { factors, totalMult, playProb } = useMemo(() => computeFactors(playerA, sA), [playerA, sA]);

  const pOverT = simsA.filter(v => v >= threshold).length / simsA.length;
  const pAWins = useMemo(() => {
    let w = 0;
    const n = Math.min(simsA.length, simsB.length);
    for (let i = 0; i < n; i++) if (simsA[i] > simsB[(i * 13) % n]) w++;
    return w / n;
  }, [simsA, simsB]);

  const bins = useMemo(
    () => (tab === "h2h" ? makeBins(simsA, simsB) : makeBins(simsA)),
    [tab, simsA, simsB]
  );

  const { rows: board, repl } = useMemo(() => computeVOR(teams), [teams]);
  const optimal = useMemo(() => optimizeRoster(riskCap), [riskCap]);

  const filtered = useMemo(() => {
    let b = board;
    if (posFilter !== "ALL") b = b.filter(r => r.pos === posFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      b = b.filter(r => r.name.toLowerCase().includes(q) || r.team.toLowerCase() === q);
    }
    return [...b].sort((a, x) => {
      const nullVal = sortAsc ? 1e9 : -1e9;
      const av = a[sortKey] ?? nullVal, xv = x[sortKey] ?? nullVal;
      return sortAsc ? av - xv : xv - av;
    });
  }, [board, posFilter, query, sortKey, sortAsc]);

  const visible = showAll ? filtered : filtered.slice(0, 150);

  const doSync = async () => {
    setSyncing(true); setSyncErr(null); setSyncNote(null);
    try {
      const r = await fetchLiveReport(playerA);
      patchS(selA, {
        injury: INJURY[r.injuryStatus] ? r.injuryStatus : "healthy",
        windMph: Math.max(0, Math.min(35, Math.round(r.windMph ?? 5))),
        precip: ["none", "rain", "snow"].includes(r.precip) ? r.precip : "none",
        dome: !!r.dome,
        oppDefRank: Math.max(1, Math.min(32, Math.round(r.oppDefRank ?? 16))),
        teamTotal: Math.max(14, Math.min(34, Math.round(r.teamTotal ?? 23))),
        roleMult: Math.max(0.5, Math.min(1.3, Number(r.roleFactor) || 1)),
        roleNote: r.roleNote && r.roleNote !== "unchanged" ? String(r.roleNote).slice(0, 60) : null,
      });
      setSyncNote(r.note || "Live factors applied.");
    } catch (e) {
      setSyncErr("Live sync could not parse a report. Factors are unchanged — run the sync again.");
    }
    setSyncing(false);
  };

  const lastA = playerA.name.split(" ").slice(-1)[0];
  const lastB = playerB.name.split(" ").slice(-1)[0];
  const verdict = pAWins > 0.62 ? "Start " + lastA : pAWins < 0.38 ? "Start " + lastB : "Coin flip — weigh the ceilings";

  const tooltipStyle = {
    background: T.paper, border: "1px solid " + T.black, borderRadius: 2,
    fontFamily: "'Calibre','Inter','Helvetica Neue',Arial,sans-serif", fontSize: 12,
  };

  const th = (lbl, key, align) => (
    <th key={lbl} onClick={key ? () => { key === sortKey ? setSortAsc(!sortAsc) : (setSortKey(key), setSortAsc(false)); } : undefined}
      style={{
        textAlign: align || "right", fontSize: 12, fontWeight: 500, borderBottom: "1px solid " + T.black,
        padding: "6px 4px", cursor: key ? "pointer" : "default", whiteSpace: "nowrap",
        color: key === sortKey ? T.red : T.black,
      }}>{lbl}{key === sortKey ? (sortAsc ? " \u2191" : " \u2193") : ""}</th>
  );

  const cell = { fontSize: 12, textAlign: "right", padding: "7px 4px", borderBottom: "1px solid " + T.hair };

  return (
    <div style={{ minHeight: "100vh", background: T.paper, color: T.black }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;700&family=Playfair+Display:ital,wght@0,400;1,400&family=Inter:wght@400;500;700&display=swap');
        .page { max-width: 1100px; margin: 0 auto; padding: 0 64px 64px; }
        @media (max-width: 760px) { .page { padding: 0 20px 40px; } }
        .serif { font-family: 'Filosofia', 'Playfair Display', Georgia, serif; }
        .data { font-family: 'Calibre', 'Inter', 'Helvetica Neue', Arial, sans-serif; font-variant-numeric: tabular-nums; }
        .display { font-family: 'Calibre', 'Archivo', 'Helvetica Neue', Arial, sans-serif; }
        .eyebrow { font-family: 'Filosofia', 'Playfair Display', Georgia, serif; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; }
        .subhead { font-family: 'Calibre', 'Archivo', Arial, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; }
        .body-serif { font-family: 'Filosofia', 'Playfair Display', Georgia, serif; font-size: 13px; line-height: 1.5; }
        .chip { font-family: 'Calibre', 'Inter', Arial, sans-serif; font-size: 11px; font-weight: 500; padding: 5px 10px; border-radius: 2px; border: 1px solid; cursor: pointer; margin: 0 6px 6px 0; }
        input[type=range] { accent-color: #000000; height: 20px; cursor: pointer; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #000000; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>

      <datalist id="universe-list">
        {UNIVERSE.map(p => <option key={p.id} value={label(p)} />)}
      </datalist>

      <div className="page">

        <div style={{ paddingTop: 40 }}>
          <div className="eyebrow" style={{ color: T.red, marginBottom: 6 }}>Projection + Draft Model / {UNIVERSE.length.toLocaleString()} Players / nflverse-data</div>
          <div style={{ height: 1, background: T.black, marginBottom: 16 }} />
          <h1 className="display" style={{ fontSize: 34, fontWeight: 700, lineHeight: 0.95, margin: 0 }}>FieldEdge</h1>
          <div className="data" style={{ fontSize: 12, color: T.warmGray, marginTop: 8 }}>
            Monte Carlo weekly projections · {SEASONS_USED.length}-season nflverse baselines · {DATA_SEASON} draft prep
          </div>

          <div style={{ display: "flex", gap: 24, marginTop: 24, flexWrap: "wrap" }}>
            {[["lab", "Player Lab"], ["h2h", "Start / Sit"], ["draft", "Draft Board"]].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className="subhead"
                style={{
                  background: "none", border: "none", cursor: "pointer", padding: "0 0 6px",
                  color: tab === k ? T.black : T.warmGray,
                  borderBottom: tab === k ? "2px solid " + T.black : "2px solid transparent",
                }}>{l}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 48, marginTop: 40 }}>

          <div style={{ flex: "1 1 300px", minWidth: 280 }}>
            {tab !== "draft" ? (
              <div>
                <SectionBar num="01" title="What-If Factors" />
                <div className="display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 24 }}>Scenario controls</div>

                <div className="subhead" style={{ marginBottom: 6 }}>Player — search {UNIVERSE.length.toLocaleString()}</div>
                <div style={{ marginBottom: 16 }}>
                  <PlayerPicker id="pickA" value={selA} onPick={setSelA} ariaLabel="Select player" />
                </div>

                <button onClick={doSync} disabled={syncing} style={{
                  width: "100%", padding: "10px 0", borderRadius: 2, border: "none", cursor: syncing ? "wait" : "pointer",
                  background: T.black, color: T.paper, fontFamily: "'Calibre','Archivo',Arial,sans-serif",
                  fontWeight: 700, fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase",
                  marginBottom: 10, opacity: syncing ? 0.5 : 1,
                }}>
                  {syncing ? "Pulling live report" : "Sync live injury + weather"}
                </button>
                {syncNote && <div className="body-serif" style={{ color: T.pos, marginBottom: 10 }}>{syncNote}</div>}
                {syncErr && <div className="body-serif" style={{ color: T.flag, marginBottom: 10 }}>{syncErr}</div>}

                <div className="subhead" style={{ margin: "10px 0 6px" }}>Injury report</div>
                <div style={{ marginBottom: 12 }}>
                  {Object.entries(INJURY).map(([k, v]) => (
                    <Chip key={k} active={sA.injury === k} onClick={() => patchS(selA, { injury: k })}
                      tone={k === "questionable" || k === "doubtful" ? T.flag : k === "out" ? T.neg : T.black}>{v.label}</Chip>
                  ))}
                </div>

                <SliderRow label="Age what-if" value={sA.ageShift} min={-4} max={4}
                  fmt={v => (v >= 0 ? "+" : "") + v + " yrs (" + (playerA.age + v) + ")"} onChange={v => patchS(selA, { ageShift: v })} />

                <div className="subhead" style={{ margin: "6px 0 6px" }}>Weather</div>
                <div style={{ marginBottom: 8 }}>
                  <Chip active={sA.dome} onClick={() => patchS(selA, { dome: !sA.dome })}>Dome</Chip>
                  {["none", "rain", "snow"].map(p => (
                    <Chip key={p} active={!sA.dome && sA.precip === p} onClick={() => patchS(selA, { precip: p, dome: false })}>{p}</Chip>
                  ))}
                </div>
                <SliderRow label="Wind" value={sA.windMph} min={0} max={35} fmt={v => v + " mph"}
                  onChange={v => patchS(selA, { windMph: v, dome: false })} />

                <SliderRow label="Opponent defense rank" value={sA.oppDefRank} min={1} max={32}
                  fmt={v => "#" + v + (v <= 8 ? " (tough)" : v >= 25 ? " (soft)" : "")} onChange={v => patchS(selA, { oppDefRank: v })} />
                <SliderRow label="Vegas implied team total" value={sA.teamTotal} min={14} max={34} fmt={v => v + " pts"}
                  onChange={v => patchS(selA, { teamTotal: v })} />

                <div className="subhead" style={{ margin: "6px 0 6px" }}>Game script</div>
                <div style={{ marginBottom: 12 }}>
                  {[["favored", "Favored"], ["neutral", "Neutral"], ["trailing", "Trailing"]].map(([k, l]) => (
                    <Chip key={k} active={sA.script === k} onClick={() => patchS(selA, { script: k })}>{l}</Chip>
                  ))}
                </div>

                <SliderRow label="Snap share shift" value={sA.snapDelta} min={-25} max={25}
                  fmt={v => (v >= 0 ? "+" : "") + v + "%"} onChange={v => patchS(selA, { snapDelta: v })} />

                <button onClick={() => setSettingsMap(m => ({ ...m, [selA]: DEFAULT_SETTINGS }))}
                  style={{ background: T.paper, border: "1px solid " + T.black, color: T.black, borderRadius: 2, padding: "8px 12px", cursor: "pointer", fontSize: 11, width: "100%", fontFamily: "'Calibre','Inter',Arial,sans-serif", fontWeight: 500 }}>
                  Reset factors
                </button>
              </div>
            ) : (
              <div>
                <SectionBar num="01" title="League Settings" />
                <div className="display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 24 }}>Draft parameters</div>

                <SliderRow label="Teams in league" value={teams} min={8} max={14} fmt={v => v + " teams"} onChange={setTeams} />

                <div className="subhead" style={{ marginBottom: 8 }}>Replacement ranks</div>
                <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 20 }} className="data">
                  <tbody>
                    {Object.entries(repl).map(([pos, r]) => (
                      <tr key={pos}>
                        <td style={{ fontSize: 12, fontWeight: 500, padding: "5px 0", borderBottom: "1px solid " + T.hair }}>{pos}</td>
                        <td style={{ fontSize: 12, textAlign: "right", padding: "5px 0", borderBottom: "1px solid " + T.hair }}>#{r}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <SliderRow label="Max player risk" value={riskCap} min={RISK_LO} max={RISK_HI} step={0.25}
                  fmt={v => v.toFixed(2)} onChange={setRiskCap} />

                <p className="body-serif" style={{ margin: "12px 0 0" }}>
                  Risk is scaled to a mean of 5 and a standard deviation of 2 across the pool:
                  4 and below reads as a starter profile, 6 and above as a sleeper. The cap
                  filters the optimal roster the same way the LP&rsquo;s per-player constraint does.
                </p>
              </div>
            )}
          </div>

          <div style={{ flex: "2 1 480px", minWidth: 320 }}>

            {tab === "lab" && (
              <div>
                <SectionBar num="02" title="Projection" />
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
                  <div className="display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.05 }}>{playerA.name}</div>
                  <div className="data" style={{ fontSize: 12, color: T.warmGray }}>
                    {playerA.pos} · {playerA.team} · {playerA.base.toFixed(1)} pts/gm model projection
                    ({playerA.expGames.toFixed(0)} expected games{playerA.nSrc >= 2 ? ", " + playerA.nSrc + " real seasons" : ", single-season anchor"})
                    {playerA.injPart ? <span style={{ color: T.flag }}>{" · returning from " + playerA.injPart + " — comps at " + playerA.injMult.toFixed(2) + "x"}</span> : null}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 24, marginTop: 24, flexWrap: "wrap" }}>
                  <Stat label="Adjusted mean" value={statsA.mean.toFixed(1)} marker
                    sub={(totalMult >= 1 ? "+" : "") + ((totalMult - 1) * 100).toFixed(1) + "% vs baseline"} />
                  <Stat label="Plays" value={(playProb * 100).toFixed(0) + "%"} sub="active probability" />
                  <Stat label="Boom" value={(statsA.boom * 100).toFixed(0) + "%"} sub="at least 125% of baseline" tone={T.pos} />
                  <Stat label="Bust" value={(statsA.bust * 100).toFixed(0) + "%"} sub="under 50% of baseline" tone={T.neg} />
                </div>

                <FieldStrip stats={statsA} />

                <div style={{ marginTop: 32 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                    <div className="subhead">Simulated outcome distribution</div>
                    <div className="data" style={{ fontSize: 13 }}>
                      P(at least <span style={{ fontWeight: 700 }}>{threshold}</span> pts) = <span style={{ fontWeight: 700 }}>{(pOverT * 100).toFixed(1)}%</span>
                    </div>
                  </div>
                  <input type="range" min={5} max={35} value={threshold} onChange={e => setThreshold(Number(e.target.value))}
                    style={{ width: "100%", margin: "6px 0" }} aria-label="Point threshold" />
                  <ResponsiveContainer width="100%" height={210}>
                    <BarChart data={bins} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                      <XAxis dataKey="x" tick={{ fill: T.warmGray, fontSize: 10 }} interval={2}
                        axisLine={{ stroke: T.black }} tickLine={false} />
                      <YAxis tick={{ fill: T.warmGray, fontSize: 10 }} unit="%" axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={tooltipStyle}
                        formatter={v => [v.toFixed(1) + "%", "of sims"]} labelFormatter={l => "~" + l + " pts"} />
                      <ReferenceLine x={bins.reduce((best, b) => Math.abs(b.lo - threshold) < Math.abs(best.lo - threshold) ? b : best, bins[0]).x}
                        stroke={T.red} strokeWidth={2} />
                      <Bar dataKey="a" fill={T.plum} />
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="data" style={{ fontSize: 9, color: T.warmGray, marginTop: 2 }}>
                    Red marker: point threshold. Bars: share of 6,000 simulations per point bucket.
                  </div>
                </div>

                <div style={{ marginTop: 40 }}>
                  <SectionBar num="03" title="Factor Attribution" />
                  <div className="display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Impact on projection</div>
                  <FactorBars factors={factors} />
                </div>
              </div>
            )}

            {tab === "h2h" && (
              <div>
                <SectionBar num="04" title="Head-to-Head" />
                <div className="display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.05, marginBottom: 8 }}>Start / Sit decision</div>
                <p className="body-serif" style={{ margin: "0 0 16px" }}>
                  Each player runs under their own saved what-if factors. Select a player in the scenario
                  controls to tune them, then compare here.
                </p>

                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div className="subhead" style={{ marginBottom: 4 }}>Player A</div>
                    <PlayerPicker id="pickH2HA" value={selA} onPick={setSelA} ariaLabel="Player A" />
                  </div>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div className="subhead" style={{ marginBottom: 4 }}>Player B</div>
                    <PlayerPicker id="pickH2HB" value={selB} onPick={setSelB} ariaLabel="Player B" />
                  </div>
                </div>

                <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                  <Stat label={"P(" + lastA + " outscores)"} value={(pAWins * 100).toFixed(1) + "%"} marker />
                  <Stat label="Mean edge" value={(statsA.mean - statsB.mean >= 0 ? "+" : "") + (statsA.mean - statsB.mean).toFixed(1)} sub="points, A minus B" />
                </div>

                <div style={{ background: T.pink, padding: "14px 18px", margin: "24px 0" }}>
                  <span className="serif" style={{ fontSize: 15, fontStyle: "italic" }}>{verdict}</span>
                </div>

                <div style={{ display: "flex", height: 22, border: "1px solid " + T.black }}>
                  <div style={{ width: (pAWins * 100) + "%", background: T.gold }} />
                  <div style={{ flex: 1, background: T.plum }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span className="data" style={{ fontSize: 11 }}>
                    <span style={{ display: "inline-block", width: 8, height: 8, background: T.gold, marginRight: 5 }} />
                    {playerA.name} {(pAWins * 100).toFixed(1)}%
                  </span>
                  <span className="data" style={{ fontSize: 11 }}>
                    {playerB.name} {((1 - pAWins) * 100).toFixed(1)}%
                    <span style={{ display: "inline-block", width: 8, height: 8, background: T.plum, marginLeft: 5 }} />
                  </span>
                </div>

                <div style={{ marginTop: 32 }}>
                  <div className="subhead" style={{ marginBottom: 8 }}>Overlapping outcome distributions</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={bins} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                      <XAxis dataKey="x" tick={{ fill: T.warmGray, fontSize: 10 }} interval={2}
                        axisLine={{ stroke: T.black }} tickLine={false} />
                      <YAxis tick={{ fill: T.warmGray, fontSize: 10 }} unit="%" axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={tooltipStyle}
                        formatter={(v, k) => [v.toFixed(1) + "%", k === "a" ? playerA.name : playerB.name]} labelFormatter={l => "~" + l + " pts"} />
                      <Bar dataKey="a" fill={T.gold} />
                      <Bar dataKey="b" fill={T.plum} />
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="data" style={{ fontSize: 9, color: T.warmGray, marginTop: 2 }}>
                    Gold: {playerA.name}. Plum: {playerB.name}. Share of simulations per point bucket.
                  </div>
                </div>

                <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 24 }} className="data">
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", fontSize: 12, fontWeight: 500, borderBottom: "1px solid " + T.black, padding: "6px 0" }}>Player</th>
                      {["Floor P10", "Median", "Ceiling P90", "Boom", "Bust"].map(h => (
                        <th key={h} style={{ textAlign: "right", fontSize: 12, fontWeight: 500, borderBottom: "1px solid " + T.black, padding: "6px 0" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[[playerA, statsA], [playerB, statsB]].map(([p, st]) => (
                      <tr key={p.id}>
                        <td style={{ fontSize: 12, fontWeight: 500, padding: "8px 0", borderBottom: "1px solid " + T.hair }}>{p.name}</td>
                        {[st.p10, st.p50, st.p90].map((v, i) => (
                          <td key={i} style={{ textAlign: "right", fontSize: 12, padding: "8px 0", borderBottom: "1px solid " + T.hair }}>{v.toFixed(1)}</td>
                        ))}
                        <td style={{ textAlign: "right", fontSize: 12, padding: "8px 0", borderBottom: "1px solid " + T.hair, color: T.pos }}>{(st.boom * 100).toFixed(0)}%</td>
                        <td style={{ textAlign: "right", fontSize: 12, padding: "8px 0", borderBottom: "1px solid " + T.hair, color: T.neg }}>{(st.bust * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === "draft" && (
              <div>
                <SectionBar num="05" title="Draft Board" />
                <div className="display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.05, marginBottom: 8 }}>
                  Value over replacement — {teams} teams
                </div>
                <p className="body-serif" style={{ margin: "0 0 16px" }}>
                  {`${UNIVERSE.length.toLocaleString()} players from nflverse-data. ${N_MULTI} carry two or more
                  real seasons (${SEASONS_USED.join(", ")}); ${N_SINGLE} carry a single real season spread
                  deterministically. Proj is the backtested model (usage & recency, age curves, empirical
                  injury comps) blended 50/50 with the FantasyPros expert consensus where ranked — the
                  strongest variant below. ECR is the market's overall rank. Risk blends how much a player's
                  seasons disagree with how much the experts disagree — standardized within position and
                  widened for players returning from major injuries. VOR is projected points above the
                  replacement starter at rank QB${repl.QB} / RB${repl.RB} / WR${repl.WR} / TE${repl.TE},
                  measured against the actual players holding those ranks. Click a column to sort.`}
                </p>

                <div style={{ marginBottom: 10 }}>
                  {["ALL", ...POS_LIST].map(p => (
                    <Chip key={p} active={posFilter === p} onClick={() => setPosFilter(p)}>{p}</Chip>
                  ))}
                </div>
                <input value={query} onChange={e => setQuery(e.target.value)} className="data"
                  placeholder="Search name or team code"
                  aria-label="Search players"
                  style={{ width: "100%", boxSizing: "border-box", background: T.paper, border: "1px solid " + T.black, borderRadius: 2, padding: "8px 10px", fontSize: 13, marginBottom: 12 }} />

                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }} className="data">
                    <thead>
                      <tr>
                        {th("Player", null, "left")}
                        {th("Pos", null, "left")}
                        {th("Team", null, "left")}
                        {th("Src", "nSrc")}
                        {th("ECR", "ecr")}
                        {th("Proj", "proj")}
                        {th("SD", "sdPts")}
                        {th("Risk", "risk")}
                        {th("VOR", "vor")}
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(r => (
                        <tr key={r.id}>
                          <td style={{ ...cell, textAlign: "left", fontWeight: 500, whiteSpace: "nowrap" }}>{r.name}</td>
                          <td style={{ ...cell, textAlign: "left", color: T.warmGray }}>{r.pos}</td>
                          <td style={{ ...cell, textAlign: "left", color: T.warmGray }}>{r.team}</td>
                          <td style={{ ...cell, color: r.nSrc === 0 ? T.flag : T.black }}>{r.nSrc === 0 ? "—" : r.nSrc}</td>
                          <td style={{ ...cell, color: T.warmGray }}>{r.ecr != null ? r.ecr.toFixed(0) : "—"}</td>
                          <td style={{ ...cell, fontWeight: 500 }}>
                            {r.proj.toFixed(1)}
                            {r.injPart ? <span title={"returning from " + r.injPart} style={{ color: T.flag }}> †</span> : null}
                          </td>
                          <td style={cell}>{r.sdPts.toFixed(1)}</td>
                          <td style={{ ...cell, color: r.risk >= 6 ? T.flag : T.black }}>{r.risk.toFixed(1)}</td>
                          <td style={cell}><SignedNum v={r.vor} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, flexWrap: "wrap", gap: 8 }}>
                  <div className="data" style={{ fontSize: 9, color: T.warmGray }}>
                    Showing {visible.length.toLocaleString()} of {filtered.length.toLocaleString()}. Src — in amber: single real season.
                    Risk 6+ flagged. VOR applies to QB / RB / WR / TE. Season fantasy points.
                  </div>
                  {filtered.length > 150 && (
                    <button onClick={() => setShowAll(!showAll)}
                      style={{ background: T.paper, border: "1px solid " + T.black, borderRadius: 2, padding: "6px 12px", cursor: "pointer", fontSize: 11, fontFamily: "'Calibre','Inter',Arial,sans-serif", fontWeight: 500 }}>
                      {showAll ? "Show top 150" : "Show all " + filtered.length.toLocaleString()}
                    </button>
                  )}
                </div>

                <div style={{ marginTop: 40 }}>
                  <SectionBar num="06" title="Risk Frontier" />
                  <div className="display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
                    Optimal lineup points by max risk
                  </div>
                  <p className="body-serif" style={{ margin: "0 0 12px" }}>
                    Sweeping the per-player risk cap and re-optimizing a 1QB / 2RB / 2WR / 1TE / 1FLEX
                    lineup across the full universe shows how much projected total is bought by
                    accepting riskier players — and where the curve flattens.
                  </p>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={FRONTIER} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                      <XAxis dataKey="cap" tick={{ fill: T.warmGray, fontSize: 10 }} interval={3}
                        axisLine={{ stroke: T.black }} tickLine={false} />
                      <YAxis tick={{ fill: T.warmGray, fontSize: 10 }} axisLine={false} tickLine={false}
                        domain={["auto", "auto"]} />
                      <Tooltip contentStyle={tooltipStyle}
                        formatter={v => [v == null ? "—" : v.toFixed(0) + " pts", "optimal total"]}
                        labelFormatter={l => "risk cap " + l} />
                      <ReferenceLine x={riskCap.toFixed(2)} stroke={T.red} strokeWidth={2} />
                      <Line type="stepAfter" dataKey="total" stroke={T.cat2} strokeWidth={2} dot={false} connectNulls={false} />
                    </LineChart>
                  </ResponsiveContainer>
                  <div className="data" style={{ fontSize: 9, color: T.warmGray, marginTop: 2 }}>
                    Blue line: total model-projected points of the optimal lineup. Red marker: current cap.
                  </div>

                  <div style={{ marginTop: 20 }}>
                    <div className="subhead" style={{ marginBottom: 8 }}>Optimal roster at risk cap {riskCap.toFixed(2)}</div>
                    {optimal ? (
                      <table style={{ width: "100%", borderCollapse: "collapse" }} className="data">
                        <tbody>
                          {optimal.roster.map((r, i) => (
                            <tr key={r.id}>
                              <td style={{ fontSize: 12, color: T.warmGray, padding: "6px 4px", borderBottom: "1px solid " + T.hair, width: 60 }}>
                                {i === 0 ? "QB" : i <= 2 ? "RB" : i <= 4 ? "WR" : i === 5 ? "TE" : "FLEX"}
                              </td>
                              <td style={{ fontSize: 12, fontWeight: 500, padding: "6px 4px", borderBottom: "1px solid " + T.hair }}>{r.name}</td>
                              <td style={{ fontSize: 12, textAlign: "right", padding: "6px 4px", borderBottom: "1px solid " + T.hair }}>{r.proj.toFixed(1)}</td>
                              <td style={{ fontSize: 12, textAlign: "right", padding: "6px 4px", borderBottom: "1px solid " + T.hair, color: r.risk >= 6 ? T.flag : T.warmGray }}>{r.risk.toFixed(1)}</td>
                            </tr>
                          ))}
                          <tr>
                            <td style={{ padding: "6px 4px", borderBottom: "1px solid " + T.black }} />
                            <td style={{ fontSize: 12, fontWeight: 700, padding: "6px 4px", borderBottom: "1px solid " + T.black }}>Total</td>
                            <td style={{ fontSize: 12, fontWeight: 700, textAlign: "right", padding: "6px 4px", borderBottom: "1px solid " + T.black }}>{optimal.total.toFixed(1)}</td>
                            <td style={{ padding: "6px 4px", borderBottom: "1px solid " + T.black }} />
                          </tr>
                        </tbody>
                      </table>
                    ) : (
                      <div className="data" style={{ fontSize: 12, color: T.flag }}>
                        — Not enough eligible players at this cap to fill every slot. Raise the max risk.
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 40 }}>
                    <SectionBar num="07" title="Model Validation" />
                    <div className="display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
                      Backtested on {BACKTEST.targets.length} held-out seasons
                    </div>
                    <p className="body-serif" style={{ margin: "0 0 12px" }}>
                      {`Each modeling layer predicted seasons ${BACKTEST.targets.join(", ")} using only earlier
                      data, then was scored against what actually happened. Rank r is the Spearman correlation
                      between projected and actual season points; MAE-36 is the mean error among the top
                      draft-relevant players at each position.`}
                    </p>
                    <table style={{ width: "100%", borderCollapse: "collapse" }} className="data">
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", fontSize: 11, fontWeight: 500, borderBottom: "1px solid " + T.black, padding: "5px 4px" }}>Model layer</th>
                          <th style={{ textAlign: "right", fontSize: 11, fontWeight: 500, borderBottom: "1px solid " + T.black, padding: "5px 4px" }}>Rank r</th>
                          <th style={{ textAlign: "right", fontSize: 11, fontWeight: 500, borderBottom: "1px solid " + T.black, padding: "5px 4px" }}>MAE-36</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(BACKTEST.byVariant).map(([v, b]) => (
                          <tr key={v}>
                            <td style={{ fontSize: 11.5, padding: "6px 4px", borderBottom: "1px solid " + T.hair, fontWeight: v === "4" ? 700 : 400 }}>{b.label}</td>
                            <td style={{ fontSize: 11.5, textAlign: "right", padding: "6px 4px", borderBottom: "1px solid " + T.hair, fontWeight: v === "4" ? 700 : 400 }}>{b.overall.spearman.toFixed(3)}</td>
                            <td style={{ fontSize: 11.5, textAlign: "right", padding: "6px 4px", borderBottom: "1px solid " + T.hair, fontWeight: v === "4" ? 700 : 400 }}>{b.overall.maeTop.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="data" style={{ fontSize: 9, color: T.warmGray, marginTop: 6, lineHeight: 1.5 }}>
                      Usage/recency and age improve on the raw baseline; injury comps barely move the mean and
                      are applied mostly as wider risk; blending the market consensus is the largest single gain.
                      The shipped board runs the full bolded model.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div style={{ marginTop: 48 }}>
              <div style={{ height: 1, background: T.hair, marginBottom: 8 }} />
              <p className="data" style={{ fontSize: 9, color: T.warmGray, lineHeight: 1.6, margin: 0 }}>
                {`Data. Universe of ${UNIVERSE.length.toLocaleString()} players built from nflverse-data season stats
                (${SEASONS_USED.join(", ")}, 17-game seasons): each real season is one projection source.
                ${N_MULTI} players carry 2+ real seasons; ${N_SINGLE} carry a single real season spread
                deterministically. Ages from nflverse birthdates as of the ${DATA_SEASON} draft. `}
                Model. Season projections are recency- and games-weighted per-game rates x an availability-shrunk
                expected-games estimate, re-based through position age curves, with empirical injury-recovery
                multipliers learned from every comparable position-x-body-part case since 2010 (backtested above;
                weekly what-if baselines divide that projection per game). Age effects use position-specific career
                curves applied relative to actual age; injury statuses set an active-game probability and an
                effectiveness discount; wind and precipitation scale with positional pass-game sensitivity and are
                ignored in domes; kickers are treated as highly wind-sensitive. Draft pipeline per the repo: robust
                average is the Hodges-Lehmann pseudo-median; SD is the scaled MAD across sources; risk is the
                position-standardized SD rescaled to mean 5, sd 2; replacement ranks follow League Settings.R with
                empirical baselines from the players actually holding ranks r-1 to r+1; the roster optimizer applies
                the LP&rsquo;s per-player risk constraint. Refresh the data any time with npm run data.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
