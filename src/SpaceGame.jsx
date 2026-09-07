import React, { useState, useEffect, useRef } from "react";

/**
 * Cosmos Engine — Space Game
 * ----------------------------------------------------------------------------
 * A six-module training track modelled on the UH Manoa EPET sequence for
 * robotic space exploration
 * (https://manoa.hawaii.edu/catalog-2022-23/category/soest/epet/):
 *
 *   101  Getting Started with Space        primer for the sequence
 *   201  Science Mission                   EPET 201 — Space Exploration
 *   301  Instrument                        EPET 301 — Space Science & Instrumentation
 *   400  Satellite Design (Artemis Kit)    EPET 400 — Space Mission Design
 *   401  Build the Satellite               EPET 401 — Capstone: Producing a Science Satellite
 *   501  Launch a Satellite                operations
 *
 * Progress is linear (finish a module to unlock the next) and persisted to
 * localStorage. Choices carry forward: the mission picked in 201 sets the
 * instrument requirement in 301, whose budgets set the bus requirement in 400.
 * Module 501 hands its resulting orbit back to the main sim.
 */

const UI = {
  panel: "rgba(9,14,28,0.6)",
  border: "rgba(143,215,255,0.18)",
  borderStrong: "rgba(143,215,255,0.45)",
  text: "#cfe6ff",
  dim: "#8fa2c2",
  faint: "#5f7396",
  accent: "#8fd7ff",
  good: "#5eff9c",
  bad: "#ff6a6a",
  warn: "#ffb454",
  mono: "'IBM Plex Mono','SFMono-Regular',Menlo,monospace",
  sans: "system-ui,sans-serif",
};

const LEVELS = [
  { id: "101", n: "101", icon: "🛰️", title: "Getting Started with Space", epet: "Primer",
    blurb: "Orbits, reference frames, and the vocabulary of spaceflight." },
  { id: "201", n: "201", icon: "🔭", title: "Science Mission", epet: "EPET 201 · Space Exploration",
    blurb: "Turn a science question into a mission concept and the orbit that serves it." },
  { id: "301", n: "301", icon: "📡", title: "Instrument", epet: "EPET 301 · Space Science & Instrumentation",
    blurb: "Size a remote-sensing instrument that meets the science and fits the mass, power and data budget." },
  { id: "400", n: "400", icon: "🧩", title: "Satellite Design — Artemis Kit", epet: "EPET 400 · Space Mission Design",
    blurb: "Choose spacecraft subsystems for a balanced design that closes on power, mass, pointing and comms." },
  { id: "401", n: "401", icon: "🔧", title: "Build the Satellite", epet: "EPET 401 · Capstone",
    blurb: "Integrate the flight system in the correct assembly order." },
  { id: "501", n: "501", icon: "🚀", title: "Launch a Satellite", epet: "Operations",
    blurb: "Pick a launch site, reach your target inclination, and insert to orbit." },
];
const ORDER = LEVELS.map((l) => l.id);
const STORAGE_KEY = "cosmos-web:space-game";

const MU = 398600.4418; // km^3/s^2
const RE = 6371; // km

const r0 = (x) => Math.round(x);
const r1 = (x) => Math.round(x * 10) / 10;

function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { return {}; }
}

// ---------------------------------------------------------------------------
// Shared little UI pieces
// ---------------------------------------------------------------------------
function Btn({ children, onClick, kind = "primary", disabled }) {
  const k = {
    primary: { background: "rgba(143,215,255,0.2)", border: "1px solid rgba(143,215,255,0.5)", color: "#eaf3ff" },
    ghost: { background: "transparent", border: "1px solid rgba(143,215,255,0.25)", color: UI.dim },
    good: { background: "rgba(94,255,156,0.18)", border: "1px solid rgba(94,255,156,0.5)", color: "#c9ffe0" },
  }[kind];
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...k, opacity: disabled ? 0.45 : 1, borderRadius: 6, padding: "9px 16px", fontSize: 13,
      fontFamily: UI.mono, cursor: disabled ? "not-allowed" : "pointer",
    }}>{children}</button>
  );
}

function SectionLabel({ children, style }) {
  return (
    <div style={{
      fontSize: 11, letterSpacing: 0.6, color: UI.faint, fontFamily: UI.sans,
      textTransform: "uppercase", margin: "0 0 10px", ...style,
    }}>{children}</div>
  );
}

function Callout({ ok, children }) {
  return (
    <div style={{
      marginTop: 14, padding: "10px 12px", borderRadius: 8, fontSize: 12, lineHeight: 1.55,
      background: ok ? "rgba(94,255,156,0.1)" : "rgba(255,106,106,0.1)",
      border: `1px solid ${ok ? "rgba(94,255,156,0.4)" : "rgba(255,106,106,0.4)"}`,
      color: ok ? "#c9ffe0" : "#ffd4d4",
    }}>{children}</div>
  );
}

function OptionList({ options, value, onChange, correct, revealed }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {options.map((o) => {
        const sel = value === o.id;
        let bd = UI.border, bg = "rgba(9,14,28,0.5)";
        if (sel) { bd = UI.borderStrong; bg = "rgba(143,215,255,0.14)"; }
        if (revealed && correct !== undefined) {
          if (o.id === correct) { bd = UI.good; bg = "rgba(94,255,156,0.12)"; }
          else if (sel) { bd = UI.bad; bg = "rgba(255,106,106,0.12)"; }
        }
        return (
          <button key={o.id} onClick={() => !revealed && onChange(o.id)} disabled={revealed} style={{
            textAlign: "left", border: `1px solid ${bd}`, background: bg, color: UI.text,
            borderRadius: 8, padding: "10px 12px", fontFamily: UI.mono, fontSize: 13,
            cursor: revealed ? "default" : "pointer",
          }}>
            <div style={{ fontWeight: 600 }}>{sel ? "● " : "○ "}{o.label}</div>
            {o.sub && <div style={{ fontSize: 11, color: UI.faint, marginTop: 3 }}>{o.sub}</div>}
          </button>
        );
      })}
    </div>
  );
}

function Bar({ label, value, max, unit = "", good }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const ok = good === undefined ? true : good;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: UI.dim, marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ color: ok ? UI.text : UI.bad }}>{value}{unit} / {max}{unit}</span>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: "rgba(143,215,255,0.12)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: ok ? UI.good : UI.bad, transition: "width .25s" }} />
      </div>
    </div>
  );
}

function Stat({ label, value, target, ok }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 0",
      borderTop: "1px solid rgba(143,215,255,0.08)",
    }}>
      <span style={{ color: UI.dim }}>{label}</span>
      <span style={{ color: ok ? UI.good : UI.bad }}>
        {value} <span style={{ color: UI.faint }}>({target})</span> {ok ? "✓" : "✕"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Module 101 — Getting Started with Space (concept check)
// ---------------------------------------------------------------------------
const Q101 = [
  { id: "q1", q: "The lowest point of an elliptical orbit around Earth is called the…",
    opts: [{ id: "a", label: "Perigee" }, { id: "b", label: "Apogee" }, { id: "c", label: "Ascending node" }, { id: "d", label: "Nadir" }], correct: "a" },
  { id: "q2", q: "Compared with a low orbit, a satellite in a higher orbit travels…",
    opts: [{ id: "a", label: "Faster" }, { id: "b", label: "Slower" }, { id: "c", label: "At the same speed" }], correct: "b" },
  { id: "q3", q: "Which orbit keeps a satellite above a fixed point on the equator?",
    opts: [{ id: "a", label: "Sun-synchronous" }, { id: "b", label: "Polar" }, { id: "c", label: "Geostationary" }, { id: "d", label: "Molniya" }], correct: "c" },
  { id: "q4", q: "Orbital inclination is the angle between the orbit plane and the…",
    opts: [{ id: "a", label: "Prime meridian" }, { id: "b", label: "Ecliptic" }, { id: "c", label: "Equator" }, { id: "d", label: "Local horizon" }], correct: "c" },
  { id: "q5", q: "The Earth-Centered Inertial (ECI) frame does NOT rotate with…",
    opts: [{ id: "a", label: "The distant stars" }, { id: "b", label: "The Earth" }, { id: "c", label: "The vernal equinox" }], correct: "b" },
];

function Quiz101({ complete, done, goNext }) {
  const [ans, setAns] = useState({});
  const [checked, setChecked] = useState(false);
  const finished = !!done["101"];
  const answered = Q101.every((q) => ans[q.id]);
  const score = Q101.filter((q) => ans[q.id] === q.correct).length;
  const passed = score === Q101.length;
  return (
    <>
      {Q101.map((q, i) => (
        <div key={q.id} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 13, color: "#eaf3ff", marginBottom: 8 }}>{i + 1}. {q.q}</div>
          <OptionList options={q.opts} value={ans[q.id]}
            onChange={(v) => setAns((a) => ({ ...a, [q.id]: v }))}
            correct={q.correct} revealed={checked} />
        </div>
      ))}
      {checked && (
        <Callout ok={passed}>
          {passed
            ? "All correct — you have the vocabulary. Module complete."
            : `${score} / ${Q101.length} correct. Review the highlighted answers and try again.`}
        </Callout>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        {!checked && <Btn onClick={() => setChecked(true)} disabled={!answered}>Check answers</Btn>}
        {checked && !passed && <Btn kind="ghost" onClick={() => setChecked(false)}>Try again</Btn>}
        {checked && passed && !finished && <Btn kind="good" onClick={() => complete("101")}>Complete module</Btn>}
        {finished && <Btn kind="good" onClick={goNext}>Continue →</Btn>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Module 201 — Science Mission
// ---------------------------------------------------------------------------
const MISSIONS = [
  { id: "ice", q: "How is Arctic and Antarctic sea-ice extent changing month to month?",
    need: "Global coverage including the poles, with the same lighting on every pass.", orbit: "sso", instr: "optical imager" },
  { id: "asteroid", q: "What minerals make up the surface of a near-Earth asteroid?",
    need: "Leave Earth orbit entirely and rendezvous with the target.", orbit: "escape", instr: "imaging spectrometer" },
  { id: "rain", q: "How does tropical rainfall change over the course of a day?",
    need: "Repeatedly sample low latitudes at many different local times of day.", orbit: "leo", instr: "microwave radiometer" },
];
const ORBIT_OPTS = [
  { id: "sso", label: "Sun-synchronous polar (~700 km, ~98°)", sub: "Crosses every latitude at a fixed local solar time." },
  { id: "leo", label: "Low-inclination LEO (~400 km, ~35°)", sub: "Ground track drifts through all local times over weeks." },
  { id: "geo", label: "Geostationary (35 786 km, 0°)", sub: "Parked over one equatorial longitude." },
  { id: "escape", label: "Earth-departure / rendezvous trajectory", sub: "Hyperbolic escape, then match orbits with the target." },
];
function orbitWhy(mid) {
  return {
    ice: "A sun-synchronous polar orbit crosses every latitude — poles included — at the same local solar time, so month-to-month ice comparisons aren't confounded by changing illumination.",
    rain: "A low-inclination LEO stays over the tropics and, as its ground track precesses, samples the same regions at every local time of day over a few weeks — exactly what a diurnal-cycle study needs.",
    asteroid: "The target isn't in Earth orbit at all, so the spacecraft must escape Earth and fly a rendezvous trajectory to match orbits with the asteroid.",
  }[mid];
}

function Mission201({ store, complete, done, goNext }) {
  const [mid, setMid] = useState(store.mission || null);
  const [orb, setOrb] = useState(null);
  const [checked, setChecked] = useState(false);
  const finished = !!done["201"];
  const mission = MISSIONS.find((m) => m.id === mid);
  const passed = checked && mission && orb === mission.orbit;
  return (
    <>
      <SectionLabel>1 · Pick a science question</SectionLabel>
      <OptionList options={MISSIONS.map((m) => ({ id: m.id, label: m.q }))} value={mid}
        onChange={(v) => { setMid(v); setOrb(null); setChecked(false); }} />
      {mission && (
        <>
          <Callout ok>{mission.need}</Callout>
          <SectionLabel style={{ marginTop: 20 }}>2 · Choose the orbit that serves it</SectionLabel>
          <OptionList options={ORBIT_OPTS} value={orb} onChange={setOrb}
            correct={mission.orbit} revealed={checked} />
        </>
      )}
      {checked && (
        <Callout ok={passed}>
          {passed
            ? `${orbitWhy(mid)} This mission calls for a ${mission.instr} — carry that into Module 301.`
            : `Not the best fit. ${orbitWhy(mid)}`}
        </Callout>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        {!checked && <Btn onClick={() => setChecked(true)} disabled={!mission || !orb}>Check</Btn>}
        {checked && !passed && <Btn kind="ghost" onClick={() => setChecked(false)}>Try again</Btn>}
        {checked && passed && !finished && <Btn kind="good" onClick={() => complete("201", { mission: mid })}>Lock in mission</Btn>}
        {finished && <Btn kind="good" onClick={goNext}>Continue →</Btn>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Module 301 — Instrument
// ---------------------------------------------------------------------------
const MISSION_REQ = {
  ice: { type: "optical", band: "vis", h: 700, gsd: 30, gsdLabel: "≤ 30 m" },
  rain: { type: "radiometer", band: "mw", h: 500, gsd: 20000, gsdLabel: "≤ 20 km footprint" },
  asteroid: { type: "spectrometer", band: "nir", h: 25, gsd: 60, gsdLabel: "≤ 60 m spot" },
};
const INSTR_TYPES = [
  { id: "optical", label: "Optical imager", sub: "Panchromatic / RGB framing camera" },
  { id: "spectrometer", label: "Imaging spectrometer", sub: "Hundreds of contiguous narrow bands" },
  { id: "radiometer", label: "Microwave radiometer", sub: "Passive brightness-temperature sensing" },
  { id: "sar", label: "Synthetic-aperture radar", sub: "Active microwave, day/night, all-weather" },
];
const BAND_OPTS = [
  { id: "vis", label: "Visible (0.5 µm)" },
  { id: "nir", label: "Near-infrared (1.6 µm)" },
  { id: "tir", label: "Thermal IR (10 µm)" },
  { id: "mw", label: "Microwave (K-band)" },
];
const BANDS = { vis: "visible", nir: "near-infrared", tir: "thermal-IR", mw: "microwave" };
const MIN_D = { vis: 12, nir: 16, tir: 24, mw: 55 };
const POINT_NEED = { optical: 1, spectrometer: 0.05, radiometer: 3, sar: 0.5 };

function computeInstrument(type, band, Dcm, hKm) {
  const D = Dcm / 100;
  const lam = { vis: 0.5e-6, nir: 1.6e-6, tir: 10e-6, mw: null }[band];
  const gsd = band === "mw"
    ? 40000 * (hKm / 700) * (30 / Dcm)            // passive-MW 3 dB footprint, m
    : (1.22 * lam * hKm * 1000) / D;              // diffraction-limited GSD, m
  const dataBase = { optical: 60, spectrometer: 45, sar: 95, radiometer: 15 }[type] || 50;
  return { gsd, mass: 5 + 0.3 * Dcm, power: 8 + 0.35 * Dcm, data: dataBase + 0.8 * Dcm };
}
function fmtGSD(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
}

function Instrument301({ store, complete, done, goNext }) {
  const req = MISSION_REQ[store.mission] || MISSION_REQ.ice;
  const [type, setType] = useState(null);
  const [band, setBand] = useState(null);
  const [Dcm, setDcm] = useState(30);
  const [checked, setChecked] = useState(false);
  const finished = !!done["301"];

  const c = type && band ? computeInstrument(type, band, Dcm, req.h) : null;
  const minD = MIN_D[band] || 15;
  const ck = c && {
    type: type === req.type,
    band: band === req.band,
    mass: c.mass <= 30,
    power: c.power <= 45,
    data: c.data <= 120,
    snr: Dcm >= minD,
    res: c.gsd <= req.gsd,
  };
  const pass = ck && Object.values(ck).every(Boolean);
  const reasons = ck && Object.entries({
    type: "wrong instrument type for this science",
    band: "wrong spectral band",
    mass: "over the 30 kg mass budget",
    power: "over the 45 W power budget",
    data: "over the 120 Mbps data budget",
    snr: `aperture below the ${minD} cm minimum for usable signal`,
    res: `resolution coarser than ${req.gsdLabel}`,
  }).filter(([k]) => !ck[k]).map(([, v]) => v).join("; ");

  return (
    <>
      <Callout ok>
        Mission requirement: a <b>{req.type}</b> instrument in the <b>{BANDS[req.band]}</b> band, resolution <b>{req.gsdLabel}</b>. Stay within 30 kg / 45 W / 120 Mbps.
      </Callout>
      <SectionLabel style={{ marginTop: 18 }}>Instrument type</SectionLabel>
      <OptionList options={INSTR_TYPES} value={type} onChange={(v) => { setType(v); setChecked(false); }} />
      <SectionLabel style={{ marginTop: 18 }}>Spectral band</SectionLabel>
      <OptionList options={BAND_OPTS} value={band} onChange={(v) => { setBand(v); setChecked(false); }} />
      <SectionLabel style={{ marginTop: 18 }}>Aperture diameter — {Dcm} cm</SectionLabel>
      <input type="range" min={5} max={100} value={Dcm}
        onChange={(e) => { setDcm(+e.target.value); setChecked(false); }} style={{ width: "100%" }} />
      {c && (
        <div style={{ marginTop: 16 }}>
          <Bar label="Instrument mass" value={r1(c.mass)} max={30} unit=" kg" good={ck.mass} />
          <Bar label="Instrument power" value={r1(c.power)} max={45} unit=" W" good={ck.power} />
          <Bar label="Downlink volume" value={r0(c.data)} max={120} unit=" Mbps" good={ck.data} />
          <Stat label="Ground resolution" value={fmtGSD(c.gsd)} target={req.gsdLabel} ok={ck.res} />
          <Stat label="Aperture vs. signal floor" value={`${Dcm} cm`} target={`≥ ${minD} cm`} ok={ck.snr} />
        </div>
      )}
      {checked && (
        <Callout ok={pass}>
          {pass
            ? "Instrument closes — it matches the mission and fits every budget. Locked for Module 400."
            : `Not there yet: ${reasons}.`}
        </Callout>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        {!checked && <Btn onClick={() => setChecked(true)} disabled={!c}>Check design</Btn>}
        {checked && !pass && <Btn kind="ghost" onClick={() => setChecked(false)}>Adjust</Btn>}
        {checked && pass && !finished && (
          <Btn kind="good" onClick={() => complete("301", {
            instrument: { type, band, Dcm, mass: r1(c.mass), power: r1(c.power), data: r0(c.data), pointingNeed: POINT_NEED[type] },
          })}>Lock instrument</Btn>
        )}
        {finished && <Btn kind="good" onClick={goNext}>Continue →</Btn>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Module 400 — Satellite Design (Artemis Kit)
// ---------------------------------------------------------------------------
const SUBSYS = {
  bus: { label: "Structure & bus", opts: [
    { id: "6u", label: "6U CubeSat frame", sub: "12 kg capacity", mass: 1.2, cap: 12 },
    { id: "12u", label: "12U CubeSat frame", sub: "24 kg capacity", mass: 2.5, cap: 24 },
    { id: "espa", label: "ESPA-class microsat bus", sub: "180 kg capacity", mass: 40, cap: 180 },
  ] },
  power: { label: "Power generation", opts: [
    { id: "body", label: "Body-mounted cells", sub: "~12 W", gen: 12, mass: 1 },
    { id: "wing", label: "Single deployable wing", sub: "~45 W", gen: 45, mass: 3 },
    { id: "array", label: "Dual deployable array", sub: "~95 W", gen: 95, mass: 6 },
  ] },
  adcs: { label: "Attitude control", opts: [
    { id: "passive", label: "Passive magnetic + dampers", sub: "±5°", point: 5, load: 0.2, mass: 0.3 },
    { id: "mtq", label: "Magnetorquers + 1 wheel", sub: "±1°", point: 1, load: 3, mass: 1.2 },
    { id: "wheels", label: "3-axis wheels + star tracker", sub: "±0.03°", point: 0.03, load: 9, mass: 4 },
  ] },
  comms: { label: "Downlink", opts: [
    { id: "uhf", label: "UHF transceiver", sub: "9.6 kbps", rate: 0.0096, load: 4, mass: 0.5 },
    { id: "sband", label: "S-band", sub: "2 Mbps", rate: 2, load: 12, mass: 1.5 },
    { id: "xband", label: "X-band", sub: "150 Mbps", rate: 150, load: 25, mass: 3 },
  ] },
  thermal: { label: "Thermal control", opts: [
    { id: "mli", label: "Passive MLI", sub: "rejects ~20 W", reject: 20, load: 0, mass: 1 },
    { id: "heat", label: "MLI + heaters", sub: "rejects ~35 W", reject: 35, load: 6, mass: 1.5 },
    { id: "active", label: "Active loop + radiator", sub: "rejects ~120 W", reject: 120, load: 10, mass: 5 },
  ] },
  prop: { label: "Propulsion", opts: [
    { id: "none", label: "None", sub: "0 m/s", dv: 0, load: 0, mass: 0 },
    { id: "cold", label: "Cold-gas", sub: "~35 m/s", dv: 35, load: 1, mass: 2 },
    { id: "mono", label: "Monopropellant", sub: "~130 m/s", dv: 130, load: 2, mass: 6 },
  ] },
};
const SUBSYS_ORDER = ["bus", "power", "adcs", "comms", "thermal", "prop"];
const DEFAULT_INSTR = { type: "optical", band: "vis", Dcm: 20, mass: 11, power: 15, data: 76, pointingNeed: 1 };

function assess(pick, inst) {
  if (SUBSYS_ORDER.some((k) => !pick[k])) return null;
  const g = (k) => SUBSYS[k].opts.find((o) => o.id === pick[k]);
  const bus = g("bus"), pw = g("power"), ad = g("adcs"), cm = g("comms"), th = g("thermal"), pr = g("prop");
  const genW = pw.gen;
  const loadW = 8 + inst.power + ad.load + cm.load + th.load + pr.load;
  const massKg = bus.mass + pw.mass + ad.mass + cm.mass + th.mass + pr.mass + inst.mass;
  const checks = {
    power: genW >= loadW * 1.1,
    mass: massKg <= bus.cap,
    point: ad.point <= inst.pointingNeed,
    data: cm.rate >= inst.data,
    thermal: th.reject >= inst.power + 10,
    dv: pr.dv >= 10,
  };
  return { genW, loadW, massKg, cap: bus.cap, point: ad.point, rate: cm.rate, reject: th.reject, dv: pr.dv, checks, ok: Object.values(checks).every(Boolean) };
}

function Design400({ store, complete, done, goNext }) {
  const inst = store.instrument || DEFAULT_INSTR;
  const [pick, setPick] = useState({});
  const [checked, setChecked] = useState(false);
  const finished = !!done["400"];
  const a = assess(pick, inst);
  const pass = a && a.ok;

  return (
    <>
      <Callout ok>
        Your payload: <b>{inst.mass} kg</b>, <b>{inst.power} W</b>, needs <b>±{inst.pointingNeed}°</b> pointing and <b>{inst.data} Mbps</b> downlink. Pick one option per subsystem so the design closes with ≥ 10 % power margin.
      </Callout>
      {SUBSYS_ORDER.map((k) => (
        <div key={k} style={{ marginTop: 18 }}>
          <SectionLabel>{SUBSYS[k].label}</SectionLabel>
          <OptionList options={SUBSYS[k].opts} value={pick[k]}
            onChange={(v) => { setPick((p) => ({ ...p, [k]: v })); setChecked(false); }} />
        </div>
      ))}
      {a && (
        <div style={{ marginTop: 18 }}>
          <Bar label={`Power  ·  generated ${r0(a.genW)} W`} value={r0(a.loadW)} max={r0(a.genW)} unit=" W consumed" good={a.checks.power} />
          <Bar label="Dry mass" value={r1(a.massKg)} max={a.cap} unit=" kg" good={a.checks.mass} />
          <Stat label="Pointing" value={`±${a.point}°`} target={`±${inst.pointingNeed}°`} ok={a.checks.point} />
          <Stat label="Downlink" value={`${a.rate} Mbps`} target={`≥ ${inst.data} Mbps`} ok={a.checks.data} />
          <Stat label="Heat rejection" value={`${a.reject} W`} target={`≥ ${inst.power + 10} W`} ok={a.checks.thermal} />
          <Stat label="Δv budget" value={`${a.dv} m/s`} target="≥ 10 m/s" ok={a.checks.dv} />
        </div>
      )}
      {checked && (
        <Callout ok={pass}>
          {pass
            ? "The design closes on every subsystem. This is a flyable spacecraft — on to integration."
            : "One or more lines are red. Trade a subsystem — more power, a bigger bus, tighter pointing or a faster downlink — until they all pass."}
        </Callout>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        {!checked && <Btn onClick={() => setChecked(true)} disabled={!a}>Check design</Btn>}
        {checked && !pass && <Btn kind="ghost" onClick={() => setChecked(false)}>Adjust</Btn>}
        {checked && pass && !finished && <Btn kind="good" onClick={() => complete("400", { design: pick })}>Freeze design</Btn>}
        {finished && <Btn kind="good" onClick={goNext}>Continue →</Btn>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Module 401 — Build the Satellite (integration order)
// ---------------------------------------------------------------------------
const BUILD_STEPS = [
  { id: "bus", label: "Bus structure & wiring harness", why: "Everything mounts to the primary structure first." },
  { id: "eps", label: "Power system — battery & solar arrays (stowed)", why: "Power distribution must exist before any powered box can be tested." },
  { id: "obc", label: "Flight computer & avionics", why: "The computer commands every unit installed after it." },
  { id: "adcs", label: "Attitude sensors & reaction wheels", why: "Pointing hardware is aligned to the structure before the payload goes on." },
  { id: "payload", label: "Science instrument — align to boresight", why: "The instrument is co-aligned with the ADCS reference once sensors and wheels are in." },
  { id: "comms", label: "Transponder & antenna", why: "Comms is integrated and RF-tested after avionics and payload." },
  { id: "mli", label: "Thermal blankets (MLI) & bake-out", why: "Blankets go on last so every connector stayed accessible during integration." },
  { id: "test", label: "Deployables test & mass-properties balance", why: "Final step: deployment checks and spin balance before shipping." },
];

function BuildDiagram({ placed }) {
  const on = (id, v = 1) => (placed.includes(id) ? v : 0.08);
  return (
    <svg viewBox="0 0 240 210" style={{ width: "100%", maxWidth: 300, display: "block", margin: "4px auto 10px" }}>
      <g style={{ opacity: on("eps"), transition: "opacity .3s" }}>
        <rect x="10" y="80" width="52" height="40" fill="#14487f" stroke="#7fb8ff" />
        <rect x="178" y="80" width="52" height="40" fill="#14487f" stroke="#7fb8ff" />
        <line x1="62" y1="100" x2="86" y2="100" stroke="#6b7280" strokeWidth="3" />
        <line x1="154" y1="100" x2="178" y2="100" stroke="#6b7280" strokeWidth="3" />
      </g>
      <g style={{ opacity: on("bus"), transition: "opacity .3s" }}>
        <rect x="86" y="70" width="68" height="62" rx="4" fill="#9aa7b8" stroke="#cfe6ff" />
      </g>
      <g style={{ opacity: on("obc"), transition: "opacity .3s" }}>
        <rect x="96" y="84" width="22" height="15" fill="#2a2f3a" stroke="#5f7396" />
      </g>
      <g style={{ opacity: on("adcs"), transition: "opacity .3s" }}>
        <circle cx="128" cy="92" r="5" fill="none" stroke="#5cff8a" />
        <circle cx="139" cy="108" r="5" fill="none" stroke="#5cff8a" />
      </g>
      <g style={{ opacity: on("payload"), transition: "opacity .3s" }}>
        <rect x="104" y="132" width="32" height="16" fill="#1b1f29" stroke="#8fd7ff" />
        <line x1="120" y1="148" x2="120" y2="164" stroke="#8fd7ff" strokeWidth="2" strokeDasharray="3 3" />
      </g>
      <g style={{ opacity: on("comms"), transition: "opacity .3s" }}>
        <line x1="120" y1="70" x2="120" y2="54" stroke="#6b7280" strokeWidth="2" />
        <ellipse cx="120" cy="48" rx="12" ry="6" fill="none" stroke="#e8eef6" />
      </g>
      <rect x="86" y="70" width="68" height="62" rx="4" fill="#d8a12a"
        style={{ opacity: placed.includes("mli") ? 0.45 : 0, transition: "opacity .3s" }} />
      <g style={{ opacity: on("test"), transition: "opacity .3s" }}>
        <path d="M36 180 q84 26 168 0" fill="none" stroke="#5eff9c" strokeWidth="1.5" strokeDasharray="4 4" />
        <text x="120" y="200" textAnchor="middle" fill="#5eff9c" fontSize="10" fontFamily="monospace">balance ✓</text>
      </g>
    </svg>
  );
}

function Build401({ complete, done, goNext }) {
  const finished = !!done["401"];
  const shuffled = useRef(null);
  if (!shuffled.current) {
    shuffled.current = [...BUILD_STEPS].sort(() => Math.random() - 0.5);
  }
  const [placed, setPlaced] = useState([]);
  const [msg, setMsg] = useState(null);
  const [bad, setBad] = useState(null);
  const next = BUILD_STEPS[placed.length];
  const built = placed.length === BUILD_STEPS.length;

  const clickStep = (id) => {
    if (placed.includes(id)) return;
    if (id === next.id) {
      setPlaced((p) => [...p, id]);
      setMsg(null); setBad(null);
    } else {
      setBad(id); setMsg(`Not yet — ${next.why}`);
      setTimeout(() => setBad(null), 400);
    }
  };

  return (
    <>
      <BuildDiagram placed={placed} />
      <SectionLabel>{built ? "Integration complete" : `Install step ${placed.length + 1} of ${BUILD_STEPS.length}`}</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shuffled.current.map((s) => {
          const isPlaced = placed.includes(s.id);
          const order = placed.indexOf(s.id) + 1;
          return (
            <button key={s.id} onClick={() => clickStep(s.id)} disabled={isPlaced} style={{
              textAlign: "left", borderRadius: 8, padding: "10px 12px", fontFamily: UI.mono, fontSize: 13,
              cursor: isPlaced ? "default" : "pointer",
              border: `1px solid ${isPlaced ? "rgba(94,255,156,0.45)" : bad === s.id ? UI.bad : UI.border}`,
              background: isPlaced ? "rgba(94,255,156,0.1)" : "rgba(9,14,28,0.5)",
              color: isPlaced ? "#c9ffe0" : UI.text,
              transform: bad === s.id ? "translateX(4px)" : "none", transition: "transform .1s, border-color .2s",
            }}>
              <span style={{ color: UI.faint, marginRight: 8 }}>{isPlaced ? `${order}.` : "•"}</span>{s.label}
            </button>
          );
        })}
      </div>
      {msg && <Callout ok={false}>{msg}</Callout>}
      {built && <Callout ok>Flight system integrated in the right order. The satellite is ready to ship to the range.</Callout>}
      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        {built && !finished && <Btn kind="good" onClick={() => complete("401")}>Sign off integration</Btn>}
        {finished && <Btn kind="good" onClick={goNext}>Continue →</Btn>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Module 501 — Launch a Satellite
// ---------------------------------------------------------------------------
const SITES = [
  { id: "pmrf", name: "PMRF Barking Sands, Kaua‘i", lat: 22.0 },
  { id: "ccsfs", name: "Cape Canaveral SFS, Florida", lat: 28.5 },
  { id: "vsfb", name: "Vandenberg SFB, California", lat: 34.7 },
  { id: "csg", name: "Guiana Space Centre, Kourou", lat: 5.2 },
  { id: "baik", name: "Baikonur Cosmodrome", lat: 45.6 },
];
function orbitFromBurnout(vKmS, altKm) {
  const r = RE + altKm;
  const invA = 2 / r - (vKmS * vKmS) / MU;
  if (invA <= 0) return { escape: true };
  const a = 1 / invA;
  const other = 2 * a - r;
  return { escape: false, perigee: Math.min(r, other) - RE, apogee: Math.max(r, other) - RE };
}
function bezier(t, p0, p1, p2) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

function Launch501({ store, complete, done, goNext, satName, onApplyOrbit, onOpenView }) {
  const finished = !!done["501"];
  const [siteId, setSiteId] = useState("pmrf");
  const [alt, setAlt] = useState(500);
  const [incl, setIncl] = useState(60);
  const [vco, setVco] = useState(7.6);
  const [phase, setPhase] = useState("setup"); // setup | ascent | result
  const [t, setT] = useState(0);
  const raf = useRef(0);

  const site = SITES.find((s) => s.id === siteId);
  const inclOk = incl >= site.lat - 0.3;
  const o = orbitFromBurnout(vco, alt);
  const orbitOk = !o.escape && o.perigee >= 180 && o.apogee <= 2000;
  const success = inclOk && orbitOk;

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const launch = () => {
    if (!inclOk) return;
    setPhase("ascent");
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / 2200);
      setT(p);
      if (p < 1) raf.current = requestAnimationFrame(step);
      else setPhase("result");
    };
    raf.current = requestAnimationFrame(step);
  };

  const P0 = [26, 182], P1 = [70, 60], P2 = [300, 60];
  const [cx, cy] = bezier(phase === "setup" ? 0 : t, P0, P1, P2);

  const applyAndFly = () => {
    onApplyOrbit && onApplyOrbit({
      altPerigee: Math.round(o.perigee), altApogee: Math.round(o.apogee),
      incDeg: Math.round(incl * 10) / 10, raanDeg: 40, argpDeg: 0,
    });
    if (!finished) complete("501");
    onOpenView && onOpenView("3d");
  };

  return (
    <>
      <svg viewBox="0 0 320 200" style={{ width: "100%", display: "block", background: "rgba(9,14,28,0.5)", border: `1px solid ${UI.border}`, borderRadius: 8, marginBottom: 14 }}>
        <path d="M0 184 H320" stroke="#2a3a58" strokeWidth="2" />
        <path d={`M${P0[0]} ${P0[1]} Q${P1[0]} ${P1[1]} ${P2[0]} ${P2[1]}`} fill="none" stroke="rgba(143,215,255,0.3)" strokeWidth="1.5" strokeDasharray="4 4" />
        {phase === "result" && success && (
          <ellipse cx="300" cy="60" rx="16" ry="10" fill="none" stroke={UI.good} strokeWidth="1.5" />
        )}
        <circle cx={cx} cy={cy} r="4" fill={phase === "result" ? (success ? UI.good : UI.bad) : UI.warn} />
        <text x="10" y="176" fill={UI.faint} fontSize="9" fontFamily="monospace">{site.name.split(",")[0]}</text>
      </svg>

      {phase !== "result" && (
        <>
          <SectionLabel>Launch site</SectionLabel>
          <OptionList options={SITES.map((s) => ({ id: s.id, label: s.name, sub: `latitude ${s.lat}° N` }))}
            value={siteId} onChange={(v) => { setSiteId(v); setPhase("setup"); setT(0); }} />

          <SectionLabel style={{ marginTop: 18 }}>Target altitude — {alt} km</SectionLabel>
          <input type="range" min={300} max={800} value={alt} onChange={(e) => { setAlt(+e.target.value); setPhase("setup"); setT(0); }} style={{ width: "100%" }} />

          <SectionLabel style={{ marginTop: 14 }}>Target inclination — {incl}°</SectionLabel>
          <input type="range" min={0} max={100} value={incl} onChange={(e) => { setIncl(+e.target.value); setPhase("setup"); setT(0); }} style={{ width: "100%" }} />
          {!inclOk && (
            <Callout ok={false}>
              From {site.name} (latitude {site.lat}°) the lowest inclination reachable without a costly plane-change dogleg is {site.lat}°. Raise the inclination or launch from a site nearer the equator.
            </Callout>
          )}

          <SectionLabel style={{ marginTop: 14 }}>Insertion burnout speed — {vco.toFixed(3)} km/s</SectionLabel>
          <input type="range" min={7.0} max={8.2} step={0.005} value={vco} onChange={(e) => { setVco(+e.target.value); setPhase("setup"); setT(0); }} style={{ width: "100%" }} />
          <div style={{ marginTop: 6 }}>
            <Stat label="Predicted perigee" value={o.escape ? "escape" : `${Math.round(o.perigee)} km`} target="≥ 180 km" ok={!o.escape && o.perigee >= 180} />
            <Stat label="Predicted apogee" value={o.escape ? "—" : `${Math.round(o.apogee)} km`} target="≤ 2000 km" ok={!o.escape && o.apogee <= 2000} />
          </div>
          <div style={{ fontSize: 11, color: UI.faint, marginTop: 6, lineHeight: 1.5 }}>
            Tune the burnout speed until perigee and apogee converge — that's a circular orbit at your target altitude. Too slow and perigee drops into the atmosphere; too fast and apogee balloons.
          </div>

          <div style={{ marginTop: 18 }}>
            <Btn onClick={launch} disabled={!inclOk || phase === "ascent"}>{phase === "ascent" ? "Ascending…" : "Launch"}</Btn>
          </div>
        </>
      )}

      {phase === "result" && (
        <>
          <Callout ok={success}>
            {success
              ? `Insertion confirmed. ${satName} is on a ${Math.round(o.perigee)} × ${Math.round(o.apogee)} km orbit at ${incl}° inclination.`
              : o.escape
                ? "Burnout speed exceeded escape velocity — no closed orbit. Ease off and try again."
                : o.perigee < 180
                  ? "Perigee is inside the atmosphere — the orbit decays within days. Add a little burnout speed."
                  : "Apogee ran past 2000 km — too elliptical for this exercise. Reduce burnout speed toward circular."}
          </Callout>
          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <Btn kind="ghost" onClick={() => { setPhase("setup"); setT(0); }}>Reconfigure</Btn>
            {success && <Btn kind="good" onClick={applyAndFly}>Apply orbit &amp; fly it in 3D →</Btn>}
            {success && finished && <Btn onClick={goNext}>Back to modules</Btn>}
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shell + Hub
// ---------------------------------------------------------------------------
function Shell({ level, onBack, isMobile, children }) {
  return (
    <div style={{
      position: "absolute", inset: 0, overflow: "auto", WebkitOverflowScrolling: "touch",
      background: "radial-gradient(circle at 50% 0%, #0b1630 0%, #05070d 62%)",
    }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: isMobile ? "16px 12px 64px" : "28px 22px 88px" }}>
        <button onClick={onBack} style={{
          background: "transparent", border: "none", color: UI.dim, fontSize: 12, cursor: "pointer",
          fontFamily: UI.mono, marginBottom: 14, padding: 0,
        }}>← All modules</button>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <span style={{ fontSize: 26 }}>{level.icon}</span>
          <div>
            <div style={{ fontSize: 10, color: UI.faint, fontFamily: UI.sans, letterSpacing: 0.5 }}>MODULE {level.n} · {level.epet}</div>
            <div style={{ fontSize: isMobile ? 17 : 20, color: "#eaf3ff", fontWeight: 600 }}>{level.title}</div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: UI.dim, lineHeight: 1.55, marginBottom: 20 }}>{level.blurb}</div>
        {children}
      </div>
    </div>
  );
}

function Hub({ isMobile, done, isUnlocked, onOpen, onReset, onFly }) {
  const count = ORDER.filter((id) => done[id]).length;
  const allDone = count === ORDER.length;
  return (
    <div style={{
      position: "absolute", inset: 0, overflow: "auto", WebkitOverflowScrolling: "touch",
      background: "radial-gradient(circle at 50% 0%, #0b1630 0%, #05070d 62%)",
    }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: isMobile ? "18px 12px 64px" : "30px 22px 88px" }}>
        <div style={{ fontSize: 11, letterSpacing: 0.6, color: UI.faint, fontFamily: UI.sans }}>TRAINING TRACK</div>
        <div style={{ fontSize: isMobile ? 20 : 26, color: "#eaf3ff", fontWeight: 700, margin: "2px 0 6px" }}>Space Game</div>
        <div style={{ fontSize: 12, color: UI.dim, lineHeight: 1.6, marginBottom: 16 }}>
          Six modules following the UH Mānoa EPET sequence for robotic space exploration — from first principles to a satellite on orbit. Finish a module to unlock the next; your choices carry forward.
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <div style={{ flex: 1, height: 8, borderRadius: 4, background: "rgba(143,215,255,0.12)", overflow: "hidden" }}>
            <div style={{ width: `${(count / ORDER.length) * 100}%`, height: "100%", background: allDone ? UI.good : UI.accent, transition: "width .3s" }} />
          </div>
          <div style={{ fontSize: 12, color: UI.dim }}>{count} / {ORDER.length}</div>
        </div>

        {allDone && (
          <div style={{ border: `1px solid ${UI.good}`, background: "rgba(94,255,156,0.1)", borderRadius: 10, padding: "14px 16px", marginBottom: 20 }}>
            <div style={{ color: "#c9ffe0", fontSize: 14, fontWeight: 600, marginBottom: 4 }}>EPET track complete 🎓</div>
            <div style={{ color: "#a9e8c4", fontSize: 12, lineHeight: 1.5 }}>You've taken a mission from a science question all the way to launch.</div>
            <div style={{ marginTop: 10 }}><Btn kind="good" onClick={onFly}>Open 3D View</Btn></div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)", gap: 14 }}>
          {LEVELS.map((l) => {
            const unlocked = isUnlocked(l.id);
            const complete = !!done[l.id];
            return (
              <button key={l.id} disabled={!unlocked} onClick={() => onOpen(l.id)} style={{
                textAlign: "left", borderRadius: 12, padding: "14px 16px", fontFamily: UI.mono, color: UI.text,
                border: `1px solid ${complete ? "rgba(94,255,156,0.5)" : unlocked ? UI.borderStrong : "rgba(143,215,255,0.12)"}`,
                background: unlocked ? "rgba(9,14,28,0.6)" : "rgba(9,14,28,0.3)",
                cursor: unlocked ? "pointer" : "not-allowed", opacity: unlocked ? 1 : 0.55,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 22 }}>{l.icon}</span>
                  <span style={{
                    fontSize: 10, letterSpacing: 0.5, padding: "3px 7px", borderRadius: 999,
                    background: complete ? "rgba(94,255,156,0.16)" : unlocked ? "rgba(143,215,255,0.14)" : "transparent",
                    color: complete ? UI.good : unlocked ? UI.accent : UI.faint,
                    border: `1px solid ${complete ? "rgba(94,255,156,0.4)" : unlocked ? "rgba(143,215,255,0.3)" : "rgba(143,215,255,0.15)"}`,
                  }}>{complete ? "COMPLETE" : unlocked ? "START" : "LOCKED"}</span>
                </div>
                <div style={{ fontSize: 10, color: UI.faint, fontFamily: UI.sans, letterSpacing: 0.4 }}>MODULE {l.n} · {l.epet}</div>
                <div style={{ fontSize: 14, color: "#eaf3ff", fontWeight: 600, margin: "1px 0 5px" }}>{l.title}</div>
                <div style={{ fontSize: 11.5, color: UI.dim, lineHeight: 1.5 }}>{l.blurb}</div>
              </button>
            );
          })}
        </div>

        <button onClick={() => { if (window.confirm("Reset all Space Game progress?")) onReset(); }} style={{
          marginTop: 24, background: "transparent", border: "none", color: UI.faint, fontSize: 11,
          cursor: "pointer", fontFamily: UI.mono,
        }}>Reset progress</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function SpaceGame({ isMobile = false, satName = "your satellite", onApplyOrbit, onOpenView }) {
  const [store, setStore] = useState(loadState);
  const [active, setActive] = useState(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* private mode */ }
  }, [store]);

  const done = store.done || {};
  const isUnlocked = (id) => {
    const i = ORDER.indexOf(id);
    return i === 0 || !!done[ORDER[i - 1]];
  };
  const complete = (id, extra) => setStore((s) => ({ ...s, ...extra, done: { ...(s.done || {}), [id]: true } }));
  const reset = () => { setStore({}); setActive(null); };

  if (!active || !isUnlocked(active)) {
    return (
      <Hub isMobile={isMobile} done={done} isUnlocked={isUnlocked}
        onOpen={setActive} onReset={reset} onFly={() => onOpenView && onOpenView("3d")} />
    );
  }

  const level = LEVELS.find((l) => l.id === active);
  const nextId = ORDER[ORDER.indexOf(active) + 1];
  const goNext = () => setActive(nextId && isUnlocked(nextId) ? nextId : null);
  const common = { store, complete, done, goNext };

  return (
    <Shell level={level} isMobile={isMobile} onBack={() => setActive(null)}>
      {active === "101" && <Quiz101 {...common} />}
      {active === "201" && <Mission201 {...common} />}
      {active === "301" && <Instrument301 {...common} />}
      {active === "400" && <Design400 {...common} />}
      {active === "401" && <Build401 {...common} />}
      {active === "501" && <Launch501 {...common} satName={satName} onApplyOrbit={onApplyOrbit} onOpenView={onOpenView} />}
    </Shell>
  );
}
