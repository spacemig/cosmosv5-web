import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

/**
 * Cosmos Engine — Orbit Viewer
 * ----------------------------------------------------------------------------
 * Frontend visualization module for the "cosmos web"/"cosmos engine" tool.
 *
 * Data contract: this component expects position updates shaped like the JSON
 * `propagatorv3` (cosmosv5-agent/programs/general/propagatorv3.cpp) actually
 * emits when run with `"postevent":1` (broadcast on UDP port 10031, relayed
 * to the browser by bridge/server.js). One packet looks like:
 *
 *   {
 *     "mtype": "soh",
 *     "utc": 60107.512345,             // MJD
 *     "node": "mother",
 *     "ecipos": {                      // full `cartpos` struct, not flat x/y/z
 *       "utc": 60107.512345,
 *       "s": { "col": [x, y, z] },     // meters, ECI frame
 *       "v": { "col": [vx, vy, vz] },
 *       "a": { "col": [ax, ay, az] }
 *     },
 *     "alphaatt": { "w":.., "x":.., "y":.., "z":.. }
 *   }
 *
 * (propagatorv3 uses "scipos" in this same slot for timesteps near the Moon;
 * the bridge normalizes that back to "ecipos" before relaying.)
 *
 * Until a live bridge is connected, this view runs a client-side two-body
 * Keplerian propagator so the visualization is usable standalone.
 */

const EARTH_RADIUS_KM = 6371;
const MU_EARTH = 398600.4418; // km^3/s^2
const SCENE_UNITS_PER_KM = 1 / 1000; // 1 scene unit = 1000 km

function kmToScene(km) {
  return km * SCENE_UNITS_PER_KM;
}

// ---- Two-body Keplerian propagator -----------------------------------------
function solveKepler(M, e) {
  let E = M;
  for (let i = 0; i < 12; i++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }
  return E;
}

function keplerToECI(elements, tSec) {
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

function precomputeOrbitPath(elements, segments = 256) {
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

// ---- Procedural earth texture (no external asset dependency) --------------
function buildEarthTexture() {
  const w = 1024, h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");

  const ocean = ctx.createLinearGradient(0, 0, 0, h);
  ocean.addColorStop(0, "#08243f");
  ocean.addColorStop(0.5, "#0b3358");
  ocean.addColorStop(1, "#08243f");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, w, h);

  // pseudo-random continents via layered blobs (seeded)
  let seed = 1337;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  ctx.fillStyle = "#1c5c3a";
  for (let i = 0; i < 46; i++) {
    const cx = rand() * w, cy = rand() * h;
    const rx = 30 + rand() * 90, ry = 18 + rand() * 50;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#2a6b46";
  for (let i = 0; i < 60; i++) {
    const cx = rand() * w, cy = rand() * h;
    const r = 6 + rand() * 20;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // lat/lon grid
  ctx.strokeStyle = "rgba(140,200,255,0.18)";
  ctx.lineWidth = 1;
  for (let lon = 0; lon <= w; lon += w / 12) {
    ctx.beginPath(); ctx.moveTo(lon, 0); ctx.lineTo(lon, h); ctx.stroke();
  }
  for (let lat = 0; lat <= h; lat += h / 6) {
    ctx.beginPath(); ctx.moveTo(0, lat); ctx.lineTo(w, lat); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(140,200,255,0.4)";
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

// Real Earth imagery (three.js's own hosted example textures — public, CORS-enabled).
// Falls back to the procedural texture above if a network fetch fails.
const EARTH_TEXTURE_URLS = {
  map: "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg",
  bump: "https://threejs.org/examples/textures/planets/earth_normal_2048.jpg",
  specular: "https://threejs.org/examples/textures/planets/earth_specular_2048.jpg",
  clouds: "https://threejs.org/examples/textures/planets/earth_clouds_1024.png",
};

function loadEarthTextures(onReady) {
  const loader = new THREE.TextureLoader();
  loader.crossOrigin = "anonymous";
  const result = {};
  let pending = 3; // map, bump/normal, specular are required; clouds is a bonus layer
  const done = () => { if (--pending === 0) onReady(result); };

  loader.load(EARTH_TEXTURE_URLS.map, (t) => { result.map = t; done(); }, undefined, done);
  loader.load(EARTH_TEXTURE_URLS.bump, (t) => { result.normalMap = t; done(); }, undefined, done);
  loader.load(EARTH_TEXTURE_URLS.specular, (t) => { result.specularMap = t; done(); }, undefined, done);
  loader.load(EARTH_TEXTURE_URLS.clouds, (t) => { result.clouds = t; }, undefined, () => {});
}

function buildStarfield(count = 2400) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 400 + Math.random() * 300;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0x9fc6ff, size: 0.6, sizeAttenuation: true });
  return new THREE.Points(geo, mat);
}

// Convert an ECI position (km) + MJD to geodetic lat/lon (degrees).
function eciToLatLon(xKm, yKm, zKm, mjd) {
  const theta = gmstRadians(mjd);
  const xe = xKm * Math.cos(theta) + yKm * Math.sin(theta);
  const ye = -xKm * Math.sin(theta) + yKm * Math.cos(theta);
  const lon = (Math.atan2(ye, xe) * 180) / Math.PI;
  const rxy = Math.sqrt(xe * xe + ye * ye);
  const lat = (Math.atan2(zKm, rxy) * 180) / Math.PI;
  return { lat, lon };
}

// Convert an instantaneous state vector (r in km, v in km/s) into the same
// osculating-Keplerian-element shape keplerToECI()/precomputeOrbitPath()
// expect, so "future trajectory" can be drawn from live telemetry the same
// way the simulated-mode preview ellipse is drawn from slider values. This
// is a standard two-body (Keplerian) fit to the current state — it won't
// capture perturbations, but is accurate for a near-term forward prediction.
function stateVectorToElements(rKm, vKmS) {
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

// If the real-world satellite position appears rotated relative to the
// visible continents, the loaded Earth texture likely uses a different
// longitude convention than assumed (e.g. Pacific-centered vs
// Greenwich-centered). Adjust this in degrees to compensate — use the
// Hawaii ground station marker as a known-truth calibration reference
// rather than the satellite, since the marker's true position is fixed
// and known exactly, while judging the satellite's position by eye is not.
const EARTH_TEXTURE_LON_OFFSET_DEG = 0;

function mjdToISO(mjd) {
  const unixMs = (mjd - 40587) * 86400000;
  return new Date(unixMs).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

// Greenwich Mean Sidereal Time, in radians, for a given MJD. This is Earth's
// true rotation angle relative to the ECI frame's X axis (vernal equinox) —
// using this instead of an arbitrary spin rate keeps ground stations/continents
// correctly aligned under the satellite instead of drifting independently.
function gmstRadians(mjd) {
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

// Standard lat/lon (degrees) -> position on a sphere of radius `r`, matching
// the UV convention of a typical equirectangular Earth texture on a
// THREE.SphereGeometry (Y = polar axis, consistent with the rest of this file).
function latLonToVector3(latDeg, lonDeg, r) {
  const phi = ((90 - latDeg) * Math.PI) / 180;
  const theta = ((lonDeg + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}

// UH Manoa, Pacific Ocean Science & Technology (POST) building.
const HAWAII_GROUND_STATION = { name: "UH Manoa (POST)", lat: 21.2975, lon: -157.8161 };

function makeAxisLabel(text, hexColor) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.font = "bold 48px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = hexColor;
  ctx.fillText(text, size / 2, size / 2);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.9, 0.9, 0.9);
  return sprite;
}

function buildEciAxes(lengthScene) {
  const group = new THREE.Group();
  // Scene-coordinate convention used throughout this file: sceneX = ECI_x,
  // sceneY = ECI_z (Earth's rotation/polar axis, drawn vertical), sceneZ = -ECI_y.
  const axes = [
    { dir: new THREE.Vector3(1, 0, 0), color: 0xff5c5c, label: "X (ECI)" },
    { dir: new THREE.Vector3(0, 0, -1), color: 0x5cff8a, label: "Y (ECI)" },
    { dir: new THREE.Vector3(0, 1, 0), color: 0x5c9cff, label: "Z (ECI)" },
  ];
  axes.forEach(({ dir, color, label }) => {
    const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), lengthScene, color, lengthScene * 0.08, lengthScene * 0.04);
    group.add(arrow);
    const sprite = makeAxisLabel(label, `#${color.toString(16).padStart(6, "0")}`);
    sprite.position.copy(dir.clone().multiplyScalar(lengthScene * 1.12));
    group.add(sprite);
  });
  return group;
}

const COSMOS_WEB_VERSION = "0.2.7";

// Web Mercator projection, clipped at ±85° (the standard limit — Mercator
// diverges at the poles). Returns a normalized value in roughly [-1, 1].
// Used for BOTH the map background remap and marker plotting so they stay
// pixel-aligned with each other.
const MERCATOR_LAT_LIMIT = 85;
function mercatorNormY(latDeg) {
  const clamped = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, latDeg));
  const rad = (clamped * Math.PI) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + rad / 2));
  const yMax = Math.log(Math.tan(Math.PI / 4 + (MERCATOR_LAT_LIMIT * Math.PI) / 360));
  return y / yMax;
}
function latLonToMercatorPx(latDeg, lonDeg, width, height) {
  const x = ((lonDeg + 180) / 360) * width;
  const yNorm = mercatorNormY(latDeg);
  const y = height / 2 - (yNorm * height) / 2;
  return { x, y };
}
// Inverse: given a normalized Mercator y in [-1,1], return latitude in degrees.
function mercatorNormYToLat(yNorm) {
  const yMax = Math.log(Math.tan(Math.PI / 4 + (MERCATOR_LAT_LIMIT * Math.PI) / 360));
  const rad = 2 * (Math.atan(Math.exp(yNorm * yMax)) - Math.PI / 4);
  return (rad * 180) / Math.PI;
}

// Approximate subsolar point (the point on Earth directly under the sun) for
// a given MJD, using the standard low-precision solar position formulas from
// the Astronomical Almanac. Accurate to a fraction of a degree — plenty for
// a day/night terminator overlay.
function getSubsolarPoint(mjd) {
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

// Latitude of the day/night terminator at a given longitude, for a sun at
// (subLat, subLon). The terminator is a great circle, so this traces a
// smooth wave across longitude — cheap to sample per-column rather than
// per-pixel.
function terminatorLatAtLon(lonDeg, subLat, subLon) {
  const deltaLon = (((lonDeg - subLon + 540) % 360) - 180) * (Math.PI / 180);
  const subLatRad = (subLat * Math.PI) / 180;
  if (Math.abs(subLatRad) < 1e-6) return -Math.sign(Math.cos(deltaLon) || 1) * 89.9;
  const lat = Math.atan(-Math.cos(deltaLon) / Math.tan(subLatRad));
  return (lat * 180) / Math.PI;
}

// Points around the satellite's ground-coverage circle (horizon visibility
// footprint) at a given sub-satellite point and altitude.
function groundCoveragePoints(centerLat, centerLon, altKm, steps = 72) {
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

export default function OrbitViewer() {
  const mountRef = useRef(null);
  const sceneRef = useRef({});
  const [activeView, setActiveView] = useState("3d");
  // Ground-track history and future ground-track, in lat/lon — populated by
  // the 3D scene's animation loop but read by the 2D map view, so both views
  // stay in sync from a single source of computation.
  const groundTrackRef = useRef([]); // [{lat, lon}, ...] oldest first
  const futureGroundTrackRef = useRef([]); // [{lat, lon}, ...] one period ahead
  const telemRef = useRef(null);
  const [orbitEl, setOrbitEl] = useState({
    altPerigee: 550,
    altApogee: 550,
    incDeg: 51.6,
    raanDeg: 40,
    argpDeg: 0,
  });
  const [speed, setSpeed] = useState(60);
  const [running, setRunning] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [showSun, setShowSun] = useState(true);
  const [showFuture, setShowFuture] = useState(false);
  const [nodeName, setNodeName] = useState("propagator-sim");
  const [satName, setSatName] = useState("ISS (ZARYA)");
  const [wsUrl, setWsUrl] = useState("");
  const [linkState, setLinkState] = useState("SIMULATED"); // SIMULATED | CONNECTING | LIVE | ERROR
  const [telem, setTelem] = useState({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, alt: 0, mjd: 60107.0 });
  useEffect(() => { telemRef.current = telem; }, [telem]);
  const wsRef = useRef(null);
  const liveTargetRef = useRef(null);

  const elementsRef = useRef(null);

  const rebuildElements = useCallback(() => {
    const rp = EARTH_RADIUS_KM + Number(orbitEl.altPerigee);
    const ra = EARTH_RADIUS_KM + Number(orbitEl.altApogee);
    const aKm = (rp + ra) / 2;
    const e = ra === rp ? 0 : (ra - rp) / (ra + rp);
    elementsRef.current = {
      aKm, e,
      incDeg: Number(orbitEl.incDeg),
      raanDeg: Number(orbitEl.raanDeg),
      argpDeg: Number(orbitEl.argpDeg),
      epochM: 0,
    };
    return elementsRef.current;
  }, [orbitEl]);

  // ---- Three.js scene setup (once) -----------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    const width = mount.clientWidth, height = mount.clientHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 2000);
    let camDist = 26, camTheta = 0.9, camPhi = 1.15;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    scene.add(buildStarfield());

    const earthGeo = new THREE.SphereGeometry(kmToScene(EARTH_RADIUS_KM), 64, 64);
    const earthMat = new THREE.MeshPhongMaterial({ map: buildEarthTexture(), shininess: 8 });
    const earth = new THREE.Mesh(earthGeo, earthMat);
    scene.add(earth);

    let clouds = null;
    loadEarthTextures((tex) => {
      if (tex.map) { earthMat.map = tex.map; earthMat.emissiveMap = tex.map; }
      if (tex.normalMap) { earthMat.normalMap = tex.normalMap; earthMat.normalScale = new THREE.Vector2(0.6, 0.6); }
      if (tex.specularMap) { earthMat.specularMap = tex.specularMap; earthMat.specular = new THREE.Color(0x333333); }
      earthMat.needsUpdate = true;

      if (tex.clouds) {
        const cloudGeo = new THREE.SphereGeometry(kmToScene(EARTH_RADIUS_KM) * 1.008, 64, 64);
        const cloudMat = new THREE.MeshLambertMaterial({
          map: tex.clouds, transparent: true, opacity: 0.55, depthWrite: false,
        });
        clouds = new THREE.Mesh(cloudGeo, cloudMat);
        earth.add(clouds);
      }
    });

    const rimGeo = new THREE.SphereGeometry(kmToScene(EARTH_RADIUS_KM) * 1.015, 48, 48);
    const rimMat = new THREE.MeshBasicMaterial({ color: 0x3fa9ff, transparent: true, opacity: 0.06, side: THREE.BackSide });
    scene.add(new THREE.Mesh(rimGeo, rimMat));

    const ambient = new THREE.AmbientLight(0x223344, 1.1);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(30, 10, 20);
    scene.add(sun);

    const orbitLineGeo = new THREE.BufferGeometry();
    const orbitLineMat = new THREE.LineBasicMaterial({ color: 0x8fd7ff, transparent: true, opacity: 0.35 });
    const orbitLine = new THREE.Line(orbitLineGeo, orbitLineMat);
    scene.add(orbitLine);

    // Trailing path: the satellite's actual recent positions, works the same
    // way in both SIMULATED and LIVE mode (unlike orbitLine above, which is
    // only a client-side Keplerian *preview* and doesn't reflect real telemetry).
    const TRAIL_MAX_POINTS = 400;
    const trailGeo = new THREE.BufferGeometry();
    const trailPositions = new Float32Array(TRAIL_MAX_POINTS * 3);
    trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
    trailGeo.setDrawRange(0, 0);
    const trailMat = new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.85 });
    const trailLine = new THREE.Line(trailGeo, trailMat);
    scene.add(trailLine);
    const trailPoints = []; // array of THREE.Vector3, oldest first

    // Future trajectory: predicted forward path from the current state
    // vector (works in both SIM and LIVE mode), distinct from the trailing
    // history above and the slider-based preview ellipse (SIM-only).
    const futureGeo = new THREE.BufferGeometry();
    const futureMat = new THREE.LineDashedMaterial({ color: 0x5eff9c, dashSize: 0.15, gapSize: 0.1, transparent: true, opacity: 0.7 });
    const futureLine = new THREE.Line(futureGeo, futureMat);
    futureLine.visible = false;
    scene.add(futureLine);

    const eciAxes = buildEciAxes(kmToScene(EARTH_RADIUS_KM) * 2.2);
    scene.add(eciAxes);

    // Ground station marker — parented to `earth`, not `scene`, since a
    // ground station is fixed to Earth's surface and must rotate with it
    // (unlike the satellite, which lives in the inertial ECI frame).
    const gsGroup = new THREE.Group();
    const gsPos = latLonToVector3(HAWAII_GROUND_STATION.lat, HAWAII_GROUND_STATION.lon, kmToScene(EARTH_RADIUS_KM));
    const gsMarkerGeo = new THREE.ConeGeometry(0.06, 0.16, 8);
    const gsMarkerMat = new THREE.MeshBasicMaterial({ color: 0x5eff9c });
    const gsMarker = new THREE.Mesh(gsMarkerGeo, gsMarkerMat);
    gsMarker.position.copy(gsPos);
    gsMarker.lookAt(gsPos.clone().multiplyScalar(2)); // point outward, away from center
    gsMarker.rotateX(Math.PI / 2);
    gsGroup.add(gsMarker);
    const gsLabel = makeAxisLabel(HAWAII_GROUND_STATION.name, "#5eff9c");
    gsLabel.position.copy(gsPos.clone().multiplyScalar(1.12));
    gsLabel.scale.set(1.4, 0.7, 1);
    gsGroup.add(gsLabel);
    earth.add(gsGroup);

    const satGeo = new THREE.SphereGeometry(0.09, 16, 16);
    const satMat = new THREE.MeshBasicMaterial({ color: 0xffb454 });
    const satellite = new THREE.Mesh(satGeo, satMat);
    scene.add(satellite);

    const glowGeo = new THREE.SphereGeometry(0.22, 12, 12);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.25 });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    satellite.add(glow);

    // manual orbit-camera controls (r128 has no OrbitControls import)
    let dragging = false, lastX = 0, lastY = 0;
    const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
    const onUp = () => { dragging = false; };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      camTheta += dx * 0.005;
      camPhi = Math.min(Math.max(camPhi - dy * 0.005, 0.15), Math.PI - 0.15);
    };
    const onWheel = (e) => {
      e.preventDefault();
      camDist = Math.min(Math.max(camDist + e.deltaY * 0.01, 8), 90);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    function updateCamera() {
      camera.position.set(
        camDist * Math.sin(camPhi) * Math.cos(camTheta),
        camDist * Math.cos(camPhi),
        camDist * Math.sin(camPhi) * Math.sin(camTheta)
      );
      camera.lookAt(0, 0, 0);
    }
    updateCamera();

    sceneRef.current = {
      scene, camera, renderer, earth, orbitLine, orbitLineGeo, satellite, eciAxes,
      trailLine, trailPoints, sun, ambient, earthMat, orbitLineMat, trailMat, futureLine, futureGeo,
      updateCamera, getCamState: () => ({ camDist, camTheta, camPhi }),
      setCamState: (s) => { camDist = s.camDist; camTheta = s.camTheta; camPhi = s.camPhi; },
    };

    let raf;
    let simTime = 0;
    let lastFrame = performance.now();
    let currentMjd = 60107;
    let lastGroundTrackMjd = -Infinity;
    const GROUND_TRACK_SAMPLE_INTERVAL_DAYS = 30 / 86400; // one sample per 30s of mission time
    const GROUND_TRACK_WINDOW_DAYS = 1.5 / 24; // retain 1.5 hours of mission time
    let cloudDrift = 0;
    let lastTrailPush = 0;
    let lastFutureUpdate = 0;

    const FUTURE_GROUND_TRACK_SECONDS = 1.5 * 3600;

    const updateFutureTrajectory = (xKm, yKm, zKm, vxKmS, vyKmS, vzKmS) => {
      if (!sceneRef.current.control || !sceneRef.current.control.showFuture) return;
      try {
        const els = stateVectorToElements([xKm, yKm, zKm], [vxKmS, vyKmS, vzKmS]);
        if (!(els.aKm > 0) || els.e >= 1) return; // skip degenerate/hyperbolic fits
        const { pts } = precomputeOrbitPath(els, 180); // 3D line: one full period, unchanged
        futureGeo.setFromPoints(pts);
        futureLine.computeLineDistances();
        futureLine.visible = true;

        // Ground track needs each point's own advancing time (Earth rotates
        // under the orbit), unlike the 3D path which lives in the fixed
        // inertial frame — so this is computed separately, over a fixed
        // 1.5-hour window (not tied to the orbital period).
        const groundSamples = [];
        const steps = 90;
        for (let i = 0; i <= steps; i++) {
          const t = (FUTURE_GROUND_TRACK_SECONDS * i) / steps;
          const p = keplerToECI(els, t);
          const mjdAtT = currentMjd + t / 86400;
          groundSamples.push(eciToLatLon(p.x, p.y, p.z, mjdAtT));
        }
        futureGroundTrackRef.current = groundSamples;
      } catch (e) { /* skip a bad fit silently, try again next tick */ }
    };

    const pushTrailPoint = (vec3) => {
      trailPoints.push(vec3.clone());
      if (trailPoints.length > TRAIL_MAX_POINTS) trailPoints.shift();
      const attr = trailGeo.getAttribute("position");
      for (let i = 0; i < trailPoints.length; i++) {
        attr.setXYZ(i, trailPoints[i].x, trailPoints[i].y, trailPoints[i].z);
      }
      attr.needsUpdate = true;
      trailGeo.setDrawRange(0, trailPoints.length);
    };

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = (now - lastFrame) / 1000;
      lastFrame = now;

      // Earth's rotation is tied to real sidereal time (GMST) at the
      // satellite's current UTC, not an arbitrary spin rate — this keeps the
      // ground station and continents correctly positioned under the orbit
      // instead of drifting independently of it.
      earth.rotation.y = gmstRadians(currentMjd) + (EARTH_TEXTURE_LON_OFFSET_DEG * Math.PI) / 180;
      cloudDrift += dt * 0.006;
      if (clouds) clouds.rotation.y = gmstRadians(currentMjd) + cloudDrift;
      updateCamera();

      const ctrl = sceneRef.current.control;
      let curXKm = null, curYKm = null, curZKm = null;
      if (ctrl && ctrl.running) {
        if (ctrl.mode === "sim") {
          simTime += dt * ctrl.speed;
          const els = ctrl.elements;
          const { x, y, z, vx, vy, vz, rMag } = keplerToECI(els, simTime);
          satellite.position.set(kmToScene(x), kmToScene(z), -kmToScene(y));
          currentMjd = 60107 + simTime / 86400;
          curXKm = x; curYKm = y; curZKm = z;
          ctrl.onTelem({
            x, y, z, vx, vy, vz,
            alt: rMag - EARTH_RADIUS_KM,
            mjd: currentMjd,
          });
          if (now - lastFutureUpdate > 3000) {
            lastFutureUpdate = now;
            updateFutureTrajectory(x, y, z, vx, vy, vz);
          }
        } else if (ctrl.mode === "live" && liveTargetRef.current) {
          const t = liveTargetRef.current;
          satellite.position.lerp(
            new THREE.Vector3(kmToScene(t.x), kmToScene(t.z), -kmToScene(t.y)),
            Math.min(1, dt * 4)
          );
          if (t.mjd) currentMjd = t.mjd;
          curXKm = t.x; curYKm = t.y; curZKm = t.z;
          if (now - lastFutureUpdate > 3000) {
            lastFutureUpdate = now;
            updateFutureTrajectory(t.x, t.y, t.z, t.vx || 0, t.vy || 0, t.vz || 0);
          }
        }

        if (now - lastTrailPush > 150) {
          lastTrailPush = now;
          pushTrailPoint(satellite.position);
        }

        // Ground track sampling is driven by mission time, not wall-clock —
        // otherwise a 1.5-hour window at 1x speed would need ~36,000 points
        // (one per 150ms of real time), while at 600x speed it would barely
        // sample at all. Fixed mission-time spacing keeps a consistent,
        // reasonably-sized trail regardless of playback speed.
        if (curXKm != null && currentMjd - lastGroundTrackMjd >= GROUND_TRACK_SAMPLE_INTERVAL_DAYS) {
          lastGroundTrackMjd = currentMjd;
          const { lat, lon } = eciToLatLon(curXKm, curYKm, curZKm, currentMjd);
          groundTrackRef.current.push({ lat, lon, mjd: currentMjd });
          while (
            groundTrackRef.current.length > 1 &&
            currentMjd - groundTrackRef.current[0].mjd > GROUND_TRACK_WINDOW_DAYS
          ) {
            groundTrackRef.current.shift();
          }
        }
      }
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push current control state into the render loop each render
  useEffect(() => {
    const els = rebuildElements();
    const { pts, period } = precomputeOrbitPath(els);
    const s = sceneRef.current;
    if (s.orbitLineGeo) {
      s.orbitLineGeo.setFromPoints(pts);
    }
    if (s.eciAxes) {
      s.eciAxes.visible = showAxes;
    }
    if (s.sun && s.ambient) {
      // "Sun off" swaps directional lighting for flat, uniform brightness so
      // the whole globe reads clearly regardless of local time-of-day —
      // useful for visually placing a location that's currently in darkness.
      // Emissive is used (not just ambient) because ambient light alone can
      // still look dim/flat depending on the material's response; emissive
      // guarantees uniform brightness independent of light angle entirely.
      s.sun.intensity = showSun ? 1.4 : 0;
      s.ambient.intensity = showSun ? 1.1 : 0.5;
      if (s.earthMat) {
        // Reproduce the texture's own daylit colors uniformly (day AND night
        // side) rather than adding a flat grey wash, which desaturates and
        // overexposes the result. Using the map itself as the emissive map
        // means "sun off" looks like natural daylight everywhere, not a haze.
        if (!s.earthMat.emissiveMap) s.earthMat.emissiveMap = s.earthMat.map;
        s.earthMat.emissive = new THREE.Color(0xffffff);
        s.earthMat.emissiveIntensity = showSun ? 0 : 1.0;
      }
      if (s.orbitLineMat) s.orbitLineMat.opacity = showSun ? 0.35 : 0.75;
      if (s.trailMat) s.trailMat.opacity = showSun ? 0.85 : 1.0;
    }
    const nextMode = linkState === "LIVE" ? "live" : "sim";
    if (s.orbitLine) {
      // The precomputed ellipse is only a preview of the slider-configured
      // orbit — once real telemetry is driving the satellite it may not
      // match the actual orbit shape, so hide it to avoid a misleading line.
      s.orbitLine.visible = nextMode === "sim";
    }
    if (s.control && s.control.mode !== nextMode && s.trailPoints) {
      // Clear the trail on a sim<->live switch so it doesn't draw a straight
      // line connecting two unrelated trajectories.
      s.trailPoints.length = 0;
      if (s.trailLine) s.trailLine.geometry.setDrawRange(0, 0);
      groundTrackRef.current = [];
    }
    s.control = {
      running,
      speed: Number(speed),
      elements: els,
      mode: nextMode,
      onTelem: setTelem,
      period,
      showFuture,
    };
    if (!showFuture && s.futureLine) { s.futureLine.visible = false; futureGroundTrackRef.current = []; }
  }, [orbitEl, speed, running, linkState, rebuildElements, showAxes, showSun, showFuture]);

  // ---- WebSocket bridge (optional live mode) --------------------------------
  const connect = () => {
    if (!wsUrl) return;
    try {
      setLinkState("CONNECTING");
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => setLinkState("LIVE");
      ws.onclose = () => setLinkState("SIMULATED");
      ws.onerror = () => setLinkState("ERROR");
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.node) setNodeName(msg.node);
          // propagatorv3 serializes ecipos as a full `cartpos` struct, not a
          // flat {x,y,z}: { utc, s:{col:[x,y,z]}, v:{col:[...]}, a:{col:[...]} }
          // — positions in meters (SI). The bridge already normalizes
          // scipos -> ecipos for near-Moon timesteps.
          const posField = msg.ecipos;
          const col = posField && posField.s && posField.s.col;
          const velCol = posField && posField.v && posField.v.col;
          if (Array.isArray(col) && col.length === 3) {
            const x = col[0] / 1000, y = col[1] / 1000, z = col[2] / 1000;
            let vx = 0, vy = 0, vz = 0;
            if (Array.isArray(velCol) && velCol.length === 3) {
              vx = velCol[0] / 1000; vy = velCol[1] / 1000; vz = velCol[2] / 1000;
            }
            liveTargetRef.current = { x, y, z, vx, vy, vz, mjd: msg.utc };
            const rMag = Math.sqrt(x * x + y * y + z * z);
            setTelem((t) => ({ ...t, x, y, z, alt: rMag - EARTH_RADIUS_KM, mjd: msg.utc || t.mjd }));
          }
        } catch (e) { /* ignore malformed frame */ }
      };
      wsRef.current = ws;
    } catch (e) {
      setLinkState("ERROR");
    }
  };
  const disconnect = () => {
    wsRef.current?.close();
    wsRef.current = null;
    setLinkState("SIMULATED");
  };

  // ---- 2D map view (Mercator) -----------------------------------------------
  const map2dCanvasRef = useRef(null);
  const mercatorBgRef = useRef(null); // cached offscreen canvas of the warped day background (base map only — terminator is drawn fresh each frame since it moves)
  const nightLightsImgRef = useRef(null); // source image, loaded once
  const mercatorNightBgRef = useRef(null); // cached offscreen canvas of the warped night-lights background

  const buildMercatorBackground = (width, height) => {
    const srcImage = sceneRef.current.earthMat?.map?.image;
    const bg = document.createElement("canvas");
    bg.width = width; bg.height = height;
    const ctx = bg.getContext("2d");
    ctx.fillStyle = "#08243f";
    ctx.fillRect(0, 0, width, height);
    if (srcImage && srcImage.width) {
      const srcW = srcImage.width, srcH = srcImage.height;
      for (let y = 0; y < height; y++) {
        const yNorm = 1 - (2 * y) / height; // top(+1) -> bottom(-1)
        const lat = mercatorNormYToLat(yNorm);
        const srcY = Math.max(0, Math.min(srcH - 1, Math.round(((90 - lat) / 180) * srcH)));
        ctx.drawImage(srcImage, 0, srcY, srcW, 1, 0, y, width, 1);
      }
    }
    // lat/lon grid overlay
    ctx.strokeStyle = "rgba(143,215,255,0.15)";
    ctx.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 30) {
      const { x } = latLonToMercatorPx(0, lon, width, height);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const { y } = latLonToMercatorPx(lat, 0, width, height);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(143,215,255,0.35)";
    const eq = latLonToMercatorPx(0, 0, width, height);
    ctx.beginPath(); ctx.moveTo(0, eq.y); ctx.lineTo(width, eq.y); ctx.stroke();
    return bg;
  };

  // NASA Black Marble night-lights composite — public NASA Earth Observatory asset.
  const NIGHT_LIGHTS_URL = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144897/BlackMarble_2016_01deg_gray.jpg";

  const buildMercatorNightBackground = (width, height) => {
    const srcImage = nightLightsImgRef.current;
    const bg = document.createElement("canvas");
    bg.width = width; bg.height = height;
    const ctx = bg.getContext("2d");
    if (!srcImage || !srcImage.complete || !srcImage.naturalWidth) return null; // not loaded yet
    const srcW = srcImage.naturalWidth, srcH = srcImage.naturalHeight;
    for (let y = 0; y < height; y++) {
      const yNorm = 1 - (2 * y) / height;
      const lat = mercatorNormYToLat(yNorm);
      const srcY = Math.max(0, Math.min(srcH - 1, Math.round(((90 - lat) / 180) * srcH)));
      ctx.drawImage(srcImage, 0, srcY, srcW, 1, 0, y, width, 1);
    }
    return bg;
  };

  // Draw a lat/lon polyline, breaking the path wherever it crosses the
  // antimeridian (±180°) instead of drawing a spurious line straight across
  // the map — a common artifact if this isn't handled explicitly.
  const strokeGeoPath = (ctx, points, width, height, closed = false) => {
    if (points.length < 2) return;
    ctx.beginPath();
    let started = false;
    let prevLon = null;
    for (const p of points) {
      const { x, y } = latLonToMercatorPx(p.lat, p.lon, width, height);
      if (prevLon !== null && Math.abs(p.lon - prevLon) > 180) {
        started = false; // break the path — antimeridian crossing
      }
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      prevLon = p.lon;
    }
    if (closed) ctx.closePath();
    ctx.stroke();
  };

  // Night-side shading: sample the terminator's latitude at each column,
  // then fill whichever side of that curve is night (tested via the
  // antisolar point, so this works correctly regardless of season).
  const drawNightShading = (ctx, width, height, subLat, subLon) => {
    const cols = 120;
    const curve = [];
    for (let i = 0; i <= cols; i++) {
      const lon = -180 + (360 * i) / cols;
      const lat = terminatorLatAtLon(lon, subLat, subLon);
      const { x, y } = latLonToMercatorPx(lat, lon, width, height);
      curve.push({ x, y });
    }
    const antisolarLon = ((subLon + 180 + 540) % 360) - 180;
    const antisolarCol = Math.round(((antisolarLon + 180) / 360) * cols);
    const antisolarY = latLonToMercatorPx(-subLat, antisolarLon, width, height).y;
    const curveYAtAntisolar = curve[Math.max(0, Math.min(cols, antisolarCol))].y;
    const nightIsBelow = antisolarY > curveYAtAntisolar;

    const buildNightPath = () => {
      ctx.beginPath();
      ctx.moveTo(curve[0].x, curve[0].y);
      for (let i = 1; i <= cols; i++) ctx.lineTo(curve[i].x, curve[i].y);
      if (nightIsBelow) { ctx.lineTo(width, height); ctx.lineTo(0, height); }
      else { ctx.lineTo(width, 0); ctx.lineTo(0, 0); }
      ctx.closePath();
    };

    if (!mercatorNightBgRef.current) {
      mercatorNightBgRef.current = buildMercatorNightBackground(width, height);
    }

    ctx.save();
    buildNightPath();
    ctx.clip();
    if (mercatorNightBgRef.current) {
      // City lights, drawn with "screen"-like additive blending so bright
      // points pop against the darkened day-map colors underneath rather
      // than fully replacing them.
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.85;
      ctx.drawImage(mercatorNightBgRef.current, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    // Darken the night side overall (oceans/unlit land) — lighter than a
    // flat night mask alone, since city lights need to still read through.
    ctx.fillStyle = "rgba(2,6,16,0.45)";
    ctx.globalCompositeOperation = "multiply";
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  };

  useEffect(() => {
    if (activeView !== "2d") return;
    const canvas = map2dCanvasRef.current;
    if (!canvas) return;
    let raf;

    if (!nightLightsImgRef.current) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { mercatorNightBgRef.current = null; }; // rebuild on next frame now that it's loaded
      img.src = NIGHT_LIGHTS_URL;
      nightLightsImgRef.current = img;
    }

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const parent = canvas.parentElement;
      const w = parent.clientWidth, h = parent.clientHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        mercatorBgRef.current = null; // size changed, rebuild cached background
        mercatorNightBgRef.current = null;
      }
      if (!mercatorBgRef.current) {
        mercatorBgRef.current = buildMercatorBackground(w, h);
      }
      const ctx = canvas.getContext("2d");
      ctx.drawImage(mercatorBgRef.current, 0, 0);

      const t = telemRef.current;
      const sub = t ? getSubsolarPoint(t.mjd) : null;

      // Day/night terminator shading
      if (sub) drawNightShading(ctx, w, h, sub.lat, sub.lon);

      // Ground coverage footprint (satellite horizon-visibility circle)
      if (t) {
        const { lat, lon } = eciToLatLon(t.x, t.y, t.z, t.mjd);
        const footprint = groundCoveragePoints(lat, lon, t.alt);
        ctx.fillStyle = "rgba(255,235,102,0.10)";
        ctx.strokeStyle = "rgba(255,235,102,0.4)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        let started = false, prevLon = null;
        for (const p of footprint) {
          const { x, y } = latLonToMercatorPx(p.lat, p.lon, w, h);
          if (prevLon !== null && Math.abs(p.lon - prevLon) > 180) started = false;
          if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
          prevLon = p.lon;
        }
        ctx.fill();
        ctx.stroke();
      }

      // Current orbit / ground track (past) — yellow
      ctx.strokeStyle = "#ffeb3b";
      ctx.lineWidth = 2;
      strokeGeoPath(ctx, groundTrackRef.current, w, h);

      // Future orbit — white
      if (futureGroundTrackRef.current.length > 1) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        strokeGeoPath(ctx, futureGroundTrackRef.current, w, h);
        ctx.setLineDash([]);
      }

      // Subsolar point (sun location)
      if (sub) {
        const sp = latLonToMercatorPx(sub.lat, sub.lon, w, h);
        const grad = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, 16);
        grad.addColorStop(0, "rgba(255,230,120,0.9)");
        grad.addColorStop(1, "rgba(255,230,120,0)");
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 16, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#fff2b0";
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2); ctx.fill();
      }

      // Ground station
      const gs = latLonToMercatorPx(HAWAII_GROUND_STATION.lat, HAWAII_GROUND_STATION.lon, w, h);
      ctx.fillStyle = "#5eff9c";
      ctx.beginPath(); ctx.arc(gs.x, gs.y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#cfe6ff";
      ctx.font = "11px monospace";
      ctx.fillText(HAWAII_GROUND_STATION.name, gs.x + 8, gs.y - 6);

      // Current satellite position
      if (t) {
        const { lat, lon } = eciToLatLon(t.x, t.y, t.z, t.mjd);
        const p = latLonToMercatorPx(lat, lon, w, h);
        ctx.fillStyle = "#ffeb3b";
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#ffeb3b";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [activeView]);

  const linkColor = { LIVE: "#5ee6a8", CONNECTING: "#ffb454", ERROR: "#ff6a6a", SIMULATED: "#8fd7ff" }[linkState];

  const VIEW_TABS = [
    { id: "3d", label: "3D View" },
    { id: "2d", label: "2D View" },
    { id: "telemetry", label: "Telemetry" },
  ];

  const renderControlsPanelContent = (include3DOnlyToggles) => (
    <>
      <div style={{ fontSize: 11, color: "#7d93b8", marginBottom: 10, fontFamily: "system-ui,sans-serif" }}>ORBIT ELEMENTS (sim)</div>
      {[
        ["altPerigee", "Perigee alt (km)", 160, 2000],
        ["altApogee", "Apogee alt (km)", 160, 2000],
        ["incDeg", "Inclination (deg)", 0, 180],
        ["raanDeg", "RAAN (deg)", 0, 360],
        ["argpDeg", "Arg. of periapsis (deg)", 0, 360],
      ].map(([key, label, min, max]) => (
        <div key={key} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#8fa2c2" }}>
            <span>{label}</span><span>{orbitEl[key]}</span>
          </div>
          <input type="range" min={min} max={max} value={orbitEl[key]}
            onChange={(e) => setOrbitEl((o) => ({ ...o, [key]: Number(e.target.value) }))}
            style={{ width: "100%" }} disabled={linkState === "LIVE"} />
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 10, marginBottom: 10 }}>
        <button onClick={() => setRunning((r) => !r)} style={btnStyle}>{running ? "Pause" : "Resume"}</button>
        <div style={{ flex: 1 }}>
          <input type="range" min={1} max={600} value={speed} onChange={(e) => setSpeed(e.target.value)} style={{ width: "100%" }} />
          <div style={{ fontSize: 10, color: "#5f7396", textAlign: "right" }}>{speed}x</div>
        </div>
      </div>

      {include3DOnlyToggles && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fa2c2", marginBottom: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={showAxes} onChange={(e) => setShowAxes(e.target.checked)} />
            Show ECI reference frame
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fa2c2", marginBottom: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={showSun} onChange={(e) => setShowSun(e.target.checked)} />
            Sun {showSun ? "on" : "off (full visibility)"}
          </label>
        </>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fa2c2", marginBottom: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={showFuture} onChange={(e) => setShowFuture(e.target.checked)} />
        Show future trajectory
      </label>

      <div style={{ fontSize: 11, color: "#7d93b8", margin: "10px 0 6px", fontFamily: "system-ui,sans-serif" }}>LIVE BRIDGE</div>
      <input placeholder="ws://localhost:8080/telem" value={wsUrl} onChange={(e) => setWsUrl(e.target.value)}
        style={{ width: "100%", background: "#0c1428", border: "1px solid rgba(143,215,255,0.25)", color: "#cfe6ff", borderRadius: 4, padding: "6px 8px", fontSize: 12, marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={connect} style={btnStyle}>Connect</button>
        <button onClick={disconnect} style={btnStyle}>Disconnect</button>
      </div>
    </>
  );

  return (
    <div style={{
      position: "relative", width: "100%", height: "100vh", minHeight: 560,
      background: "radial-gradient(circle at 30% 20%, #0a1226 0%, #05070d 70%)",
      fontFamily: "'IBM Plex Mono','SFMono-Regular',Menlo,monospace",
      color: "#cfe6ff", overflow: "hidden", display: "flex", flexDirection: "column",
    }}>
      {/* Top bar: always visible across all views */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 22px", borderBottom: "1px solid rgba(143,215,255,0.12)",
        background: "rgba(9,14,28,0.6)", zIndex: 2, flexShrink: 0,
      }}>
        <div>
          <div style={{ fontFamily: "system-ui,sans-serif", fontSize: 13, letterSpacing: 0.5, color: "#7d93b8" }}>COSMOS WEB</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: "#eaf3ff" }}>{nodeName}</div>
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveView(tab.id)}
              style={{
                background: activeView === tab.id ? "rgba(143,215,255,0.16)" : "transparent",
                border: activeView === tab.id ? "1px solid rgba(143,215,255,0.4)" : "1px solid transparent",
                color: activeView === tab.id ? "#eaf3ff" : "#8fa2c2",
                borderRadius: 5, padding: "6px 14px", fontSize: 12, cursor: "pointer",
                fontFamily: "'IBM Plex Mono',monospace",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: linkColor, boxShadow: `0 0 8px ${linkColor}` }} />
          <span style={{ fontSize: 12, color: linkColor }}>{linkState}</span>
        </div>
      </div>

      {/* Main content area */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>

        {/* 3D View — kept mounted (not unmounted on tab switch) so the
            Three.js scene, camera position, and trail history survive
            switching tabs; just hidden via display when inactive. */}
        <div style={{ position: "absolute", inset: 0, display: activeView === "3d" ? "block" : "none" }}>
          <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />

          {/* Telemetry HUD */}
          <div style={{
            position: "absolute", left: 22, bottom: 22, width: 240,
            background: "rgba(9,14,28,0.72)", border: "1px solid rgba(143,215,255,0.18)",
            borderRadius: 6, padding: "14px 16px", backdropFilter: "blur(4px)",
          }}>
            <div style={{ fontSize: 11, color: "#7d93b8", marginBottom: 8, fontFamily: "system-ui,sans-serif" }}>ECI TELEMETRY</div>
            <div style={{ display: "grid", gridTemplateColumns: "88px 1fr", rowGap: 4, columnGap: 10 }}>
              {(() => {
                const { lat, lon } = eciToLatLon(telem.x, telem.y, telem.z, telem.mjd);
                return [
                  ["Satellite", satName],
                  ["UTC (MJD)", telem.mjd.toFixed(6)],
                  ["UTC", mjdToISO(telem.mjd)],
                  ["X (km)", telem.x.toFixed(1)],
                  ["Y (km)", telem.y.toFixed(1)],
                  ["Z (km)", telem.z.toFixed(1)],
                  ["Alt (km)", telem.alt.toFixed(1)],
                  ["Lat", `${lat.toFixed(3)}°`],
                  ["Lon", `${lon.toFixed(3)}°`],
                ];
              })().map(([label, val]) => (
                <React.Fragment key={label}>
                  <span style={{ fontSize: 12, color: "#5f7396", textAlign: "left" }}>{label}</span>
                  <span style={{ fontSize: 12, color: "#ffb454", textAlign: "left", fontVariantNumeric: "tabular-nums" }}>{val}</span>
                </React.Fragment>
              ))}
            </div>
            <input
              value={satName}
              onChange={(e) => setSatName(e.target.value)}
              placeholder="Satellite name (from TLE)"
              style={{ width: "100%", marginTop: 8, background: "#0c1428", border: "1px solid rgba(143,215,255,0.2)", color: "#8fa2c2", borderRadius: 4, padding: "4px 6px", fontSize: 11 }}
            />
          </div>

          {/* Controls panel */}
          <div style={{
            position: "absolute", right: 22, bottom: 22, width: 280,
            background: "rgba(9,14,28,0.72)", border: "1px solid rgba(143,215,255,0.18)",
            borderRadius: 6, padding: "14px 16px", backdropFilter: "blur(4px)",
          }}>
            {renderControlsPanelContent(true)}
          </div>
        </div>

        {/* 2D View — Mercator ground-track map */}
        {activeView === "2d" && (
          <div style={{ position: "absolute", inset: 0 }}>
            <canvas ref={map2dCanvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
            <div style={{
              position: "absolute", left: 22, top: 16, fontSize: 11, color: "#7d93b8",
              fontFamily: "system-ui,sans-serif", background: "rgba(9,14,28,0.6)",
              padding: "6px 10px", borderRadius: 5,
            }}>
              Mercator · yellow = current orbit (1.5h) · white dashed = future orbit (1.5h) · shaded = night side + city lights
            </div>

            {/* Controls panel — same underlying sim/live controls as the 3D view */}
            <div style={{
              position: "absolute", right: 22, bottom: 22, width: 280,
              background: "rgba(9,14,28,0.72)", border: "1px solid rgba(143,215,255,0.18)",
              borderRadius: 6, padding: "14px 16px", backdropFilter: "blur(4px)",
            }}>
              {renderControlsPanelContent(false)}
            </div>
          </div>
        )}

        {/* Telemetry View — full-page readable table */}
        {activeView === "telemetry" && (() => {
          const { lat, lon } = eciToLatLon(telem.x, telem.y, telem.z, telem.mjd);
          const speedKmS = Math.sqrt(telem.vx ** 2 + telem.vy ** 2 + telem.vz ** 2);
          const rows = [
            ["Satellite", satName],
            ["Node", nodeName],
            ["Link status", linkState],
            ["UTC (MJD)", telem.mjd.toFixed(6)],
            ["UTC", mjdToISO(telem.mjd)],
            ["ECI X (km)", telem.x.toFixed(3)],
            ["ECI Y (km)", telem.y.toFixed(3)],
            ["ECI Z (km)", telem.z.toFixed(3)],
            ["ECI Vx (km/s)", telem.vx.toFixed(4)],
            ["ECI Vy (km/s)", telem.vy.toFixed(4)],
            ["ECI Vz (km/s)", telem.vz.toFixed(4)],
            ["Speed (km/s)", speedKmS.toFixed(4)],
            ["Altitude (km)", telem.alt.toFixed(3)],
            ["Latitude", `${lat.toFixed(4)}°`],
            ["Longitude", `${lon.toFixed(4)}°`],
          ];
          return (
            <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: "32px 22px" }}>
              <div style={{ maxWidth: 520, margin: "0 auto" }}>
                <div style={{ fontSize: 13, color: "#7d93b8", marginBottom: 16, fontFamily: "system-ui,sans-serif" }}>
                  FULL TELEMETRY
                </div>
                <div style={{
                  display: "grid", gridTemplateColumns: "180px 1fr", rowGap: 10, columnGap: 16,
                  background: "rgba(9,14,28,0.5)", border: "1px solid rgba(143,215,255,0.15)",
                  borderRadius: 8, padding: 20,
                }}>
                  {rows.map(([label, val]) => (
                    <React.Fragment key={label}>
                      <span style={{ fontSize: 13, color: "#8fa2c2" }}>{label}</span>
                      <span style={{ fontSize: 13, color: "#ffb454", fontVariantNumeric: "tabular-nums" }}>{val}</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}

      </div>

      <div style={{
        textAlign: "center", padding: "4px 0",
        fontSize: 10, color: "#4a5b7a", letterSpacing: 0.5, flexShrink: 0,
      }}>
        cosmos-web v{COSMOS_WEB_VERSION}
      </div>
    </div>
  );
}

const btnStyle = {
  flex: 1, background: "rgba(143,215,255,0.1)", border: "1px solid rgba(143,215,255,0.3)",
  color: "#cfe6ff", borderRadius: 4, padding: "6px 10px", fontSize: 12, cursor: "pointer",
  fontFamily: "'IBM Plex Mono',monospace",
};
