import React from "react";

// Layered realm → node diagram (SVG). Satellites on top, ground stations in
// the middle, MOCs on the bottom; double-headed arrows link adjacent layers.
export default function RealmDiagram({ example }) {
  const W = 520, boxW = 152, boxH = 32, gapX = 16, rowGap = 66, padT = 18, padB = 8;
  const rows = example.layers;
  const H = padT + (rows.length - 1) * rowGap + boxH + padB;
  const layout = rows.map((row, ri) => {
    const n = row.nodes.length;
    const total = n * boxW + (n - 1) * gapX;
    const startX = (W - total) / 2;
    const y = padT + ri * rowGap;
    return row.nodes.map((name, ni) => {
      const x = startX + ni * (boxW + gapX);
      return { name, x, y, cx: x + boxW / 2, top: y, bottom: y + boxH };
    });
  });
  const links = [];
  for (let ri = 0; ri + 1 < layout.length; ri++) {
    for (const a of layout[ri]) for (const b of layout[ri + 1]) links.push([a.cx, a.bottom, b.cx, b.top]);
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
      <defs>
        <marker id="rdArrow" markerWidth="8" markerHeight="8" refX="5.5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#7d93b8" />
        </marker>
      </defs>
      {links.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#7d93b8" strokeWidth="1"
          markerStart="url(#rdArrow)" markerEnd="url(#rdArrow)" />
      ))}
      {rows.map((row, ri) => (
        <text key={`k${ri}`} x="2" y={padT + ri * rowGap + boxH / 2} dominantBaseline="central"
          fill="#5f7396" fontSize="8" letterSpacing="0.5" fontFamily="system-ui, sans-serif">{row.kind.toUpperCase()}</text>
      ))}
      {layout.map((row, ri) => row.map((b, bi) => (
        <g key={`${ri}-${bi}`}>
          <rect x={b.x} y={b.y} width={boxW} height={boxH} rx="6" fill="rgba(9,14,28,0.9)" stroke="rgba(143,215,255,0.35)" />
          <text x={b.cx} y={b.y + boxH / 2} textAnchor="middle" dominantBaseline="central"
            fill="#cfe6ff" fontSize="10" fontFamily="'IBM Plex Mono', monospace"
            textLength={b.name.length > 20 ? boxW - 14 : undefined} lengthAdjust="spacingAndGlyphs">{b.name}</text>
        </g>
      )))}
    </svg>
  );
}
