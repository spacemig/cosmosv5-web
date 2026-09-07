import * as THREE from "three";

/**
 * Orbital mechanics, scene-coordinate helpers, and the small map/sun math the
 * views share. Extracted verbatim from OrbitViewer.jsx.
 *
 * Scene-coordinate convention used throughout the app: sceneX = ECI_x,
 * sceneY = ECI_z (Earth's rotation/polar axis, drawn vertical), sceneZ = -ECI_y.
 */

export const EARTH_RADIUS_KM = 6371;
export const MU_EARTH = 398600.4418; // km^3/s^2
export const SCENE_UNITS_PER_KM = 1 / 1000; // 1 scene unit = 1000 km

// If the real-world satellite position appears rotated relative to the visible
// continents, the loaded Earth texture likely uses a different longitude
// convention than assumed. Adjust this in degrees to compensate.
export const EARTH_TEXTURE_LON_OFFSET_DEG = 0;

// Elevation mask: a ground station has line-of-sight to the satellite only
// while it sits at least this many degrees above the local horizon.
export const GS_ELEVATION_MASK_DEG = 5;

export function kmToScene(km) {
  return km * SCENE_UNITS_PER_KM;
}

// ---- Two-body Keplerian propagator -----------------------------------------
export function solveKepler(M, e) {
  let E = M;
  for (let i = 0; i < 12; i++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }
  return E;
}

export function keplerToECI(elements, tSec) {
  const { aKm, e, incDeg, raanDeg, argpDeg, epochM } = elements;
  const inc = (incDeg * Math.PI) / 180;
  const raan = (raanDeg * Math.PI) / 180;
  const argp = (argpDeg * Math.PI) / 180;

  const n = Math.sqrt(MU_EARTH / (aKm * aKm * aKm)); // mean motion rad/s
  const M = epochM + n * tSec;
  const E = solveKepler(M % (2 * Math.PI), e);

  const xOrb = aKm * (Math.cos(E) - e);
  const yOrb = aKm * Math.sqrt(1 - e * e) * Math.sin(E);
  const rMag = aKm * (1 - e * Math.cos(E));
  const vFactor = Math.sqrt(MU_EARTH * aKm) / rMag;
  const vxOrb = -vFactor * Math.sin(E);
  const vyOrb = vFactor * Math.sqrt(1 - e * e) * Math.cos(E);

  const cosO = Math.cos(raan), sinO = Math.sin(raan);
  const cosI = Math.cos(inc), sinI = Math.sin(inc);
  const cosW = Math.cos(argp), sinW = Math.sin(argp);

  const r11 = cosO * cosW - sinO * sinW * cosI;
  const r12 = -cosO * sinW - sinO * cosW * cosI;
  const r21 = sinO * cosW + cosO * sinW * cosI;
  const r22 = -sinO * sinW + cosO * cosW * cosI;
  const r31 = sinW * sinI;
  const r32 = cosW * sinI;

  const x = r11 * xOrb + r12 * yOrb;
  const y = r21 * xOrb + r22 * yOrb;
  const z = r31 * xOrb + r32 * yOrb;
  const vx = r11 * vxOrb + r12 * vyOrb;
  const vy = r21 * vxOrb + r22 * vyOrb;
  const vz = r31 * vxOrb + r32 * vyOrb;

  return { x, y, z, vx, vy, vz, rMag };
}

export function precomputeOrbitPath(elements, segments = 256) {
  const pts = [];
  const n = Math.sqrt(MU_EARTH / Math.pow(elements.aKm, 3));
  const period = (2 * Math.PI) / n;
  for (let i = 0; i <= segments; i++) {
    const t = (period * i) / segments;
    const { x, y, z } = keplerToECI(elements, t);
    pts.push(new THREE.Vector3(kmToScene(x), kmToScene(z), -kmToScene(y)));
  }
  return { pts, period };
}

// Convert an ECI position (km) + MJD to geodetic lat/lon (degrees).
export function eciToLatLon(xKm, yKm, zKm, mjd) {
  const theta = gmstRadians(mjd);
  const xe = xKm * Math.cos(theta) + yKm * Math.sin(theta);
  const ye = -xKm * Math.sin(theta) + yKm * Math.cos(theta);
  const lon = (Math.atan2(ye, xe) * 180) / Math.PI;
  const rxy = Math.sqrt(xe * xe + ye * ye);
  const lat = (Math.atan2(zKm, rxy) * 180) / Math.PI;
  return { lat, lon };
}

// Instantaneous state vector (r in km, v in km/s) -> osculating Keplerian
// elements in the shape keplerToECI() expects.
export function stateVectorToElements(rKm, vKmS) {
  const [rx, ry, rz] = rKm;
  const [vx, vy, vz] = vKmS;
  const rMag = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const vMag = Math.sqrt(vx * vx + vy * vy + vz * vz);

  const hx = ry * vz - rz * vy, hy = rz * vx - rx * vz, hz = rx * vy - ry * vx;
  const hMag = Math.sqrt(hx * hx + hy * hy + hz * hz);

  const nx = -hy, ny = hx; // node vector = k x h, nz = 0
  const nMag = Math.sqrt(nx * nx + ny * ny);

  const rDotV = rx * vx + ry * vy + rz * vz;
  const evx = ((vy * hz - vz * hy) / MU_EARTH) - rx / rMag;
  const evy = ((vz * hx - vx * hz) / MU_EARTH) - ry / rMag;
  const evz = ((vx * hy - vy * hx) / MU_EARTH) - rz / rMag;
  const e = Math.sqrt(evx * evx + evy * evy + evz * evz);

  const energy = (vMag * vMag) / 2 - MU_EARTH / rMag;
  const aKm = -MU_EARTH / (2 * energy);

  const incDeg = (Math.acos(Math.max(-1, Math.min(1, hz / hMag))) * 180) / Math.PI;

  let raanDeg = 0;
  if (nMag > 1e-8) {
    raanDeg = (Math.acos(Math.max(-1, Math.min(1, nx / nMag))) * 180) / Math.PI;
    if (ny < 0) raanDeg = 360 - raanDeg;
  }

  let argpDeg = 0;
  if (nMag > 1e-8 && e > 1e-8) {
    const cosArgp = (nx * evx + ny * evy) / (nMag * e);
    argpDeg = (Math.acos(Math.max(-1, Math.min(1, cosArgp))) * 180) / Math.PI;
    if (evz < 0) argpDeg = 360 - argpDeg;
  }

  let nu = 0; // true anomaly
  if (e > 1e-8) {
    const cosNu = (evx * rx + evy * ry + evz * rz) / (e * rMag);
    nu = Math.acos(Math.max(-1, Math.min(1, cosNu)));
    if (rDotV < 0) nu = 2 * Math.PI - nu;
  }
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  const M = E - e * Math.sin(E);

  return { aKm, e, incDeg, raanDeg, argpDeg, epochM: M };
}

export function mjdToISO(mjd) {
  const unixMs = (mjd - 40587) * 86400000;
  return new Date(unixMs).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

// Seconds -> "[Dd ]HH:MM:SS" for mission-elapsed-time display.
export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${d ? d + "d " : ""}${hh}:${mm}:${ss}`;
}

// Greenwich Mean Sidereal Time (radians) for a given MJD — Earth's true
// rotation angle relative to the ECI frame's X axis.
export function gmstRadians(mjd) {
  const jd = mjd + 2400000.5;
  const T = (jd - 2451545.0) / 36525.0;
  let gmstDeg =
    280.46061837 +
    360.98564736629 * (jd - 2451545.0) +
    0.000387933 * T * T -
    (T * T * T) / 38710000.0;
  gmstDeg = ((gmstDeg % 360) + 360) % 360;
  return (gmstDeg * Math.PI) / 180;
}

export const numOr = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// Geodetic (spherical) lat/lon/alt -> ECEF km, then rotate into ECI by GMST.
export function groundStationEci(latDeg, lonDeg, altKm, mjd) {
  const r = EARTH_RADIUS_KM + altKm;
  const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
  const xe = r * Math.cos(lat) * Math.cos(lon);
  const ye = r * Math.cos(lat) * Math.sin(lon);
  const ze = r * Math.sin(lat);
  const th = gmstRadians(mjd);
  return { x: xe * Math.cos(th) - ye * Math.sin(th), y: xe * Math.sin(th) + ye * Math.cos(th), z: ze };
}

// Elevation of a satellite (ECI km) above the local horizon at a ground
// station (ECI km), in degrees. Negative = below the horizon.
export function elevationDeg(sat, gs) {
  const dx = sat.x - gs.x, dy = sat.y - gs.y, dz = sat.z - gs.z;
  const dn = Math.hypot(dx, dy, dz) || 1;
  const gn = Math.hypot(gs.x, gs.y, gs.z) || 1;
  const s = (dx * gs.x + dy * gs.y + dz * gs.z) / (dn * gn);
  return (Math.asin(Math.max(-1, Math.min(1, s))) * 180) / Math.PI;
}

// ---- Web Mercator (clipped at ±85°) --------------------------------------
export const MERCATOR_LAT_LIMIT = 85;
export function mercatorNormY(latDeg) {
  const clamped = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, latDeg));
  const rad = (clamped * Math.PI) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + rad / 2));
  const yMax = Math.log(Math.tan(Math.PI / 4 + (MERCATOR_LAT_LIMIT * Math.PI) / 360));
  return y / yMax;
}
export function latLonToMercatorPx(latDeg, lonDeg, width, height) {
  const x = ((lonDeg + 180) / 360) * width;
  const yNorm = mercatorNormY(latDeg);
  const y = height / 2 - (yNorm * height) / 2;
  return { x, y };
}
export function mercatorNormYToLat(yNorm) {
  const yMax = Math.log(Math.tan(Math.PI / 4 + (MERCATOR_LAT_LIMIT * Math.PI) / 360));
  const rad = 2 * (Math.atan(Math.exp(yNorm * yMax)) - Math.PI / 4);
  return (rad * 180) / Math.PI;
}

// Approximate subsolar point (point on Earth directly under the Sun) for a
// given MJD — low-precision Astronomical Almanac formulas.
export function getSubsolarPoint(mjd) {
  const jd = mjd + 2400000.5;
  const n = jd - 2451545.0;
  const Ldeg = (280.46 + 0.9856474 * n) % 360;
  const gDeg = ((357.528 + 0.9856003 * n) % 360 + 360) % 360;
  const g = (gDeg * Math.PI) / 180;
  const lambdaDeg = Ldeg + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
  const lambda = (lambdaDeg * Math.PI) / 180;
  const eps = ((23.439 - 0.0000004 * n) * Math.PI) / 180;

  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const alpha = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));

  const gmstDeg = (gmstRadians(mjd) * 180) / Math.PI;
  let lon = (alpha * 180) / Math.PI - gmstDeg;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;

  return { lat: (decl * 180) / Math.PI, lon };
}

// Geocentric Sun direction as a unit vector in the ECI (equatorial inertial)
// frame — derived from the subsolar point (dec = lat, RA = lon + GMST).
export function getSunEci(mjd) {
  const s = getSubsolarPoint(mjd);
  const dec = (s.lat * Math.PI) / 180;
  const ra = (s.lon * Math.PI) / 180 + gmstRadians(mjd);
  return { x: Math.cos(dec) * Math.cos(ra), y: Math.cos(dec) * Math.sin(ra), z: Math.sin(dec) };
}

// Low-precision geocentric Moon position in the ECI (equatorial) frame, km.
// Keplerian lunar elements from Paul Schlyter's "How to compute planetary
// positions" (no perturbation terms — a few degrees / few % accuracy, ample
// for a visual). Returns { x, y, z } in km.
export function getMoonEci(mjd) {
  const d = mjd - 51543.0; // days since 1999-12-31 0:00 UT (Schlyter's epoch)
  const rad = Math.PI / 180;
  const N = (125.1228 - 0.0529538083 * d) * rad; // longitude of ascending node
  const inc = 5.1454 * rad;                       // inclination
  const w = (318.0634 + 0.1643573223 * d) * rad;  // argument of perigee
  const a = 60.2666;                              // mean distance, Earth radii
  const e = 0.054900;                             // eccentricity
  const M = (115.3654 + 13.0649929509 * d) * rad; // mean anomaly

  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));

  const xv = a * (Math.cos(E) - e);
  const yv = a * (Math.sqrt(1 - e * e) * Math.sin(E));
  const v = Math.atan2(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv); // distance, Earth radii

  // Position in the ecliptic frame.
  const xh = r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(inc));
  const yh = r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(inc));
  const zh = r * (Math.sin(v + w) * Math.sin(inc));

  // Ecliptic -> equatorial (ECI), then Earth radii -> km.
  const ecl = (23.4393 - 3.563e-7 * d) * rad;
  const kmPerER = EARTH_RADIUS_KM;
  return {
    x: xh * kmPerER,
    y: (yh * Math.cos(ecl) - zh * Math.sin(ecl)) * kmPerER,
    z: (yh * Math.sin(ecl) + zh * Math.cos(ecl)) * kmPerER,
  };
}

// Latitude of the day/night terminator at a given longitude.
export function terminatorLatAtLon(lonDeg, subLat, subLon) {
  const deltaLon = (((lonDeg - subLon + 540) % 360) - 180) * (Math.PI / 180);
  const subLatRad = (subLat * Math.PI) / 180;
  if (Math.abs(subLatRad) < 1e-6) return -Math.sign(Math.cos(deltaLon) || 1) * 89.9;
  const lat = Math.atan(-Math.cos(deltaLon) / Math.tan(subLatRad));
  return (lat * 180) / Math.PI;
}

// Points around the satellite's ground-coverage circle (horizon footprint).
export function groundCoveragePoints(centerLat, centerLon, altKm, steps = 72) {
  const angularRadius = Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + Math.max(altKm, 1)));
  const lat1 = (centerLat * Math.PI) / 180, lon1 = (centerLon * Math.PI) / 180;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (2 * Math.PI * i) / steps;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angularRadius) + Math.cos(lat1) * Math.sin(angularRadius) * Math.cos(bearing)
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(bearing) * Math.sin(angularRadius) * Math.cos(lat1),
      Math.cos(angularRadius) - Math.sin(lat1) * Math.sin(lat2)
    );
    pts.push({ lat: (lat2 * 180) / Math.PI, lon: (((lon2 * 180) / Math.PI + 540) % 360) - 180 });
  }
  return pts;
}
