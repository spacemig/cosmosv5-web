import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import SpaceGame from "./SpaceGame.jsx";
import {
  EARTH_RADIUS_KM, MU_EARTH, EARTH_TEXTURE_LON_OFFSET_DEG, GS_ELEVATION_MASK_DEG,
  kmToScene, keplerToECI, precomputeOrbitPath, stateVectorToElements,
  eciToLatLon, mjdToISO, fmtDuration, gmstRadians, numOr,
  groundStationEci, elevationDeg,
  latLonToMercatorPx, mercatorNormYToLat, getSubsolarPoint, terminatorLatAtLon, groundCoveragePoints,
  getSunEci, getMoonEci,
} from "./lib/orbital.js";
import {
  buildEarthTexture, loadEarthTextures, buildStarfield, buildSatModel,
  latLonToVector3, makeAxisLabel, buildAxesTriad, makeLabelTexture, orientFlatOnSphere,
  COUNTRIES_GEOJSON_URL, buildCountryBoundaries,
} from "./three/builders.js";
import { btnStyle, useIsMobile } from "./lib/ui.js";
import { COSMOS_WEB_VERSION, COSMOS_BRIDGE_VERSION, VIEW_TABS } from "./lib/mission.js";
import MissionConfigurator from "./views/MissionConfigurator.jsx";
import GroundStationsView from "./views/GroundStationsView.jsx";

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

export default function OrbitViewer() {
  const mountRef = useRef(null);
  const sceneRef = useRef({});
  const isMobile = useIsMobile();
  const [panelOpen, setPanelOpen] = useState(false); // mobile controls bottom-sheet
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
  const [showEcef, setShowEcef] = useState(false);
  const [showSun, setShowSun] = useState(true);
  const [showBodies, setShowBodies] = useState(true); // visible Sun + Moon spheres
  const [showSunVector, setShowSunVector] = useState(false);
  const [showProjection, setShowProjection] = useState(false); // sub-satellite point on the surface
  const [showFuture, setShowFuture] = useState(false);
  const [showCountries, setShowCountries] = useState(false);
  const [showLabels, setShowLabels] = useState(true); // ground-station + reference-frame text labels (markers/vectors stay regardless)
  const [followSat, setFollowSat] = useState(false);
  const [missionResetKey, setMissionResetKey] = useState(0);
  const [nodeName, setNodeName] = useState("propagator-sim");
  const [satName, setSatName] = useState("ISS (ZARYA)");
  const [wsUrl, setWsUrl] = useState("");
  const [linkState, setLinkState] = useState("SIMULATED"); // SIMULATED | CONNECTING | LIVE | ERROR
  const [telem, setTelem] = useState({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, alt: 0, mjd: 60107.0, simSec: 0 });
  useEffect(() => { telemRef.current = telem; }, [telem]);

  // Realm / node registry. A realm is a named grouping of nodes (spacecraft
  // agents); in a full deployment the node list for a realm comes from that
  // realm's agent registry — here it's seeded locally and grows as live
  // telemetry reports node names. The selected node is what the header shows
  // and what the visualization is treated as representing.
  const [realm, setRealm] = useState("cosmos");
  const [realms, setRealms] = useState(["cosmos"]);
  const [nodesByRealm, setNodesByRealm] = useState({ cosmos: ["propagator-sim"] });
  const realmRef = useRef(realm);
  useEffect(() => { realmRef.current = realm; }, [realm]);

  // Editable ground stations (see the Ground Stations tab). Rendered as markers
  // in the 3D and 2D views; a line is drawn to the satellite during a pass.
  // `enabled` gates whether the station is drawn / considered for passes.
  const [groundStations, setGroundStations] = useState([
    { id: "hsfl-hig", name: "HSFL-HIG", lat: 21.2975, lon: -157.8161, alt: 0.1, enabled: true },
    { id: "hsfl-nwic", name: "HSFL-NWIC", lat: 22.2975, lon: -157.8161, alt: 0.1, enabled: true },
    { id: "uvic", name: "UVIC", lat: 48.4634, lon: -123.3117, alt: 0.06, enabled: true },
    { id: "nps", name: "NPS", lat: 36.598056, lon: -121.875, alt: 0.01, enabled: true },
    { id: "tagus", name: "Tagus Park", lat: 38.740561, lon: -9.304168, alt: 0.1, enabled: true },
  ]);
  const groundStationsRef = useRef(groundStations);
  useEffect(() => { groundStationsRef.current = groundStations; }, [groundStations]);
  const [selectedGSId, setSelectedGSId] = useState("hsfl-hig"); // the focused ground station

  // Collapsible HUDs / mission-timeline scrub / playback direction.
  const [telemCollapsed, setTelemCollapsed] = useState(false);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const [scrubTime, setScrubTime] = useState(null); // null = follow playback; number = frozen at this sim-second
  const [reverse, setReverse] = useState(false); // play the mission timeline backwards
  const prevOrbitElRef = useRef(null); // detect orbit-element edits to reset the messy trails

  // Reflect the active view in the browser tab title.
  useEffect(() => {
    const label = VIEW_TABS.find((t) => t.id === activeView)?.label;
    document.title = label ? `COSMOS Web - ${label}` : "COSMOS Web";
  }, [activeView]);

  const wsRef = useRef(null);
  const liveTargetRef = useRef(null);
  const attitudeRef = useRef(null); // latest {w,x,y,z} attitude quaternion from telemetry (alphaatt)

  // Live-read snapshot for the Satellite view's render loop, so toggling
  // pause / link state doesn't tear down and rebuild that Three.js scene.
  const satMountRef = useRef(null);
  // Satellite 3D view modes:
  //  "turntable" — model rotating at the origin for design inspection (not tied
  //                to flight dynamics)
  //  "orbital"   — model at its real orbital position, Z→nadir / X→velocity,
  //                flying around the Earth (chase camera)
  //  "attitude"  — same real position/attitude, with the attitude sphere drawn
  //                around the spacecraft, above the correct Earth site
  const [satViewMode, setSatViewMode] = useState("turntable");
  const [showBodyAxes, setShowBodyAxes] = useState(true);
  const [showInertialAxes, setShowInertialAxes] = useState(false);
  const [showMagVector, setShowMagVector] = useState(false);
  const [satModelScale, setSatModelScale] = useState(0.22); // model size in the flight views
  const [attSphereScale, setAttSphereScale] = useState(1); // attitude-sphere size multiplier
  const satCtlRef = useRef({ running: true, linkState: "SIMULATED", mode: "turntable", bodyAxes: true, inertialAxes: false, sunVec: false, magVec: false, modelScale: 0.22, attScale: 1 });
  useEffect(() => {
    satCtlRef.current = {
      running, linkState, mode: satViewMode,
      bodyAxes: showBodyAxes, inertialAxes: showInertialAxes,
      sunVec: showSunVector, magVec: showMagVector, modelScale: satModelScale, attScale: attSphereScale,
    };
  }, [running, linkState, satViewMode, showBodyAxes, showInertialAxes, showSunVector, showMagVector, satModelScale, attSphereScale]);
  // Which spacecraft model the Satellite 3D view renders.
  const [satModel, setSatModel] = useState("default"); // default | cubesat3u | cubesat6u
  const SAT_MODELS = [
    { id: "default", label: "Default" },
    { id: "cubesat3u", label: "3U CubeSat" },
    { id: "cubesat6u", label: "6U CubeSat" },
  ];
  // Current spacecraft attitude (quaternion + derived Euler), pushed from the
  // Satellite view's render loop for the telemetry readout.
  const [satAtt, setSatAtt] = useState({ w: 1, x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0, src: "presentation" });
  // Mission-elapsed-time origin (MJD). Sim starts at the fixed epoch below;
  // a live link re-anchors it to the first telemetry timestamp received.
  const MISSION_EPOCH_MJD = 60107;
  const metStartRef = useRef(MISSION_EPOCH_MJD);
  useEffect(() => {
    if (linkState === "LIVE") metStartRef.current = null;               // re-anchor on next telemetry
    else if (linkState === "SIMULATED") metStartRef.current = MISSION_EPOCH_MJD;
  }, [linkState]);
  useEffect(() => {
    if (linkState === "LIVE" && metStartRef.current == null && telem.mjd) metStartRef.current = telem.mjd;
  }, [linkState, telem.mjd]);

  // Keep the mobile bottom-sheet from lingering after a layout/tab change.
  useEffect(() => { if (!isMobile) setPanelOpen(false); }, [isMobile]);
  useEffect(() => { setPanelOpen(false); }, [activeView]);

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

    // Equator ring — parented to `earth` so it stays over 0° latitude as the
    // planet rotates.
    {
      const er = kmToScene(EARTH_RADIUS_KM) * 1.001, pts = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(er * Math.cos(a), 0, er * Math.sin(a)));
      }
      const equator = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.45 })
      );
      earth.add(equator);
    }

    const ambient = new THREE.AmbientLight(0x223344, 1.1);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(30, 10, 20);
    scene.add(sun);

    // Visible Sun + Moon bodies. The Sun sphere is parked far along the true
    // Sun direction (well inside the camera far plane — real 1 AU would be way
    // beyond it); the Moon sits at its real geocentric distance in scene units.
    // Positions are refreshed every frame from the ephemeris helpers.
    const SUN_DIST = 1400;
    const SUN_R = kmToScene(EARTH_RADIUS_KM) * 6;
    const sunBody = new THREE.Group();
    sunBody.add(new THREE.Mesh(
      new THREE.SphereGeometry(SUN_R, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0xffe066 })
    ));
    sunBody.add(new THREE.Mesh(
      new THREE.SphereGeometry(SUN_R * 1.7, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.18, depthWrite: false })
    ));
    const sunBodyLabel = makeAxisLabel("☀ Sun", "#ffe066", false, SUN_R * 2.2);
    sunBodyLabel.position.set(0, SUN_R * 3, 0);
    sunBody.add(sunBodyLabel);
    scene.add(sunBody);

    const moonBody = new THREE.Group();
    moonBody.add(new THREE.Mesh(
      new THREE.SphereGeometry(kmToScene(EARTH_RADIUS_KM) * 0.9, 32, 32),
      new THREE.MeshPhongMaterial({ color: 0xcfd2d6, shininess: 2 })
    ));
    const moonBodyLabel = makeAxisLabel("☾ Moon", "#cfd2d6", false, kmToScene(EARTH_RADIUS_KM) * 2);
    moonBodyLabel.position.set(0, kmToScene(EARTH_RADIUS_KM) * 2.4, 0);
    moonBody.add(moonBodyLabel);
    scene.add(moonBody);

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

    const eciAxes = buildAxesTriad(kmToScene(EARTH_RADIUS_KM) * 2.2, "ECI");
    scene.add(eciAxes);

    // ECEF triad — parented to `earth`, so it rotates with the planet. Shorter
    // than the ECI triad so the shared polar (Z) axis stays readable.
    const ecefAxes = buildAxesTriad(kmToScene(EARTH_RADIUS_KM) * 1.85, "ECEF");
    ecefAxes.visible = false;
    earth.add(ecefAxes);

    // Sun vector — an arrow from Earth centre toward the Sun, updated each
    // frame from the subsolar point. Parented to `earth` so the earth-fixed
    // subsolar direction maps to the right world direction as the planet spins.
    const sunArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0),
      kmToScene(EARTH_RADIUS_KM) * 2.6, 0xffe066,
      kmToScene(EARTH_RADIUS_KM) * 0.18, kmToScene(EARTH_RADIUS_KM) * 0.09
    );
    const sunLabel = makeAxisLabel("☀ Sun", "#ffe066", false, kmToScene(EARTH_RADIUS_KM) * 0.22);
    sunArrow.add(sunLabel);
    sunLabel.position.set(0, kmToScene(EARTH_RADIUS_KM) * 2.7, 0); // tip is along the arrow's local +Y
    sunArrow.visible = false;
    earth.add(sunArrow);

    // Magnetic-field vector at the satellite — a spin-aligned centred dipole
    // (moment toward geographic south). Updated per-frame from the sat position.
    const magArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0),
      kmToScene(EARTH_RADIUS_KM) * 0.9, 0xff6ec7,
      kmToScene(EARTH_RADIUS_KM) * 0.14, kmToScene(EARTH_RADIUS_KM) * 0.07
    );
    magArrow.add(makeAxisLabel("B", "#ff6ec7", false, kmToScene(EARTH_RADIUS_KM) * 0.22));
    magArrow.children[0].position.set(0, kmToScene(EARTH_RADIUS_KM) * 1.0, 0);
    magArrow.visible = false;
    scene.add(magArrow);

    // Sub-satellite point: a marker on the surface directly below the
    // satellite, plus a drop line down to it (both in the inertial scene
    // frame — "directly below" is just along the position vector).
    const subSatDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffb454 })
    );
    const subSatRingGeo = new THREE.RingGeometry(0.12, 0.16, 32);
    const subSatRing = new THREE.Mesh(subSatRingGeo, new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    const subSatDropGeo = new THREE.BufferGeometry();
    subSatDropGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const subSatDrop = new THREE.Line(subSatDropGeo, new THREE.LineDashedMaterial({ color: 0xffb454, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.6 }));
    const subSatGroup = new THREE.Group();
    subSatGroup.add(subSatDot, subSatRing, subSatDrop);
    subSatGroup.visible = false;
    scene.add(subSatGroup);

    // Country-boundary overlay — fetched on demand, parented to `earth` so it
    // rotates with the surface. Stays hidden until the "Show country
    // boundaries" toggle is on (synced via sceneRef.current.control).
    fetch(COUNTRIES_GEOJSON_URL)
      .then((r) => r.json())
      .then((gj) => {
        const cg = buildCountryBoundaries(gj, kmToScene(EARTH_RADIUS_KM) * 1.01);
        cg.visible = !!(sceneRef.current.control && sceneRef.current.control.showCountries);
        const labels = cg.getObjectByName("countryLabels");
        if (labels) labels.visible = cg.visible;
        earth.add(cg);
        sceneRef.current.countryGroup = cg;
      })
      .catch(() => { /* offline / blocked — overlay just stays unavailable */ });

    // Ground-station markers, LOS lines and the pass line are built by a
    // separate effect (they depend on the editable `groundStations` list) and
    // updated per-frame in the animate loop below via sceneRef.current.gsEntries.

    const satGeo = new THREE.SphereGeometry(0.09, 16, 16);
    const satMat = new THREE.MeshBasicMaterial({ color: 0xffb454 });
    const satellite = new THREE.Mesh(satGeo, satMat);
    scene.add(satellite);

    const glowGeo = new THREE.SphereGeometry(0.22, 12, 12);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.25 });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    satellite.add(glow);

    // manual orbit-camera controls (r128 has no OrbitControls import)
    let dragging = false, lastX = 0, lastY = 0, touchCount = 0, pinchPrev = 0;
    const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
    const onUp = () => { dragging = false; };
    const onMove = (e) => {
      if (!dragging || touchCount >= 2) return; // let pinch-zoom own multi-touch
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      camTheta += dx * 0.005;
      camPhi = Math.min(Math.max(camPhi - dy * 0.005, 0.15), Math.PI - 0.15);
    };
    const onWheel = (e) => {
      e.preventDefault();
      camDist = Math.min(Math.max(camDist + e.deltaY * 0.01, 4), 90);
    };
    // Touch: one finger drags (via pointer events above), two fingers pinch-zoom.
    const pinchGap = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e) => {
      touchCount = e.touches.length;
      if (touchCount >= 2) { dragging = false; pinchPrev = pinchGap(e.touches); }
    };
    const onTouchMove = (e) => {
      if (e.touches.length < 2) return;
      e.preventDefault();
      const gap = pinchGap(e.touches);
      if (pinchPrev) camDist = Math.min(Math.max(camDist + (pinchPrev - gap) * 0.04, 4), 90);
      pinchPrev = gap;
    };
    const onTouchEnd = (e) => {
      touchCount = e.touches.length;
      if (touchCount < 2) pinchPrev = 0;
    };
    renderer.domElement.style.touchAction = "none"; // stop the browser from scrolling/zooming the page on drag
    renderer.domElement.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    renderer.domElement.addEventListener("touchstart", onTouchStart, { passive: false });
    renderer.domElement.addEventListener("touchmove", onTouchMove, { passive: false });
    renderer.domElement.addEventListener("touchend", onTouchEnd);
    renderer.domElement.addEventListener("touchcancel", onTouchEnd);

    // Camera orbits the origin normally, or the satellite when "Follow
    // satellite" is on — same drag/zoom offset, re-centered on the target.
    const DEFAULT_CAM = { camDist: 26, camTheta: 0.9, camPhi: 1.15 };
    const camTarget = new THREE.Vector3();
    function updateCamera() {
      const ctrl = sceneRef.current.control;
      if (ctrl && ctrl.followSat) camTarget.copy(satellite.position);
      else camTarget.set(0, 0, 0);
      camera.position.set(
        camTarget.x + camDist * Math.sin(camPhi) * Math.cos(camTheta),
        camTarget.y + camDist * Math.cos(camPhi),
        camTarget.z + camDist * Math.sin(camPhi) * Math.sin(camTheta)
      );
      camera.lookAt(camTarget);
    }
    updateCamera();

    sceneRef.current = {
      ...sceneRef.current,
      scene, camera, renderer, earth, orbitLine, orbitLineGeo, satellite, eciAxes, ecefAxes,
      sunArrow, magArrow, sunBody, moonBody, subSatGroup, subSatDot, subSatRing, subSatDrop,
      trailLine, trailPoints, sun, ambient, earthMat, orbitLineMat, trailMat, futureLine, futureGeo,
      updateCamera, getCamState: () => ({ camDist, camTheta, camPhi }),
      setCamState: (s) => { camDist = s.camDist; camTheta = s.camTheta; camPhi = s.camPhi; },
      resetView: () => { camDist = DEFAULT_CAM.camDist; camTheta = DEFAULT_CAM.camTheta; camPhi = DEFAULT_CAM.camPhi; },
    };

    // Reusable temporaries for the per-frame ground-station LOS update.
    const _gsWorld = new THREE.Vector3();
    const _gsUp = new THREE.Vector3();
    const _toSat = new THREE.Vector3();
    const GS_ELEV_SIN = Math.sin((GS_ELEVATION_MASK_DEG * Math.PI) / 180);

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
    let lastFutureNonce = -1;
    let lastResetNonce = 0;
    const _subSol = new THREE.Vector3();
    const _sunWorld = new THREE.Vector3();
    const _subPt = new THREE.Vector3();
    const _magR = new THREE.Vector3();
    const _magB = new THREE.Vector3();

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

      const ctrl = sceneRef.current.control;
      let curXKm = null, curYKm = null, curZKm = null;
      if (ctrl) {
        // Mission-timeline scrub: when scrubTime is set, freeze sim time there
        // (works whether or not playback is "running"); otherwise advance.
        const scrubbing = ctrl.mode === "sim" && ctrl.scrubTime != null;
        const advancing = ctrl.running && !scrubbing;

        // On an orbit-element edit, recompute the forward path this frame.
        if (ctrl.futureNonce !== lastFutureNonce) {
          lastFutureNonce = ctrl.futureNonce;
          lastFutureUpdate = 0;
        }

        // Mission reset: snap sim time back to the epoch and wipe the trail.
        let didReset = false;
        if (ctrl.resetNonce !== lastResetNonce) {
          lastResetNonce = ctrl.resetNonce;
          didReset = true;
          simTime = 0;
          currentMjd = 60107;
          lastGroundTrackMjd = -Infinity;
          trailPoints.length = 0;
          trailGeo.setDrawRange(0, 0);
        }

        if (ctrl.mode === "sim" && (advancing || scrubbing || didReset)) {
          simTime = scrubbing
            ? ctrl.scrubTime
            : didReset
              ? 0
              : Math.max(0, simTime + (ctrl.reverse ? -1 : 1) * dt * ctrl.speed);
          const els = ctrl.elements;
          const { x, y, z, vx, vy, vz, rMag } = keplerToECI(els, simTime);
          satellite.position.set(kmToScene(x), kmToScene(z), -kmToScene(y));
          currentMjd = 60107 + simTime / 86400;
          curXKm = x; curYKm = y; curZKm = z;
          ctrl.onTelem({
            x, y, z, vx, vy, vz,
            alt: rMag - EARTH_RADIUS_KM,
            mjd: currentMjd,
            simSec: simTime,
          });
          if (now - lastFutureUpdate > 3000) {
            lastFutureUpdate = now;
            updateFutureTrajectory(x, y, z, vx, vy, vz);
          }
        } else if (ctrl.mode === "live" && ctrl.running && liveTargetRef.current) {
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

        if (advancing && now - lastTrailPush > 150) {
          lastTrailPush = now;
          pushTrailPoint(satellite.position);
        }

        // Ground track sampling is driven by mission time, not wall-clock —
        // otherwise a 1.5-hour window at 1x speed would need ~36,000 points
        // (one per 150ms of real time), while at 600x speed it would barely
        // sample at all. Fixed mission-time spacing keeps a consistent,
        // reasonably-sized trail regardless of playback speed.
        if (advancing && !ctrl.reverse && curXKm != null && currentMjd - lastGroundTrackMjd >= GROUND_TRACK_SAMPLE_INTERVAL_DAYS) {
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

      // Sun direction from the subsolar point (earth-local). It drives both the
      // Sun-vector arrow AND the directional light, so the lit hemisphere and
      // the arrow always agree.
      {
        const sub = getSubsolarPoint(currentMjd);
        _subSol.copy(latLonToVector3(sub.lat, sub.lon, 1)).normalize();
        if (sunArrow.visible) sunArrow.setDirection(_subSol);
        _sunWorld.copy(_subSol).applyQuaternion(earth.quaternion).normalize();
        if (sun.intensity > 0) sun.position.copy(_sunWorld).multiplyScalar(60);
        if (sunBody.visible) sunBody.position.copy(_sunWorld).multiplyScalar(SUN_DIST);
        if (moonBody.visible) {
          const m = getMoonEci(currentMjd);
          moonBody.position.set(kmToScene(m.x), kmToScene(m.z), -kmToScene(m.y));
        }
      }

      // Magnetic-field vector at the satellite (spin-aligned centred dipole,
      // moment toward geographic south = scene -Y): B ∝ 3(m̂·r̂)r̂ − m̂.
      if (magArrow.visible) {
        _magR.copy(satellite.position).normalize();
        const mDotR = -_magR.y;
        _magB.set(3 * mDotR * _magR.x, 3 * mDotR * _magR.y + 1, 3 * mDotR * _magR.z).normalize();
        magArrow.position.copy(satellite.position);
        magArrow.setDirection(_magB);
      }

      // Sub-satellite point: surface marker directly beneath the satellite,
      // plus a dashed drop line. "Directly beneath" == along the radius.
      if (subSatGroup.visible) {
        const sp = satellite.position;
        _subPt.copy(sp).setLength(kmToScene(EARTH_RADIUS_KM) * 1.002);
        subSatGroup.children[0].position.copy(_subPt);          // dot
        const ring = subSatGroup.children[1];
        ring.position.copy(_subPt);
        ring.lookAt(0, 0, 0);                                   // lie flat on the surface
        const dpos = subSatGroup.children[2].geometry.attributes.position;
        dpos.setXYZ(0, _subPt.x, _subPt.y, _subPt.z);
        dpos.setXYZ(1, sp.x, sp.y, sp.z);
        dpos.needsUpdate = true;
        subSatGroup.children[2].computeLineDistances();
      }

      // Ground-station line-of-sight: draw a line to the satellite whenever it
      // is above that station's elevation mask (a pass). Endpoints are read
      // straight off the marker's world transform so the line always touches it.
      const gsEntries = sceneRef.current.gsEntries;
      if (gsEntries && gsEntries.length) {
        earth.updateMatrixWorld();
        const sp = satellite.position;
        for (const e of gsEntries) {
          e.marker.getWorldPosition(_gsWorld);
          _toSat.copy(sp).sub(_gsWorld).normalize();
          _gsUp.copy(_gsWorld).normalize();
          const vis = _toSat.dot(_gsUp) > GS_ELEV_SIN;
          e.line.visible = vis;
          if (vis) {
            const pos = e.line.geometry.attributes.position;
            pos.setXYZ(0, _gsWorld.x, _gsWorld.y, _gsWorld.z);
            pos.setXYZ(1, sp.x, sp.y, sp.z);
            pos.needsUpdate = true;
          }
        }
      }

      // After the satellite's position is updated this frame, so "Follow
      // satellite" tracks without a frame of lag.
      updateCamera();
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
      renderer.domElement.removeEventListener("touchstart", onTouchStart);
      renderer.domElement.removeEventListener("touchmove", onTouchMove);
      renderer.domElement.removeEventListener("touchend", onTouchEnd);
      renderer.domElement.removeEventListener("touchcancel", onTouchEnd);
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ground-station markers, labels and LOS lines — rebuilt when the editable
  // list changes. Per-frame LOS updates happen in the animate loop above.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s.earth || !s.scene) return;

    const root = new THREE.Group();
    const entries = [];
    const surfR = kmToScene(EARTH_RADIUS_KM);
    const gsLabelHeight = surfR * 0.03;
    for (const gs of groundStations) {
      if (gs.enabled === false) continue;
      const lat = numOr(gs.lat), lon = numOr(gs.lon), alt = Math.max(0, numOr(gs.alt));
      const p = latLonToVector3(lat, lon, kmToScene(EARTH_RADIUS_KM + alt));
      const isSelected = gs.id === selectedGSId;

      const marker = new THREE.Mesh(
        new THREE.ConeGeometry(isSelected ? 0.1 : 0.06, isSelected ? 0.26 : 0.16, 8),
        new THREE.MeshBasicMaterial({ color: isSelected ? 0xaaffcc : 0x5eff9c })
      );
      marker.position.copy(p);
      marker.lookAt(p.clone().multiplyScalar(2));
      marker.rotateX(Math.PI / 2);
      root.add(marker);

      if (isSelected) {
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(0.14, 0.2, 24),
          new THREE.MeshBasicMaterial({ color: 0x5eff9c, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
        );
        halo.position.copy(p.clone().normalize().multiplyScalar(surfR * 1.001));
        halo.lookAt(0, 0, 0);
        root.add(halo);
      }

      // Label lies flat on the Earth (tangent plane), like the country labels,
      // rather than a camera-facing billboard.
      const { tex, aspect } = makeLabelTexture(gs.name || "station", "#7dffbf");
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(gsLabelHeight * aspect, gsLabelHeight),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
      );
      const lp = p.clone().normalize().multiplyScalar(surfR * 1.004);
      label.position.copy(lp);
      orientFlatOnSphere(label, lp);
      label.translateY(gsLabelHeight * 1.1); // sit just "north" of the marker cone
      label.visible = showLabels;
      root.add(label);

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x5eff9c, transparent: true, opacity: 0.9 }));
      line.frustumCulled = false;
      line.visible = false;
      s.scene.add(line);

      entries.push({ marker, label, line });
    }
    s.earth.add(root);
    s.gsRoot = root;
    s.gsLabels = entries.map((e) => e.label);
    s.gsEntries = entries;

    return () => {
      s.earth.remove(root);
      root.traverse((o) => {
        o.geometry?.dispose?.();
        const m = o.material;
        (Array.isArray(m) ? m : m ? [m] : []).forEach((mm) => { mm.map?.dispose?.(); mm.dispose(); });
      });
      entries.forEach((e) => {
        s.scene.remove(e.line);
        e.line.geometry.dispose();
        e.line.material.dispose();
      });
      if (s.gsRoot === root) { s.gsRoot = null; s.gsEntries = []; s.gsLabels = []; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groundStations, selectedGSId]);

  // Push current control state into the render loop each render
  useEffect(() => {
    const els = rebuildElements();
    const { pts, period } = precomputeOrbitPath(els);
    const s = sceneRef.current;
    if (s.orbitLineGeo) {
      s.orbitLineGeo.setFromPoints(pts);
    }
    if (s.eciAxes) {
      // "Show ECI reference frame" hides the whole thing; "labels" hides only
      // the axis text sprites, leaving the arrow vectors visible.
      s.eciAxes.visible = showAxes;
      s.eciAxes.traverse((o) => { if (o.isSprite) o.visible = showLabels; });
    }
    if (s.ecefAxes) {
      s.ecefAxes.visible = showEcef;
      s.ecefAxes.traverse((o) => { if (o.isSprite) o.visible = showLabels; });
    }
    if (s.sunArrow) s.sunArrow.visible = showSunVector;
    if (s.magArrow) s.magArrow.visible = showMagVector;
    if (s.sunBody) s.sunBody.visible = showBodies;
    if (s.moonBody) s.moonBody.visible = showBodies;
    if (s.subSatGroup) s.subSatGroup.visible = showProjection;
    // Ground-station text labels follow the same "labels" toggle; the marker
    // cones stay visible regardless.
    if (s.gsLabels) s.gsLabels.forEach((l) => { l.visible = showLabels; });
    if (s.countryGroup) {
      s.countryGroup.visible = showCountries;
      const cl = s.countryGroup.getObjectByName("countryLabels");
      if (cl) cl.visible = showCountries;
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
    // Editing the orbit elements would otherwise leave a tangle of trail /
    // ground-track segments from every intermediate orbit. On an actual change,
    // wipe the past trail + tracks and let the loop redraw the forward path
    // fresh for the new orbit (the blue preview ellipse already updated above).
    const orbitElChanged = prevOrbitElRef.current !== null && prevOrbitElRef.current !== orbitEl;
    prevOrbitElRef.current = orbitEl;

    // Clear the trail on a sim<->live switch, on entering/leaving a timeline
    // scrub, or on an orbit-element edit — anything that makes a connecting
    // line between unrelated states meaningless.
    const scrubChanged = s.control && (s.control.scrubTime == null) !== (scrubTime == null);
    if (s.control && (s.control.mode !== nextMode || scrubChanged || orbitElChanged) && s.trailPoints) {
      s.trailPoints.length = 0;
      if (s.trailLine) s.trailLine.geometry.setDrawRange(0, 0);
      groundTrackRef.current = [];
      futureGroundTrackRef.current = [];
    }
    s.control = {
      running,
      speed: Number(speed),
      elements: els,
      mode: nextMode,
      onTelem: setTelem,
      period,
      showFuture,
      showCountries,
      followSat,
      reverse,
      scrubTime: linkState === "LIVE" ? null : scrubTime,
      // bumped on every orbit-element edit so the loop recomputes the forward
      // trajectory immediately instead of on its 3 s timer.
      futureNonce: (s.control?.futureNonce || 0) + (orbitElChanged ? 1 : 0),
      resetNonce: missionResetKey,
    };
    if (!showFuture && s.futureLine) { s.futureLine.visible = false; futureGroundTrackRef.current = []; }
  }, [orbitEl, speed, running, linkState, rebuildElements, showAxes, showSun, showBodies, showFuture, showCountries, showLabels, followSat, scrubTime, reverse, showEcef, showSunVector, showMagVector, showProjection, missionResetKey]);

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
          if (msg.node) {
            setNodeName(msg.node);
            // Register a newly-seen node under the currently-selected realm.
            const rlm = realmRef.current;
            setNodesByRealm((m) => {
              const cur = m[rlm] || [];
              return cur.includes(msg.node) ? m : { ...m, [rlm]: [...cur, msg.node] };
            });
          }
          // Attitude quaternion, when present, drives the Satellite view's model.
          if (msg.alphaatt && typeof msg.alphaatt.w === "number") attitudeRef.current = msg.alphaatt;
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

  // Snap the 3D camera back to its default distance/angle and stop following.
  const resetView = useCallback(() => {
    setFollowSat(false);
    sceneRef.current.resetView?.();
    sceneRef.current.updateCamera?.();
  }, []);

  // Reset the mission clock to the epoch (t=0) and clear the trails.
  const resetMission = useCallback(() => {
    setScrubTime(null);
    setReverse(false);
    groundTrackRef.current = [];
    futureGroundTrackRef.current = [];
    setMissionResetKey((k) => k + 1);
  }, []);

  // Jump the timeline one step (a fraction of the current orbital period)
  // forward (+1) or back (-1), freezing playback at that point.
  const stepMission = useCallback((dir) => {
    const aKm = elementsRef.current?.aKm || EARTH_RADIUS_KM + 550;
    const periodSec = (2 * Math.PI) / Math.sqrt(MU_EARTH / (aKm * aKm * aKm));
    const step = Math.max(30, periodSec / 24); // ~15° of orbit
    setScrubTime((prev) => {
      const base = prev == null ? (telemRef.current?.simSec || 0) : prev;
      return Math.max(0, base + dir * step);
    });
  }, []);

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

      // Ground stations — plus a line to the sub-satellite point during a pass.
      const satEci = t ? { x: t.x, y: t.y, z: t.z } : null;
      const satGP = t ? eciToLatLon(t.x, t.y, t.z, t.mjd) : null;
      for (const station of groundStationsRef.current) {
        if (station.enabled === false) continue;
        const slat = numOr(station.lat), slon = numOr(station.lon), salt = Math.max(0, numOr(station.alt));
        const gsPx = latLonToMercatorPx(slat, slon, w, h);
        let inView = false;
        if (satEci) {
          inView = elevationDeg(satEci, groundStationEci(slat, slon, salt, t.mjd)) >= GS_ELEVATION_MASK_DEG;
        }
        if (inView && satGP) {
          const satPx = latLonToMercatorPx(satGP.lat, satGP.lon, w, h);
          ctx.strokeStyle = "rgba(94,255,156,0.8)";
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(gsPx.x, gsPx.y); ctx.lineTo(satPx.x, satPx.y); ctx.stroke();
        }
        ctx.fillStyle = inView ? "#5eff9c" : "#3f8f66";
        ctx.beginPath(); ctx.arc(gsPx.x, gsPx.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#cfe6ff";
        ctx.font = "11px monospace";
        ctx.fillText(station.name || "station", gsPx.x + 8, gsPx.y - 6);
      }

      // Current satellite position
      if (satGP) {
        const p = latLonToMercatorPx(satGP.lat, satGP.lon, w, h);
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

  // ---- Satellite 3D view — close-up render of the spacecraft ---------------
  // Its own Three.js scene (independent of the orbit scene above), set up when
  // the tab is opened and torn down when it's left. Orientation follows live
  // attitude telemetry (alphaatt) when connected, otherwise a slow spin.
  useEffect(() => {
    if (activeView !== "satellite") return;
    const mount = satMountRef.current;
    if (!mount) return;
    const width = mount.clientWidth, height = mount.clientHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 4000);
    let camDist = 12, camTheta = 0.9, camPhi = 1.05;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    scene.add(buildStarfield(1600));

    scene.add(new THREE.AmbientLight(0x30405c, 1.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(6, 4, 8);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x88aaff, 0.4);
    fillLight.position.set(-8, -3, -6);
    scene.add(fillLight);

    const earthTex = sceneRef.current.earthMat?.map || null;

    // Rotation-mode backdrop: a faint Earth limb far "below".
    const bgEarth = new THREE.Mesh(
      new THREE.SphereGeometry(115, 48, 48),
      earthTex
        ? new THREE.MeshBasicMaterial({ map: earthTex, transparent: true, opacity: 0.5 })
        : new THREE.MeshBasicMaterial({ color: 0x1a3a6b, transparent: true, opacity: 0.4 })
    );
    bgEarth.position.set(0, -150, -55);
    scene.add(bgEarth);

    // Flight-mode Earth: real scene scale at the origin, so the spacecraft flies
    // around it exactly where the 3D Orbit view shows it.
    const SAT_EARTH_R = kmToScene(EARTH_RADIUS_KM);
    const flightEarth = new THREE.Mesh(
      new THREE.SphereGeometry(SAT_EARTH_R, 48, 48),
      earthTex
        ? new THREE.MeshPhongMaterial({ map: earthTex, shininess: 6 })
        : new THREE.MeshPhongMaterial({ color: 0x1a3a6b, shininess: 6 })
    );
    flightEarth.visible = false;
    scene.add(flightEarth);

    // Visible Sun + Moon bodies for the flight (orbital / attitude) modes, so
    // the spacecraft is seen against the same sky as the 3D Orbit view. Sun far
    // along the true Sun direction; Moon at its real geocentric distance.
    const SAT_SUN_DIST = 1400;
    const satSunBody = new THREE.Group();
    satSunBody.add(new THREE.Mesh(
      new THREE.SphereGeometry(SAT_EARTH_R * 6, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0xffe066 })
    ));
    satSunBody.add(new THREE.Mesh(
      new THREE.SphereGeometry(SAT_EARTH_R * 10, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.18, depthWrite: false })
    ));
    satSunBody.add(makeAxisLabel("☀ Sun", "#ffe066", false, SAT_EARTH_R * 14));
    satSunBody.children[2].position.set(0, SAT_EARTH_R * 18, 0);
    satSunBody.visible = false;
    scene.add(satSunBody);

    const satMoonBody = new THREE.Group();
    satMoonBody.add(new THREE.Mesh(
      new THREE.SphereGeometry(SAT_EARTH_R * 0.9, 32, 32),
      new THREE.MeshPhongMaterial({ color: 0xcfd2d6, shininess: 2 })
    ));
    satMoonBody.add(makeAxisLabel("☾ Moon", "#cfd2d6", false, SAT_EARTH_R * 2));
    satMoonBody.children[1].position.set(0, SAT_EARTH_R * 2.4, 0);
    satMoonBody.visible = false;
    scene.add(satMoonBody);

    const model = buildSatModel(satModel);
    scene.add(model);

    // Attitude reference sphere: 3 principal great circles + a lat/lon grid
    // every 30°. Base radius 1 so scene.scale directly gives the sphere size.
    const attSphere = new THREE.Group();
    const ATT_R = 1;
    attSphere.add(new THREE.Mesh(
      new THREE.SphereGeometry(ATT_R * 0.995, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0x3fa9ff, wireframe: true, transparent: true, opacity: 0.06 })
    ));
    const ring = (plane, color, opacity) => {
      const pts = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2, c = Math.cos(a) * ATT_R, s = Math.sin(a) * ATT_R;
        pts.push(plane === "xz" ? new THREE.Vector3(c, 0, s)
          : plane === "xy" ? new THREE.Vector3(c, s, 0)
          : new THREE.Vector3(0, c, s));
      }
      return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    };
    attSphere.add(ring("xz", 0x5c9cff, 0.5), ring("xy", 0x3fa9ff, 0.22), ring("yz", 0x3fa9ff, 0.22));

    // Latitude / longitude grid every 30° (Y is the polar axis).
    const gridMat = new THREE.LineBasicMaterial({ color: 0x6fb6ff, transparent: true, opacity: 0.16 });
    for (let latDeg = -60; latDeg <= 60; latDeg += 30) {
      if (latDeg === 0) continue; // equator is the xz great circle above
      const lat = (latDeg * Math.PI) / 180, rr = ATT_R * Math.cos(lat), yy = ATT_R * Math.sin(lat);
      const pts = [];
      for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; pts.push(new THREE.Vector3(rr * Math.cos(a), yy, rr * Math.sin(a))); }
      attSphere.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
    }
    for (let lonDeg = 0; lonDeg < 180; lonDeg += 30) {
      const lon = (lonDeg * Math.PI) / 180, pts = [];
      for (let i = 0; i <= 96; i++) {
        const u = (i / 96) * Math.PI * 2;
        pts.push(new THREE.Vector3(ATT_R * Math.sin(u) * Math.cos(lon), ATT_R * Math.cos(u), ATT_R * Math.sin(u) * Math.sin(lon)));
      }
      attSphere.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
    }

    // Celestial-coordinate tick labels: right ascension around the equator
    // (0° at +X, increasing toward +Z), declination up the RA=0 meridian.
    const skyLabel = (txt, x, y, z, size = ATT_R * 0.075) => {
      const l = makeAxisLabel(txt, "#7fb6ff", false, size);
      l.position.set(x, y, z);
      attSphere.add(l);
    };
    for (let ra = 0; ra < 360; ra += 60) {
      const a = (ra * Math.PI) / 180;
      skyLabel(`${ra}°`, ATT_R * 1.06 * Math.cos(a), 0, ATT_R * 1.06 * Math.sin(a));
    }
    for (const dec of [-60, -30, 30, 60]) {
      const d = (dec * Math.PI) / 180;
      skyLabel(`${dec > 0 ? "+" : ""}${dec}°`, ATT_R * 1.06 * Math.cos(d), ATT_R * 1.06 * Math.sin(d), 0);
    }
    skyLabel("RA", ATT_R * 1.24, 0, 0, ATT_R * 0.09);
    skyLabel("Dec +90°", 0, ATT_R * 1.16, 0, ATT_R * 0.09);
    scene.add(attSphere);

    // Axis triads. Body triad is a child of the model (tracks its orientation);
    // inertial triad is a child of the scene (never rotates) and is moved to
    // the model's position each frame so the two can be compared.
    const makeTriad = (colors, len) => {
      const g = new THREE.Group();
      [
        [new THREE.Vector3(1, 0, 0), colors[0], "X"],
        [new THREE.Vector3(0, 1, 0), colors[1], "Y"],
        [new THREE.Vector3(0, 0, 1), colors[2], "Z"],
      ].forEach(([d, c, t]) => {
        g.add(new THREE.ArrowHelper(d, new THREE.Vector3(), len, c, len * 0.16, len * 0.09));
        const lbl = makeAxisLabel(t, `#${c.toString(16).padStart(6, "0")}`, false, len * 0.24);
        lbl.position.copy(d.clone().multiplyScalar(len * 1.14));
        g.add(lbl);
      });
      return g;
    };
    const TRIAD_LEN = 2.6;
    const bodyTriad = makeTriad([0xff5c5c, 0x5cff8a, 0x5c9cff], TRIAD_LEN);
    model.add(bodyTriad); // scales with the model
    // Same base length; scaled per-frame to match the (scaled) body triad.
    const inertialTriad = makeTriad([0xff9c9c, 0x9cffc0, 0x9cc4ff], TRIAD_LEN);
    inertialTriad.visible = false;
    scene.add(inertialTriad);

    // Flight-mode orbit ellipse, rebuilt from the current elements.
    const satOrbitGeo = new THREE.BufferGeometry();
    const satOrbitLine = new THREE.LineLoop(satOrbitGeo, new THREE.LineBasicMaterial({ color: 0x8fd7ff, transparent: true, opacity: 0.4 }));
    satOrbitLine.visible = false;
    scene.add(satOrbitLine);
    let lastOrbitBuild = 0;

    // Sun / magnetic-field vectors at the spacecraft (flight modes only).
    const vecArrow = (color, label) => {
      const a = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 3.4, color, 0.5, 0.28);
      const lbl = makeAxisLabel(label, `#${color.toString(16).padStart(6, "0")}`, false, 0.7);
      lbl.position.set(0, 3.7, 0);
      a.add(lbl);
      a.visible = false;
      return a;
    };
    const satSunArrow = vecArrow(0xffe066, "☀ Sun");
    const satMagArrow = vecArrow(0xff6ec7, "B");
    scene.add(satSunArrow, satMagArrow);

    // ECI -> scene-frame remap for raw telemetry attitude quaternions.
    const R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const Rinv = R.clone().invert();
    const _yAxis = new THREE.Vector3(0, 1, 0);
    const qTmp = new THREE.Quaternion();
    const qTarget = new THREE.Quaternion();
    const qRead = new THREE.Quaternion();
    const eulRead = new THREE.Euler();
    const _p = new THREE.Vector3(), _nadir = new THREE.Vector3(), _vel = new THREE.Vector3();
    const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
    const _sun = new THREE.Vector3(), _magR = new THREE.Vector3(), _magB = new THREE.Vector3();
    const _magBody = new THREE.Vector3(), _sunBody = new THREE.Vector3(), _qInv = new THREE.Quaternion();
    const _mBasis = new THREE.Matrix4();
    let lastAttPush = 0;
    let lastMode = null;

    let dragging = false, lastX = 0, lastY = 0, touchCount = 0, pinchPrev = 0;
    const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
    const onUp = () => { dragging = false; };
    const onMove = (e) => {
      if (!dragging || touchCount >= 2) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      camTheta += dx * 0.005;
      camPhi = Math.min(Math.max(camPhi - dy * 0.005, 0.15), Math.PI - 0.15);
    };
    const onWheel = (e) => {
      e.preventDefault();
      camDist = Math.min(Math.max(camDist + e.deltaY * 0.02, 3), 70);
    };
    const pinchGap = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e) => {
      touchCount = e.touches.length;
      if (touchCount >= 2) { dragging = false; pinchPrev = pinchGap(e.touches); }
    };
    const onTouchMove = (e) => {
      if (e.touches.length < 2) return;
      e.preventDefault();
      const gap = pinchGap(e.touches);
      if (pinchPrev) camDist = Math.min(Math.max(camDist + (pinchPrev - gap) * 0.05, 3), 70);
      pinchPrev = gap;
    };
    const onTouchEnd = (e) => {
      touchCount = e.touches.length;
      if (touchCount < 2) pinchPrev = 0;
    };
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    renderer.domElement.addEventListener("touchstart", onTouchStart, { passive: false });
    renderer.domElement.addEventListener("touchmove", onTouchMove, { passive: false });
    renderer.domElement.addEventListener("touchend", onTouchEnd);
    renderer.domElement.addEventListener("touchcancel", onTouchEnd);

    let raf;
    let lastFrame = performance.now();
    let spin = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;

      const ctl = satCtlRef.current;
      const isRunning = ctl.running;
      const link = ctl.linkState;
      const mode = ctl.mode || "turntable";
      const t = telemRef.current;
      const att = attitudeRef.current;
      const liveAtt = link === "LIVE" && att;
      const flying = (mode === "orbital" || mode === "attitude") && t;

      // Re-frame the camera on a mode switch.
      if (mode !== lastMode) {
        lastMode = mode;
        camDist = mode === "orbital" ? 18 : mode === "attitude" ? 9 : 12;
        camTheta = 0.9; camPhi = 1.05;
      }

      bodyTriad.visible = !!ctl.bodyAxes;
      inertialTriad.visible = !!ctl.inertialAxes;

      let src;
      if (flying) {
        flightEarth.visible = true;
        bgEarth.visible = false;
        satOrbitLine.visible = mode === "orbital";
        flightEarth.rotation.y = gmstRadians(t.mjd);

        _p.set(kmToScene(t.x), kmToScene(t.z), -kmToScene(t.y));
        model.position.copy(_p);
        model.scale.setScalar(ctl.modelScale || 0.22);
        inertialTriad.position.copy(_p);
        inertialTriad.scale.setScalar(ctl.modelScale || 0.22); // match the (scaled) body triad

        // Nominal flight attitude: body +Z -> nadir, body +X -> velocity.
        _nadir.copy(_p).multiplyScalar(-1).normalize();
        _vel.set(t.vx, t.vz, -t.vy);
        if (_vel.lengthSq() < 1e-9) _vel.set(1, 0, 0);
        _vel.normalize();
        _bz.copy(_nadir);
        _bx.copy(_vel).addScaledVector(_bz, -_vel.dot(_bz));
        if (_bx.lengthSq() < 1e-9) _bx.set(1, 0, 0); else _bx.normalize();
        _by.copy(_bz).cross(_bx).normalize(); // Y = Z x X (right-handed)
        _mBasis.makeBasis(_bx, _by, _bz);
        model.quaternion.setFromRotationMatrix(_mBasis);

        // Magnetic-field direction (world) and its body-frame components, for
        // the arrow and the Attitude Telemetry readout.
        _magR.copy(_p).normalize();
        {
          const mDotR = -_magR.y;
          _magB.set(3 * mDotR * _magR.x, 3 * mDotR * _magR.y + 1, 3 * mDotR * _magR.z).normalize();
        }
        _qInv.copy(model.quaternion).invert();
        _magBody.copy(_magB).applyQuaternion(_qInv);

        // Sun direction (world), and its body-frame components.
        {
          const sub = getSubsolarPoint(t.mjd);
          _sun.copy(latLonToVector3(sub.lat, sub.lon, 1)).applyAxisAngle(_yAxis, gmstRadians(t.mjd)).normalize();
        }
        _sunBody.copy(_sun).applyQuaternion(_qInv);

        // Attitude sphere: around the spacecraft in "attitude" mode (sized to
        // the model), origin + turntable radius otherwise.
        if (mode === "attitude") {
          attSphere.visible = true;
          attSphere.position.copy(_p);
          attSphere.scale.setScalar(2 * (ctl.attScale || 1));
        } else {
          attSphere.visible = false;
        }

        if (now - lastOrbitBuild > 1500 && elementsRef.current) {
          lastOrbitBuild = now;
          try {
            const path = precomputeOrbitPath(elementsRef.current, 200);
            satOrbitGeo.setFromPoints(path.pts);
          } catch (e) { /* skip */ }
        }

        camera.position.set(
          _p.x + camDist * Math.sin(camPhi) * Math.cos(camTheta),
          _p.y + camDist * Math.cos(camPhi),
          _p.z + camDist * Math.sin(camPhi) * Math.sin(camTheta)
        );
        camera.lookAt(_p);
        src = mode === "attitude" ? "attitude · Z→nadir / X→vel" : "orbital · Z→nadir / X→vel";
      } else {
        flightEarth.visible = false;
        bgEarth.visible = true;
        attSphere.visible = true;
        attSphere.position.set(0, 0, 0);
        attSphere.scale.setScalar(6 * (ctl.attScale || 1));
        satOrbitLine.visible = false;
        model.position.set(0, 0, 0);
        model.scale.setScalar(1);
        inertialTriad.position.set(0, 0, 0);
        inertialTriad.scale.setScalar(1);

        if (liveAtt) {
          qTmp.set(att.x, att.y, att.z, att.w).normalize();
          qTarget.copy(R).multiply(qTmp).multiply(Rinv);
          model.quaternion.slerp(qTarget, Math.min(1, dt * 4));
          src = "turntable · live attitude";
        } else if (isRunning) {
          spin += dt * 0.35;
          model.quaternion.setFromEuler(new THREE.Euler(0.15, spin, 0));
          src = "turntable · presentation spin";
        } else {
          src = "turntable · paused";
        }

        camera.position.set(
          camDist * Math.sin(camPhi) * Math.cos(camTheta),
          camDist * Math.cos(camPhi),
          camDist * Math.sin(camPhi) * Math.sin(camTheta)
        );
        camera.lookAt(0, 0, 0);
      }

      // Sun / magnetic-field vectors (flight modes only). Scaled to the same
      // on-screen size as the body triad (2.6 units at the model's scale).
      satSunArrow.visible = flying && !!ctl.sunVec;
      satMagArrow.visible = flying && !!ctl.magVec;
      const vecScale = (2.6 * (ctl.modelScale || 0.22)) / 3.4;
      if (satSunArrow.visible) {
        satSunArrow.position.copy(_p);
        satSunArrow.scale.setScalar(vecScale);
        satSunArrow.setDirection(_sun); // _sun set above in the flying branch
      }
      if (satMagArrow.visible) {
        satMagArrow.position.copy(_p);
        satMagArrow.scale.setScalar(vecScale);
        satMagArrow.setDirection(_magB); // _magB set above in the flying branch
      }

      // Visible Sun + Moon bodies — flight modes only (the turntable is an
      // abstract presentation with no real sky around it).
      satSunBody.visible = flying;
      satMoonBody.visible = flying;
      if (flying) {
        satSunBody.position.copy(_sun).multiplyScalar(SAT_SUN_DIST); // _sun = world Sun unit vec
        const mm = getMoonEci(t.mjd);
        satMoonBody.position.set(kmToScene(mm.x), kmToScene(mm.z), -kmToScene(mm.y));
      }

      // Publish attitude (~6 Hz) for the readout, incl. body-frame B and Sun.
      if (now - lastAttPush > 160) {
        lastAttPush = now;
        qRead.copy(model.quaternion);
        eulRead.setFromQuaternion(qRead, "ZYX");
        setSatAtt({
          w: qRead.w, x: qRead.x, y: qRead.y, z: qRead.z,
          roll: THREE.MathUtils.radToDeg(eulRead.x),
          pitch: THREE.MathUtils.radToDeg(eulRead.y),
          yaw: THREE.MathUtils.radToDeg(eulRead.z),
          src,
          mag: flying ? { x: _magBody.x, y: _magBody.y, z: _magBody.z } : null,
          sun: flying ? { x: _sunBody.x, y: _sunBody.y, z: _sunBody.z } : null,
        });
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
      renderer.domElement.removeEventListener("touchstart", onTouchStart);
      renderer.domElement.removeEventListener("touchmove", onTouchMove);
      renderer.domElement.removeEventListener("touchend", onTouchEnd);
      renderer.domElement.removeEventListener("touchcancel", onTouchEnd);
      scene.traverse((obj) => {
        if (obj.isMesh || obj.isPoints || obj.isLine) obj.geometry?.dispose();
        const m = obj.material;
        (Array.isArray(m) ? m : m ? [m] : []).forEach((mm) => {
          if (mm.map && mm.map !== earthTex) mm.map.dispose();
          mm.dispose();
        });
      });
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, satModel]);

  const linkColor = { LIVE: "#5ee6a8", CONNECTING: "#ffb454", ERROR: "#ff6a6a", SIMULATED: "#8fd7ff" }[linkState];

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

      <div style={{ display: "flex", gap: 8, marginTop: 10, marginBottom: 6 }}>
        <button
          onClick={() => setReverse((r) => !r)}
          title="Playback direction"
          style={{
            ...btnStyle,
            background: reverse ? "rgba(255,180,84,0.22)" : "rgba(143,215,255,0.1)",
            border: `1px solid ${reverse ? "rgba(255,180,84,0.6)" : "rgba(143,215,255,0.3)"}`,
            color: reverse ? "#ffd9b0" : "#cfe6ff",
          }}
        >
          {reverse ? "◀ Reverse" : "▶ Forward"}
        </button>
        <button onClick={() => setRunning((r) => !r)} style={btnStyle}>{running ? "Pause" : "Resume"}</button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <input type="range" min={1} max={600} value={speed} onChange={(e) => setSpeed(e.target.value)} style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "#5f7396", minWidth: 34, textAlign: "right" }}>{speed}x</span>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={resetMission} style={btnStyle}>⟲ Reset mission</button>
      </div>

      {include3DOnlyToggles && (
        <>
          {[
            ["ECI reference frame", showAxes, setShowAxes],
            ["ECEF reference frame", showEcef, setShowEcef],
            ["Sun & Moon bodies", showBodies, setShowBodies],
            ["Sun vector", showSunVector, setShowSunVector],
            ["Magnetic vector", showMagVector, setShowMagVector],
            ["Sub-satellite point (projection)", showProjection, setShowProjection],
            ["Country boundaries + labels", showCountries, setShowCountries],
            ["Ground-station & frame labels", showLabels, setShowLabels],
          ].map(([label, val, set]) => (
            <label key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fa2c2", marginBottom: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={val} onChange={(e) => set(e.target.checked)} />
              {label}
            </label>
          ))}

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fa2c2", marginBottom: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={showSun} onChange={(e) => setShowSun(e.target.checked)} />
            Sunlight {showSun ? "on" : "off (full visibility)"}
          </label>

          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button
              onClick={() => setFollowSat((f) => !f)}
              style={{
                ...btnStyle,
                background: followSat ? "rgba(143,215,255,0.28)" : "rgba(143,215,255,0.1)",
                border: `1px solid ${followSat ? "rgba(143,215,255,0.7)" : "rgba(143,215,255,0.3)"}`,
                color: followSat ? "#eaf3ff" : "#cfe6ff",
              }}
            >
              {followSat ? "Following ✓" : "Follow satellite"}
            </button>
            <button onClick={resetView} style={btnStyle}>Reset view</button>
          </div>
        </>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fa2c2", marginBottom: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={showFuture} onChange={(e) => setShowFuture(e.target.checked)} />
        Show future trajectory
      </label>

      <div style={{ fontSize: 11, color: "#7d93b8", margin: "10px 0 6px", fontFamily: "system-ui,sans-serif" }}>LIVE TELEMETRY (COSMOS SERVER)</div>
      <input placeholder="ws://localhost:8080/telem" value={wsUrl} onChange={(e) => setWsUrl(e.target.value)}
        style={{ width: "100%", background: "#0c1428", border: "1px solid rgba(143,215,255,0.25)", color: "#cfe6ff", borderRadius: 4, padding: "6px 8px", fontSize: 12, marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={connect} style={btnStyle}>Connect</button>
        <button onClick={disconnect} style={btnStyle}>Disconnect</button>
      </div>
    </>
  );

  // The controls "dock": a floating glass panel on desktop (collapsible to its
  // header so more of the scene is visible), a bottom sheet on mobile.
  // `bottomPx` lifts it clear of the mission-timeline bar on the orbit views.
  const renderControlsDock = (include3DOnlyToggles, bottomPx = 22) => {
    if (!isMobile) {
      return (
        <div style={{
          position: "absolute", right: 22, bottom: bottomPx, width: controlsCollapsed ? "auto" : 280,
          maxHeight: `calc(100% - ${bottomPx + 22}px)`, overflowY: "auto",
          background: "rgba(9,14,28,0.72)", border: "1px solid rgba(143,215,255,0.18)",
          borderRadius: 6, padding: "12px 16px", backdropFilter: "blur(4px)",
        }}>
          <div
            onClick={() => setControlsCollapsed((c) => !c)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, cursor: "pointer" }}
          >
            <span style={{ fontSize: 11, color: "#7d93b8", fontFamily: "system-ui,sans-serif", letterSpacing: 0.5 }}>ORBIT CONTROL DISPLAY</span>
            <span style={{ fontSize: 12, color: "#8fa2c2" }}>{controlsCollapsed ? "▸" : "▾"}</span>
          </div>
          {!controlsCollapsed && (
            <div style={{ marginTop: 10 }}>{renderControlsPanelContent(include3DOnlyToggles)}</div>
          )}
        </div>
      );
    }
    return (
      <>
        {!panelOpen && (
          <button
            onClick={() => setPanelOpen(true)}
            style={{
              position: "absolute", right: 12, bottom: bottomPx - 10, zIndex: 6,
              background: "rgba(9,14,28,0.92)", border: "1px solid rgba(143,215,255,0.35)",
              color: "#eaf3ff", borderRadius: 999, padding: "10px 18px", fontSize: 13,
              fontFamily: "'IBM Plex Mono',monospace", boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            }}
          >
            ☰ Orbit Controls
          </button>
        )}
        {panelOpen && (
          <>
            <div
              onClick={() => setPanelOpen(false)}
              style={{ position: "absolute", inset: 0, background: "rgba(3,6,12,0.5)", zIndex: 6 }}
            />
            <div style={{
              position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 7,
              maxHeight: "72%", overflowY: "auto", WebkitOverflowScrolling: "touch",
              background: "rgba(9,14,28,0.98)", borderTop: "1px solid rgba(143,215,255,0.3)",
              borderRadius: "16px 16px 0 0", padding: "8px 18px 24px",
            }}>
              <div style={{
                position: "sticky", top: 0, background: "rgba(9,14,28,0.98)",
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "6px 0 10px",
              }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(143,215,255,0.35)", position: "absolute", left: "50%", transform: "translateX(-50%)", top: 0 }} />
                <span style={{ fontSize: 12, color: "#7d93b8", fontFamily: "system-ui,sans-serif", letterSpacing: 0.5 }}>ORBIT CONTROL DISPLAY</span>
                <button
                  onClick={() => setPanelOpen(false)}
                  style={{ background: "transparent", border: "none", color: "#8fa2c2", fontSize: 20, lineHeight: 1, padding: "2px 6px", cursor: "pointer" }}
                >
                  ✕
                </button>
              </div>
              {renderControlsPanelContent(include3DOnlyToggles)}
            </div>
          </>
        )}
      </>
    );
  };

  // Full-width mission-timeline scrubber pinned to the bottom of the orbit
  // views — wide, for fine control over which slice of the orbit to analyse.
  const renderTimelineBar = () => {
    const nowSec = telem.simSec || 0;
    const cur = scrubTime == null ? nowSec : scrubTime;
    const tlMax = Math.max(4 * 3600, Math.ceil((cur + 3600) / 300) * 300);
    // Same number of discrete steps as the speed selector (1×…600×) → 600.
    const tlStep = Math.max(1, Math.round(tlMax / 600));
    const live = linkState === "LIVE";
    const sbtn = { ...btnStyle, flex: "none", padding: "5px 9px", fontSize: 11 };
    return (
      <div style={{
        position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 4,
        display: "flex", alignItems: "center", gap: isMobile ? 8 : 14, flexWrap: "wrap",
        padding: isMobile ? "8px 10px" : "9px 18px",
        background: "rgba(9,14,28,0.85)", borderTop: "1px solid rgba(143,215,255,0.15)",
        backdropFilter: "blur(4px)", opacity: live ? 0.55 : 1,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, whiteSpace: "nowrap" }}>
          <span style={{ fontSize: 10, letterSpacing: 0.5, color: "#7d93b8", fontFamily: "system-ui,sans-serif" }}>MISSION TIMELINE</span>
          <span style={{ fontSize: 13, color: "#ffb454", fontVariantNumeric: "tabular-nums" }}>{fmtDuration(cur)}</span>
        </div>
        <input
          type="range" min={0} max={tlMax} step={tlStep}
          value={Math.min(cur, tlMax)}
          disabled={live}
          onChange={(e) => setScrubTime(Number(e.target.value))}
          style={{ flex: 1, minWidth: 140 }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
          {!isMobile && <button onClick={() => stepMission(-1)} disabled={live} style={sbtn} title="Step back ~15° of orbit">◂ Step</button>}
          {!isMobile && <button onClick={() => stepMission(1)} disabled={live} style={sbtn} title="Step forward ~15° of orbit">Step ▸</button>}
          {!isMobile && <button onClick={resetMission} disabled={live} style={sbtn} title="Back to mission start">⟲ Reset</button>}
          {scrubTime != null && !live && (
            <button onClick={() => setScrubTime(null)} style={{ ...sbtn, color: "#5eff9c", border: "1px solid rgba(94,255,156,0.5)" }}>↩ Live</button>
          )}
          <span style={{ fontSize: 10, color: "#5f7396", minWidth: 40 }}>
            {live ? "live" : scrubTime != null ? "frozen" : running ? (reverse ? "◀ rev" : "▶ play") : "paused"}
          </span>
        </div>
      </div>
    );
  };

  // Attitude Control Display — replaces the Orbit Control Display on the
  // Satellite 3D view. Switches between "rotation" (design inspection) and
  // "flight" (real orbital attitude) and toggles the axis triads.
  const renderAttitudeControlDisplay = () => {
    const seg = (id, label) => (
      <button
        key={id}
        onClick={() => setSatViewMode(id)}
        style={{
          flex: 1, borderRadius: 4, padding: "6px 8px", fontSize: 11, cursor: "pointer",
          fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap",
          background: satViewMode === id ? "rgba(143,215,255,0.2)" : "transparent",
          border: `1px solid ${satViewMode === id ? "rgba(143,215,255,0.5)" : "rgba(143,215,255,0.2)"}`,
          color: satViewMode === id ? "#eaf3ff" : "#8fa2c2",
        }}
      >
        {label}
      </button>
    );
    const sub = { fontSize: 10, letterSpacing: 0.5, color: "#5f7396", fontFamily: "system-ui,sans-serif", margin: "6px 0 6px" };
    return (
      <div style={{
        position: "absolute", right: 22, bottom: 64, width: controlsCollapsed ? "auto" : 264,
        maxHeight: "calc(100% - 86px)", overflowY: "auto",
        background: "rgba(9,14,28,0.72)", border: "1px solid rgba(143,215,255,0.18)",
        borderRadius: 6, padding: "12px 16px", backdropFilter: "blur(4px)",
      }}>
        <div
          onClick={() => setControlsCollapsed((c) => !c)}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, cursor: "pointer" }}
        >
          <span style={{ fontSize: 11, color: "#7d93b8", fontFamily: "system-ui,sans-serif", letterSpacing: 0.5 }}>ATTITUDE CONTROL DISPLAY</span>
          <span style={{ fontSize: 12, color: "#8fa2c2" }}>{controlsCollapsed ? "▸" : "▾"}</span>
        </div>
        {!controlsCollapsed && (
          <div style={{ marginTop: 10 }}>
            <div style={sub}>SPACECRAFT VIEW</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              {seg("turntable", "Turntable")}
              {seg("orbital", "Orbital")}
              {seg("attitude", "Attitude")}
            </div>
            <div style={{ fontSize: 10, color: "#5f7396", marginBottom: 10, lineHeight: 1.4 }}>
              {satViewMode === "turntable"
                ? "Turntable spin at the origin — for inspecting the model. Not tied to flight dynamics."
                : satViewMode === "orbital"
                  ? "Flying at its real orbital position; body Z→nadir, X→velocity."
                  : "Attitude sphere around the spacecraft, oriented by the dynamics, above the correct Earth site."}
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fa2c2", marginBottom: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={showBodyAxes} onChange={(e) => setShowBodyAxes(e.target.checked)} />
              Enable body axis
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fa2c2", marginBottom: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={showInertialAxes} onChange={(e) => setShowInertialAxes(e.target.checked)} />
              Enable inertial axis
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fa2c2", marginBottom: 8, cursor: "pointer", opacity: satViewMode === "turntable" ? 0.4 : 1 }}>
              <input type="checkbox" checked={showSunVector} onChange={(e) => setShowSunVector(e.target.checked)} />
              Enable Sun vector
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fa2c2", marginBottom: 10, cursor: "pointer", opacity: satViewMode === "turntable" ? 0.4 : 1 }}>
              <input type="checkbox" checked={showMagVector} onChange={(e) => setShowMagVector(e.target.checked)} />
              Enable magnetic vector
            </label>

            {satViewMode !== "turntable" && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", ...sub, margin: "6px 0 3px" }}>
                  <span>MODEL SIZE</span><span>{satModelScale.toFixed(2)}×</span>
                </div>
                <input type="range" min={0.05} max={1} step={0.01} value={satModelScale}
                  onChange={(e) => setSatModelScale(Number(e.target.value))} style={{ width: "100%", marginBottom: 6 }} />
              </>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", ...sub, margin: "6px 0 3px" }}>
              <span>ATTITUDE SPHERE SIZE</span><span>{attSphereScale.toFixed(2)}×</span>
            </div>
            <input type="range" min={0.3} max={2} step={0.05} value={attSphereScale}
              onChange={(e) => setAttSphereScale(Number(e.target.value))} style={{ width: "100%", marginBottom: 6 }} />

            <div style={sub}>MODEL</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {SAT_MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSatModel(m.id)}
                  style={{
                    background: satModel === m.id ? "rgba(143,215,255,0.18)" : "transparent",
                    border: satModel === m.id ? "1px solid rgba(143,215,255,0.45)" : "1px solid rgba(143,215,255,0.2)",
                    color: satModel === m.id ? "#eaf3ff" : "#8fa2c2",
                    borderRadius: 4, padding: "5px 9px", fontSize: 11, cursor: "pointer",
                    fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap",
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{
      position: "relative", width: "100%", height: "100%", minHeight: isMobile ? 0 : 560,
      background: "radial-gradient(circle at 30% 20%, #0a1226 0%, #05070d 70%)",
      fontFamily: "'IBM Plex Mono','SFMono-Regular',Menlo,monospace",
      color: "#cfe6ff", overflow: "hidden", display: "flex", flexDirection: "column",
    }}>
      {/* Top bar: always visible across all views. On mobile it wraps so the
          tab strip drops to its own full-width, horizontally-scrollable row. */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexWrap: isMobile ? "wrap" : "nowrap", rowGap: isMobile ? 8 : 0,
        padding: isMobile ? "9px 12px" : "14px 22px",
        borderBottom: "1px solid rgba(143,215,255,0.12)",
        background: "rgba(9,14,28,0.6)", zIndex: 2, flexShrink: 0,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "system-ui,sans-serif", fontSize: isMobile ? 11 : 13, fontWeight: 600, letterSpacing: 0.5, color: "#7d93b8" }}>COSMOS WEB</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <span style={{ display: "inline-block", width: 38, fontFamily: "system-ui,sans-serif", fontSize: isMobile ? 8 : 9, letterSpacing: 0.6, color: "#5f7396" }}>NODE</span>
            <span style={{ fontSize: isMobile ? 10 : 11, fontWeight: 500, color: "#eaf3ff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nodeName}</span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <span style={{ display: "inline-block", width: 38, fontFamily: "system-ui,sans-serif", fontSize: isMobile ? 8 : 9, letterSpacing: 0.6, color: "#5f7396" }}>REALM</span>
            <span style={{ fontSize: isMobile ? 10 : 11, fontWeight: 500, color: "#8fa2c2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{realm}</span>
          </div>
        </div>

        <div style={{
          display: "flex", gap: 6,
          order: isMobile ? 3 : 0,
          flexBasis: isMobile ? "100%" : "auto",
          overflowX: isMobile ? "auto" : "visible",
          WebkitOverflowScrolling: "touch",
        }}>
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveView(tab.id)}
              style={{
                background: activeView === tab.id ? "rgba(143,215,255,0.16)" : "transparent",
                border: activeView === tab.id ? "1px solid rgba(143,215,255,0.4)" : "1px solid transparent",
                color: activeView === tab.id ? "#eaf3ff" : "#8fa2c2",
                borderRadius: 5, padding: isMobile ? "7px 12px" : "6px 14px",
                fontSize: 12, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap",
                fontFamily: "'IBM Plex Mono',monospace",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: isMobile ? "auto" : 0 }}>
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
          <div ref={mountRef} style={{ position: "absolute", inset: 0, touchAction: "none" }} />

          {/* Telemetry HUD — hidden on mobile (the Telemetry tab covers this);
              collapsible to its header so more of the globe is visible. */}
          <div style={{
            position: "absolute", left: 22, bottom: 64, width: telemCollapsed ? "auto" : 240,
            display: isMobile ? "none" : "block",
            background: "rgba(9,14,28,0.72)", border: "1px solid rgba(143,215,255,0.18)",
            borderRadius: 6, padding: "12px 16px", backdropFilter: "blur(4px)",
          }}>
            <div
              onClick={() => setTelemCollapsed((c) => !c)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, cursor: "pointer" }}
            >
              <span style={{ fontSize: 11, color: "#7d93b8", fontFamily: "system-ui,sans-serif", letterSpacing: 0.5 }}>ECI TELEMETRY</span>
              <span style={{ fontSize: 12, color: "#8fa2c2" }}>{telemCollapsed ? "▸" : "▾"}</span>
            </div>
            {!telemCollapsed && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "88px 1fr", rowGap: 4, columnGap: 10, marginTop: 8 }}>
                  {(() => {
                    const { lat, lon } = eciToLatLon(telem.x, telem.y, telem.z, telem.mjd);
                    return [
                      ["Satellite", satName],
                      ["UTC (MJD)", telem.mjd.toFixed(6)],
                      ["UTC", mjdToISO(telem.mjd)],
                      ["MET", fmtDuration(metStartRef.current == null ? 0 : (telem.mjd - metStartRef.current) * 86400)],
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
              </>
            )}
          </div>

          {/* Controls dock (floating panel on desktop, bottom sheet on mobile) */}
          {renderControlsDock(true, 64)}
          {renderTimelineBar()}
        </div>

        {/* 2D View — Mercator ground-track map */}
        {activeView === "2d" && (
          <div style={{ position: "absolute", inset: 0 }}>
            <canvas ref={map2dCanvasRef} style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} />
            <div style={{
              position: "absolute", left: isMobile ? 10 : 22, top: isMobile ? 10 : 16, right: isMobile ? 10 : "auto",
              fontSize: isMobile ? 10 : 11, color: "#7d93b8",
              fontFamily: "system-ui,sans-serif", background: "rgba(9,14,28,0.6)",
              padding: "6px 10px", borderRadius: 5,
            }}>
              {isMobile
                ? "Mercator · yellow = orbit · white = +1.5h · shaded = night"
                : "Mercator · yellow = current orbit (1.5h) · white dashed = future orbit (1.5h) · shaded = night side + city lights"}
            </div>

            {renderControlsDock(false, 64)}
            {renderTimelineBar()}
          </div>
        )}

        {/* Satellite 3D View — close-up render of the spacecraft */}
        {activeView === "satellite" && (
          <div style={{ position: "absolute", inset: 0 }}>
            <div ref={satMountRef} style={{ position: "absolute", inset: 0, touchAction: "none" }} />

            <div style={{
              position: "absolute", left: isMobile ? 10 : 22, top: isMobile ? 10 : 16, right: isMobile ? 10 : "auto",
              fontSize: isMobile ? 10 : 11, color: "#7d93b8",
              fontFamily: "system-ui,sans-serif", background: "rgba(9,14,28,0.6)",
              padding: "6px 10px", borderRadius: 5,
            }}>
              {satName} · {isMobile ? "drag / pinch" : "drag to orbit · scroll to zoom"} ·{" "}
              {satViewMode === "turntable"
                ? (linkState === "LIVE" && attitudeRef.current ? "turntable · live attitude" : "turntable · presentation spin")
                : satViewMode === "orbital"
                  ? "orbital view · Z→nadir / X→velocity"
                  : "attitude view · dynamics-driven, over the correct site"}
            </div>

            {/* Spacecraft telemetry readout — hidden on mobile (Telemetry tab
                covers it); collapsible to its header. */}
            <div style={{
              position: "absolute", left: 22, bottom: 64, width: telemCollapsed ? "auto" : 252,
              maxHeight: "calc(100% - 150px)", overflowY: "auto",
              display: isMobile ? "none" : "block",
              background: "rgba(9,14,28,0.72)", border: "1px solid rgba(143,215,255,0.18)",
              borderRadius: 6, padding: "12px 16px", backdropFilter: "blur(4px)",
            }}>
              <div
                onClick={() => setTelemCollapsed((c) => !c)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, cursor: "pointer", marginBottom: telemCollapsed ? 0 : 10 }}
              >
                <span style={{ fontSize: 11, color: "#7d93b8", fontFamily: "system-ui,sans-serif", letterSpacing: 0.5 }}>ATTITUDE TELEMETRY</span>
                <span style={{ fontSize: 12, color: "#8fa2c2" }}>{telemCollapsed ? "▸" : "▾"}</span>
              </div>
              {!telemCollapsed && (() => {
                const spd = Math.sqrt(telem.vx ** 2 + telem.vy ** 2 + telem.vz ** 2).toFixed(2);
                const metSec = metStartRef.current == null ? 0 : (telem.mjd - metStartRef.current) * 86400;
                const groups = [
                  { title: "STATE", rows: [
                    ["Name", satName],
                    ["Model", SAT_MODELS.find((m) => m.id === satModel).label],
                    ["Alt (km)", telem.alt.toFixed(1)],
                    ["Speed", `${spd} km/s`],
                  ] },
                  { title: `ATTITUDE · ${satAtt.src}`, rows: [
                    ["Quat w", satAtt.w.toFixed(4)],
                    ["Quat x", satAtt.x.toFixed(4)],
                    ["Quat y", satAtt.y.toFixed(4)],
                    ["Quat z", satAtt.z.toFixed(4)],
                    ["Roll", `${satAtt.roll.toFixed(1)}°`],
                    ["Pitch", `${satAtt.pitch.toFixed(1)}°`],
                    ["Yaw", `${satAtt.yaw.toFixed(1)}°`],
                  ] },
                  ...(satAtt.sun ? [{ title: "SUN VECTOR (body, unit)", rows: [
                    ["Sx", satAtt.sun.x.toFixed(3)],
                    ["Sy", satAtt.sun.y.toFixed(3)],
                    ["Sz", satAtt.sun.z.toFixed(3)],
                  ] }] : []),
                  ...(satAtt.mag ? [{ title: "MAG FIELD (body, unit)", rows: [
                    ["Bx", satAtt.mag.x.toFixed(3)],
                    ["By", satAtt.mag.y.toFixed(3)],
                    ["Bz", satAtt.mag.z.toFixed(3)],
                  ] }] : []),
                  { title: "TIME", rows: [
                    ["UTC", mjdToISO(telem.mjd)],
                    ["MET", fmtDuration(metSec)],
                  ] },
                ];
                return groups.map((g) => (
                  <div key={g.title} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: "#5f7396", letterSpacing: 0.5, fontFamily: "system-ui,sans-serif", marginBottom: 4 }}>{g.title}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "58px 1fr", rowGap: 3, columnGap: 10 }}>
                      {g.rows.map(([label, val]) => (
                        <React.Fragment key={label}>
                          <span style={{ fontSize: 12, color: "#5f7396" }}>{label}</span>
                          <span style={{ fontSize: 12, color: "#ffb454", fontVariantNumeric: "tabular-nums" }}>{val}</span>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ));
              })()}
            </div>

            {renderAttitudeControlDisplay()}
            {renderTimelineBar()}
          </div>
        )}

        {/* Space Game — EPET-based training modules */}
        {activeView === "game" && (
          <div style={{ position: "absolute", inset: 0 }}>
            <SpaceGame
              isMobile={isMobile}
              satName={satName}
              onApplyOrbit={(o) => setOrbitEl(o)}
              onOpenView={(v) => setActiveView(v)}
            />
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
            <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: isMobile ? "20px 12px" : "32px 22px", WebkitOverflowScrolling: "touch" }}>
              <div style={{ maxWidth: 520, margin: "0 auto" }}>
                <div style={{ fontSize: 13, color: "#7d93b8", marginBottom: 16, fontFamily: "system-ui,sans-serif" }}>
                  FULL TELEMETRY
                </div>
                <div style={{
                  display: "grid", gridTemplateColumns: isMobile ? "115px 1fr" : "180px 1fr", rowGap: 10, columnGap: 16,
                  background: "rgba(9,14,28,0.5)", border: "1px solid rgba(143,215,255,0.15)",
                  borderRadius: 8, padding: isMobile ? 14 : 20,
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

        {/* Mission Configurator tab — realm + node */}
        {activeView === "mission" && (
          <MissionConfigurator
            realm={realm} setRealm={setRealm}
            realms={realms} setRealms={setRealms}
            nodesByRealm={nodesByRealm} setNodesByRealm={setNodesByRealm}
            nodeName={nodeName} setNodeName={setNodeName}
            groundStations={groundStations}
            isMobile={isMobile}
          />
        )}

        {/* Ground Stations tab */}
        {activeView === "groundstations" && (
          <GroundStationsView
            telem={telem}
            groundStations={groundStations} setGroundStations={setGroundStations}
            selectedGSId={selectedGSId} setSelectedGSId={setSelectedGSId}
            isMobile={isMobile}
          />
        )}

      </div>

      <div style={{
        textAlign: "center", padding: "4px 0",
        fontSize: 10, color: "#4a5b7a", letterSpacing: 0.5, flexShrink: 0,
      }}>
        cosmos-web v{COSMOS_WEB_VERSION}
        {" · "}
        bridge v{COSMOS_BRIDGE_VERSION}
        {" · "}
        <a
          href="https://github.com/spacemig/cosmosv5-web"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#5f7396", textDecoration: "none" }}
        >
          github.com/spacemig/cosmosv5-web
        </a>
      </div>
    </div>
  );
}
