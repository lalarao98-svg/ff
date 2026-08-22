/* Shared design tokens + structural atoms for the FieldEdge house style. */

export const T = {
  red: "#F03E3E", black: "#000000", warmGray: "#A39382", paper: "#FFFFFF",
  plum: "#522A45", lightBlue: "#B8C5D8", pink: "#E0BCB0", brightBlue: "#149FDA",
  gold: "#D5AB32", cat2: "#4497F9",
  pos: "#4F7A3D", neg: "#A8483D", flag: "#E08214",
  hair: "rgba(163,147,130,0.4)",
};

export function SectionBar({ num, title }) {
  return (
    <div>
      <div style={{ height: 8, background: T.black }} />
      <div style={{ height: 8 }} />
      <div className="eyebrow" style={{ color: T.red, marginBottom: 4 }}>{num} / {title}</div>
    </div>
  );
}

export function SliderRow({ label, value, min, max, step = 1, onChange, fmt }) {
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

export function Chip({ active, onClick, children, tone }) {
  return (
    <button onClick={onClick} className="chip"
      style={{
        background: active ? (tone || T.black) : T.paper,
        color: active ? T.paper : T.black,
        borderColor: active ? (tone || T.black) : T.hair,
      }}>{children}</button>
  );
}

export function Stat({ label, value, sub, tone, marker }) {
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
