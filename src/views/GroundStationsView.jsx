import React from "react";
import { btnStyle } from "../lib/ui.js";
import { GS_ELEVATION_MASK_DEG, elevationDeg, groundStationEci, numOr } from "../lib/orbital.js";

/**
 * Ground Stations page: add / edit / remove stations, activate/deactivate them
 * for the maps and pass computation, and pick the focused (selected) station.
 * The selection + station list live in the parent (the 3D scene reads them).
 */
export default function GroundStationsView({
  telem, groundStations, setGroundStations, selectedGSId, setSelectedGSId, isMobile,
}) {
  const satEci = { x: telem.x, y: telem.y, z: telem.z };
  const hasSat = !!(telem.x || telem.y || telem.z);
  const updateGS = (id, field, value) =>
    setGroundStations((list) => list.map((g) => (g.id === id ? { ...g, [field]: value } : g)));

  // Activate / deactivate switch shown next to every station.
  const gsSwitch = (gs, withLabel) => {
    const on = gs.enabled !== false;
    return (
      <button
        onClick={() => updateGS(gs.id, "enabled", !on)}
        title={on ? "Active in map & passes — click to deactivate" : "Deactivated — click to activate"}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, flex: "none",
          padding: withLabel ? "3px 9px 3px 4px" : 3, borderRadius: 999, cursor: "pointer",
          fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, whiteSpace: "nowrap",
          background: on ? "rgba(94,255,156,0.14)" : "rgba(9,14,28,0.6)",
          border: `1px solid ${on ? "rgba(94,255,156,0.45)" : "rgba(143,215,255,0.22)"}`,
          color: on ? "#c9ffe0" : "#5f7396",
        }}
      >
        <span style={{ position: "relative", width: 22, height: 12, borderRadius: 999, flex: "none", background: on ? "rgba(94,255,156,0.5)" : "rgba(143,215,255,0.2)" }}>
          <span style={{ position: "absolute", top: 1, left: on ? 11 : 1, width: 10, height: 10, borderRadius: "50%", background: on ? "#eafff4" : "#7d93b8", transition: "left .12s" }} />
        </span>
        {withLabel && (on ? "ACTIVE" : "OFF")}
      </button>
    );
  };
  const fieldStyle = {
    width: "100%", background: "#0c1428", border: "1px solid rgba(143,215,255,0.25)",
    color: "#cfe6ff", borderRadius: 4, padding: "7px 8px", fontSize: 13, fontFamily: "'IBM Plex Mono',monospace",
  };
  const colMeta = {
    lat: ["Latitude °", -90, 90, 0.0001],
    lon: ["Longitude °", -180, 180, 0.0001],
    alt: ["Altitude km", 0, 100000, 0.1],
  };
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: isMobile ? "20px 12px" : "32px 22px", WebkitOverflowScrolling: "touch" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ fontSize: 13, color: "#7d93b8", marginBottom: 6, fontFamily: "system-ui,sans-serif", letterSpacing: 0.5 }}>GROUND STATIONS</div>
        <div style={{ fontSize: 11, color: "#5f7396", marginBottom: 14, fontFamily: "system-ui,sans-serif", lineHeight: 1.5 }}>
          Stations are plotted as markers in the 3D and 2D views. A green line links a station to the satellite
          whenever the satellite climbs above that station's {GS_ELEVATION_MASK_DEG}° elevation mask — a
          line-of-sight pass.
        </div>

        <div style={{ fontSize: 10, letterSpacing: 0.5, color: "#5f7396", fontFamily: "system-ui,sans-serif", marginBottom: 6 }}>GROUND STATIONS — toggle to activate / deactivate, click name to focus</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          {groundStations.map((gs) => {
            const sel = selectedGSId === gs.id;
            const on = gs.enabled !== false;
            return (
              <div key={gs.id} style={{
                display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 999, padding: "3px 10px 3px 4px",
                background: sel ? "rgba(94,255,156,0.14)" : "rgba(9,14,28,0.6)",
                border: `1px solid ${sel ? "rgba(94,255,156,0.5)" : "rgba(143,215,255,0.18)"}`,
                opacity: on ? 1 : 0.55,
              }}>
                {gsSwitch(gs, false)}
                <button
                  onClick={() => setSelectedGSId(gs.id)}
                  style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: sel ? "#c9ffe0" : "#8fa2c2" }}
                >
                  {sel ? "◉ " : ""}{gs.name || "station"}
                </button>
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {groundStations.map((gs) => {
            const el = hasSat
              ? elevationDeg(satEci, groundStationEci(numOr(gs.lat), numOr(gs.lon), Math.max(0, numOr(gs.alt)), telem.mjd))
              : null;
            const inView = el != null && el >= GS_ELEVATION_MASK_DEG;
            const selected = gs.id === selectedGSId;
            const enabled = gs.enabled !== false;
            return (
              <div key={gs.id} style={{
                background: "rgba(9,14,28,0.5)",
                border: `1px solid ${selected ? "rgba(94,255,156,0.4)" : "rgba(143,215,255,0.14)"}`,
                borderRadius: 8, padding: "12px 14px", opacity: enabled ? 1 : 0.5,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <button
                    onClick={() => setSelectedGSId(gs.id)}
                    title={selected ? "Selected station" : "Select this station"}
                    style={{ background: "transparent", border: "none", color: selected ? "#5eff9c" : "#5f7396", fontSize: 15, cursor: "pointer", padding: 0, lineHeight: 1 }}
                  >
                    {selected ? "◉" : "○"}
                  </button>
                  {gsSwitch(gs, true)}
                  <input value={gs.name} onChange={(e) => updateGS(gs.id, "name", e.target.value)}
                    placeholder="Station name" style={{ ...fieldStyle, flex: 1 }} />
                  <span style={{
                    fontSize: 10, whiteSpace: "nowrap", padding: "3px 8px", borderRadius: 999,
                    color: inView ? "#5eff9c" : "#5f7396",
                    border: `1px solid ${inView ? "rgba(94,255,156,0.4)" : "rgba(143,215,255,0.15)"}`,
                    background: inView ? "rgba(94,255,156,0.12)" : "transparent",
                  }}>
                    {el == null ? "no signal" : inView ? `● in view · ${el.toFixed(0)}°` : `○ below horizon · ${el.toFixed(0)}°`}
                  </span>
                  {groundStations.length > 1 && (
                    <button
                      onClick={() => {
                        const next = groundStations.filter((x) => x.id !== gs.id);
                        setGroundStations(next);
                        if (gs.id === selectedGSId) setSelectedGSId(next[0].id);
                      }}
                      title="Remove"
                      style={{ background: "transparent", border: "none", color: "#5f7396", fontSize: 16, cursor: "pointer", padding: "0 4px" }}
                    >✕</button>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                  {["lat", "lon", "alt"].map((f) => {
                    const [lbl, min, max, step] = colMeta[f];
                    return (
                      <label key={f} style={{ fontSize: 10, color: "#5f7396", fontFamily: "system-ui,sans-serif" }}>
                        {lbl}
                        <input type="number" value={gs[f]} min={min} max={max} step={step}
                          onChange={(e) => updateGS(gs.id, f, e.target.value)} style={{ ...fieldStyle, marginTop: 3 }} />
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <button
          onClick={() => setGroundStations((l) => [...l, { id: `gs${Date.now()}`, name: "New station", lat: 0, lon: 0, alt: 0, enabled: true }])}
          style={{ ...btnStyle, flex: "none", marginTop: 14, padding: "9px 16px" }}
        >
          + Add ground station
        </button>
      </div>
    </div>
  );
}
