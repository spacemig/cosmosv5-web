import * as THREE from "three";

/**
 * Three.js scene-object builders shared by the orbit and satellite views:
 * Earth textures, starfield, procedural spacecraft models, world-space text
 * labels, axis triads, and the country-boundary overlay. Extracted verbatim
 * from OrbitViewer.jsx.
 */

// ---- Procedural earth texture (no external asset dependency) --------------
export function buildEarthTexture() {
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
export const EARTH_TEXTURE_URLS = {
  map: "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg",
  bump: "https://threejs.org/examples/textures/planets/earth_normal_2048.jpg",
  specular: "https://threejs.org/examples/textures/planets/earth_specular_2048.jpg",
  clouds: "https://threejs.org/examples/textures/planets/earth_clouds_1024.png",
};

export function loadEarthTextures(onReady) {
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

export function buildStarfield(count = 2400) {
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

// ---- Procedural spacecraft models (for the close-up "Satellite" tab) ------
function buildSolarPanelTexture() {
  const w = 256, h = 128;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0b1f3a";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#14487f";
  const cols = 8, rows = 4, pad = 3;
  const cw = w / cols, ch = h / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      ctx.fillRect(i * cw + pad, j * ch + pad, cw - pad * 2, ch - pad * 2);
    }
  }
  ctx.strokeStyle = "rgba(180,220,255,0.25)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= cols; i++) { ctx.beginPath(); ctx.moveTo(i * cw, 0); ctx.lineTo(i * cw, h); ctx.stroke(); }
  for (let j = 0; j <= rows; j++) { ctx.beginPath(); ctx.moveTo(0, j * ch); ctx.lineTo(w, j * ch); ctx.stroke(); }
  return new THREE.CanvasTexture(canvas);
}

// A generic 3-axis-stabilized satellite: bus + gold MLI wrap, two solar-panel
// wings, a high-gain dish, an antenna mast, and a nadir instrument/nozzle.
// Body frame = the group's local frame (X = panel wings, Y = dish "up",
// Z = completing the triad).
function buildSatelliteModel() {
  const group = new THREE.Group();

  const busMat = new THREE.MeshPhongMaterial({ color: 0x9aa7b8, shininess: 30, specular: 0x333333 });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.3, 1.1), busMat));

  const foilMat = new THREE.MeshPhongMaterial({ color: 0xd8a12a, shininess: 80, specular: 0x8a6b1f, emissive: 0x2a1e05 });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.7, 1.16), foilMat));

  const panelTex = buildSolarPanelTexture();
  const panelMat = new THREE.MeshPhongMaterial({
    map: panelTex, shininess: 60, specular: 0x224466, side: THREE.DoubleSide,
    emissive: 0x0a1a33, emissiveIntensity: 0.4,
  });
  const armMat = new THREE.MeshPhongMaterial({ color: 0x6b7280 });
  [-1, 1].forEach((dir) => {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 8), armMat);
    arm.rotation.z = Math.PI / 2;
    arm.position.x = dir * 1.0;
    group.add(arm);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.04, 1.4), panelMat);
    panel.position.x = dir * 2.75;
    group.add(panel);
  });

  const dishMat = new THREE.MeshPhongMaterial({ color: 0xe8eef6, shininess: 20, side: THREE.DoubleSide });
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2.6), dishMat);
  dish.scale.y = 0.45;
  dish.position.set(0.35, 0.95, 0.25);
  group.add(dish);
  const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.32, 6), armMat);
  feed.position.set(0.35, 1.12, 0.25);
  group.add(feed);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.1, 6), armMat);
  mast.position.set(-0.35, 1.15, -0.2);
  group.add(mast);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffb454 }));
  tip.position.set(-0.35, 1.72, -0.2);
  group.add(tip);

  const instr = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.4), new THREE.MeshPhongMaterial({ color: 0x2a2f3a }));
  instr.position.y = -0.78;
  group.add(instr);
  const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.22, 12), new THREE.MeshPhongMaterial({ color: 0x51361f }));
  nozzle.position.y = -0.98;
  nozzle.rotation.x = Math.PI;
  group.add(nozzle);

  return group;
}

// A CubeSat model. `wide` is body width in U (1 → 3U at 1×1×3, 2 → 6U at
// 2×1×3); `wings` = how many deployed panels to hang off the ±X faces.
function buildCubeSat(wide, wings) {
  const g = new THREE.Group();
  const W = wide * 1.0, H = 1.0, L = 3.0;

  const bodyMat = new THREE.MeshPhongMaterial({ color: 0x2b3440, shininess: 40, specular: 0x556070 });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(W, H, L), bodyMat));

  const railMat = new THREE.MeshPhongMaterial({ color: 0xb8c0cc, shininess: 80 });
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, L + 0.03), railMat);
    rail.position.set(sx * (W / 2 - 0.045), sy * (H / 2 - 0.045), 0);
    g.add(rail);
  }

  const cellTex = buildSolarPanelTexture();
  const cellMat = new THREE.MeshPhongMaterial({
    map: cellTex, side: THREE.DoubleSide, emissive: 0x0a1a33, emissiveIntensity: 0.4, shininess: 60,
  });
  const topCells = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.9, L * 0.92), cellMat);
  topCells.rotation.x = -Math.PI / 2;
  topCells.position.y = H / 2 + 0.012;
  g.add(topCells);

  for (let i = 0; i < wings; i++) {
    const side = i === 0 ? 1 : -1;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(L * 0.95, 0.03, L * 0.9), cellMat);
    wing.position.set(side * (W / 2 + L * 0.5 + 0.16), 0, 0);
    g.add(wing);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.32, 6), railMat);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(side * (W / 2 + 0.16), 0, 0);
    g.add(arm);
  }

  // Deployable UHF whip antenna off the -Z (aft) face.
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1.6, 6), new THREE.MeshBasicMaterial({ color: 0xffb454 }));
  ant.rotation.x = Math.PI / 2;
  ant.position.set(-W * 0.25, 0, -L / 2 - 0.8);
  g.add(ant);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffb454 }));
  tip.position.set(-W * 0.25, 0, -L / 2 - 1.6);
  g.add(tip);

  return g;
}

// Build the model chosen in the Satellite view's picker.
export function buildSatModel(kind) {
  if (kind === "cubesat3u") return buildCubeSat(1, 0); // body-mounted cells only
  if (kind === "cubesat6u") return buildCubeSat(2, 0); // body-mounted cells only
  return buildSatelliteModel();
}

// Standard lat/lon (degrees) -> position on a sphere of radius `r`, matching
// the UV convention of a typical equirectangular Earth texture (Y = polar axis).
export function latLonToVector3(latDeg, lonDeg, r) {
  const phi = ((90 - latDeg) * Math.PI) / 180;
  const theta = ((lonDeg + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}

// A world-space text label sprite, canvas sized to the text so longer strings
// aren't clipped. `worldHeight` is the on-screen height in scene units.
export function makeAxisLabel(text, hexColor, occlude = false, worldHeight = 0.9) {
  const fontPx = 48, padX = 16, padY = 8;
  const canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d");
  ctx.font = `bold ${fontPx}px monospace`;
  canvas.width = Math.max(2, Math.ceil(ctx.measureText(text).width)) + padX * 2;
  canvas.height = fontPx + padY * 2;
  ctx = canvas.getContext("2d");
  ctx.font = `bold ${fontPx}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(4,8,16,0.85)";
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = hexColor;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  // occlude=true: depth-tested, so the globe hides it when the marked point is
  // on the far side. occlude=false: always drawn on top.
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: occlude, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(worldHeight * (canvas.width / canvas.height), worldHeight, 1);
  return sprite;
}

// ECI colours vs. the ECEF triad's colours (the ECEF triad is parented to the
// Earth so it spins with the planet: local +X -> (0°N,0°E), +Y -> (0°N,90°E),
// +Z -> north pole).
export const AXIS_FRAMES = {
  ECI: { colors: [0xff5c5c, 0x5cff8a, 0x5c9cff] },
  ECEF: { colors: [0xff9c5c, 0x5cffd7, 0xc77cff] },
};
export function buildAxesTriad(lengthScene, frame) {
  const group = new THREE.Group();
  const cols = AXIS_FRAMES[frame].colors;
  const axes = [
    { dir: new THREE.Vector3(1, 0, 0), color: cols[0], label: `X (${frame})` },
    { dir: new THREE.Vector3(0, 0, -1), color: cols[1], label: `Y (${frame})` },
    { dir: new THREE.Vector3(0, 1, 0), color: cols[2], label: `Z (${frame})` },
  ];
  axes.forEach(({ dir, color, label }) => {
    const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), lengthScene, color, lengthScene * 0.08, lengthScene * 0.04);
    group.add(arrow);
    const sprite = makeAxisLabel(label, `#${color.toString(16).padStart(6, "0")}`, true, lengthScene * 0.11);
    sprite.position.copy(dir.clone().multiplyScalar(lengthScene * 1.14));
    group.add(sprite);
  });
  return group;
}

// Content-sized text texture for the flat country / ground-station labels.
export const COUNTRY_LABEL_PT = 8;
export function makeLabelTexture(text, hexColor) {
  const fontPx = 64, pad = 8;
  const canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d");
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.height = fontPx + pad * 2;
  ctx = canvas.getContext("2d");
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(4,8,16,0.9)";
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = hexColor;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  return { tex, aspect: canvas.width / canvas.height };
}

// Orient `mesh` (PlaneGeometry, local normal +Z) so it lies flat on the sphere
// at `pos` — tangent to the surface, reading west->east, north "up".
export function orientFlatOnSphere(mesh, pos) {
  const normal = pos.clone().normalize();
  const east = new THREE.Vector3(0, 1, 0).cross(normal);
  if (east.lengthSq() < 1e-6) east.set(1, 0, 0); // degenerate at the poles
  east.normalize();
  const north = normal.clone().cross(east).normalize();
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, north, normal));
}

// Public GeoJSON of country polygons (name + Polygon/MultiPolygon), CORS-OK.
export const COUNTRIES_GEOJSON_URL = "https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json";

// Country-boundary overlay: all borders merged into one LineSegments plus a
// flat name label at each country's largest-ring centroid, in a named
// "countryLabels" sub-group so labels can be toggled independently.
export function buildCountryBoundaries(geojson, radius) {
  const positions = [];
  const labelInfo = [];
  for (const feature of geojson.features || []) {
    const name = feature.properties && feature.properties.name;
    const geom = feature.geometry;
    if (!geom) continue;
    const polys = geom.type === "Polygon" ? [geom.coordinates]
      : geom.type === "MultiPolygon" ? geom.coordinates : [];
    let anchor = null, anchorArea = 0;
    for (const poly of polys) {
      for (const ring of poly) {
        for (let i = 0; i + 1 < ring.length; i++) {
          const a = latLonToVector3(ring[i][1], ring[i][0], radius);
          const b = latLonToVector3(ring[i + 1][1], ring[i + 1][0], radius);
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
      const outer = poly[0];
      if (outer && outer.length > 3) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, sX = 0, sY = 0;
        for (const [lon, lat] of outer) {
          minX = Math.min(minX, lon); maxX = Math.max(maxX, lon);
          minY = Math.min(minY, lat); maxY = Math.max(maxY, lat);
          sX += lon; sY += lat;
        }
        const area = (maxX - minX) * (maxY - minY);
        if (area > anchorArea) { anchorArea = area; anchor = { lon: sX / outer.length, lat: sY / outer.length }; }
      }
    }
    if (name && anchor) labelInfo.push({ name, lon: anchor.lon, lat: anchor.lat, area: anchorArea });
  }

  const group = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.4 })));

  const labelGroup = new THREE.Group();
  labelGroup.name = "countryLabels";
  labelInfo.sort((p, q) => q.area - p.area);
  for (const l of labelInfo.slice(0, 250)) {
    const { tex, aspect } = makeLabelTexture(l.name, "#eef6ff");
    // Scale each label to the country's own bounding box so small nations get
    // text that fits inside their borders.
    const h = Math.max(0.045, Math.min(0.16, Math.sqrt(l.area) * 0.011));
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(h * aspect, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
    );
    const pos = latLonToVector3(l.lat, l.lon, radius * 1.003);
    mesh.position.copy(pos);
    orientFlatOnSphere(mesh, pos);
    labelGroup.add(mesh);
  }
  group.add(labelGroup);
  return group;
}
