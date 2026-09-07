/**
 * cosmos-web bridge
 * ----------------------------------------------------------------------------
 * Spawns propagatorv3, listens for the UDP broadcast telemetry it emits when
 * run with "postevent":1 (CLIENT_PORT_OUT = 10031, see cosmosv5-agent's
 * libraries/physics/simulatorclass.h and programs/general/propagatorv3.cpp),
 * and re-broadcasts each parsed JSON packet to every connected WebSocket
 * client. Point the "Live bridge" field in the cosmos-web UI at this
 * service's ws:// address to switch the orbit viewer from SIMULATED to LIVE.
 *
 * This is meant to eventually move into its own `cosmos-engine` repo (see
 * README Roadmap) — it lives here for now to get live data flowing quickly.
 *
 * Usage:
 *   node bridge/server.js
 *
 * Configure via environment variables (see the CONFIG block below) or by
 * editing the defaults directly. You will almost certainly need to change
 * SATFILE to point at your node's real satellite init file — propagatorv3
 * has no usable default and will fail to start without one.
 */

const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const satellite = require("satellite.js");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");

// ---------------------------------------------------------------------------
// CONFIG — override any of these with env vars, e.g.
//   SATFILE=/home/pi/cosmos/nodes/hiakasat/hiakasat.ini node bridge/server.js
// ---------------------------------------------------------------------------
const CONFIG = {
  PROPAGATOR_BIN: process.env.PROPAGATOR_BIN || path.join(os.homedir(), "cosmos/bin/propagatorv3"),
  SATFILE: process.env.SATFILE || "",            // REQUIRED — path to your node's sat init file
  ORBITFILE: process.env.ORBITFILE || "",        // optional
  REALMNAME: process.env.REALMNAME || "propagate",
  SIMDT: Number(process.env.SIMDT || 1),
  RUNCOUNT: Number(process.env.RUNCOUNT || 1e9), // effectively "run until stopped"
  UDP_PORT: Number(process.env.UDP_PORT || 10031),
  WS_PORT: Number(process.env.WS_PORT || 8080),
  TLEFILE: process.env.TLEFILE || "tle.dat", // used only for the UTC drift correction below

  // Realm / node file API (served on the same port as the WebSocket).
  COSMOS_ROOT: process.env.COSMOS_ROOT || path.join(os.homedir(), "cosmos"),
  FS_API: process.env.FS_API !== "0",              // set FS_API=0 to disable the file API entirely
  FS_API_WRITE: process.env.FS_API_WRITE !== "0",  // set FS_API_WRITE=0 for read-only
  FS_MAX_READ_BYTES: Number(process.env.FS_MAX_READ_BYTES || 512 * 1024),
};

if (!CONFIG.SATFILE) {
  console.error(
    "\n[cosmos-engine-bridge] SATFILE is not set. propagatorv3 needs a real satellite\n" +
    "init file to start. Set it via:\n\n" +
    "  SATFILE=/path/to/your/node/satfile node bridge/server.js\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// UTC drift correction
// ---------------------------------------------------------------------------
// propagatorv3 anchors its internal clock to the TLE's own epoch timestamp
// and then ticks forward in lockstep with real elapsed time (when
// "realtime":1) — it does NOT sync to actual current UTC. A control-JSON
// "initialutc" override exists in principle but isn't wired through to the
// simulator in this build, so it's a no-op. Since a TLE's epoch is usually a
// few hours old by the time you fetch it, the reported time will otherwise
// permanently lag "now" by that same gap. We correct for this here, once, at
// startup, rather than touching the C++ binary.
function nowAsMjd() {
  return Date.now() / 86400000 + 40587;
}

function parseTleEpochMjd(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const line1 = lines.find((l) => l.trim().startsWith("1 "));
  if (!line1) return null;
  const yy = parseInt(line1.slice(18, 20), 10);
  const dayFrac = parseFloat(line1.slice(20, 32));
  if (Number.isNaN(yy) || Number.isNaN(dayFrac)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const jan1Mjd = Date.UTC(year, 0, 1) / 86400000 + 40587;
  return jan1Mjd + (dayFrac - 1);
}

let utcCorrectionDays = 0;
try {
  const tleDatPath = path.join(os.homedir(), "cosmos/realms", CONFIG.REALMNAME, CONFIG.TLEFILE);
  const epochMjd = parseTleEpochMjd(tleDatPath);
  if (epochMjd != null) {
    utcCorrectionDays = nowAsMjd() - epochMjd;
    console.log(
      `[cosmos-engine-bridge] TLE epoch is ${(utcCorrectionDays * 24).toFixed(2)}h old — ` +
      `correcting all relayed timestamps by that amount`
    );
  } else {
    console.warn(`[cosmos-engine-bridge] could not find a Line 1 in ${tleDatPath} — UTC will show TLE epoch time, uncorrected`);
  }
} catch (e) {
  console.warn(`[cosmos-engine-bridge] could not read TLE file for UTC correction: ${e.message}`);
}


// ---------------------------------------------------------------------------
// 2. Spawn propagatorv3 with postevent enabled so it broadcasts telemetry
// ---------------------------------------------------------------------------
const controlArgs = {
  postevent: 1,
  realtime: 1,
  simdt: CONFIG.SIMDT,
  runcount: CONFIG.RUNCOUNT,
  satfile: CONFIG.SATFILE,
  realmname: CONFIG.REALMNAME,
};
if (CONFIG.ORBITFILE) controlArgs.orbitfile = CONFIG.ORBITFILE;

console.log(`[cosmos-engine-bridge] launching: ${CONFIG.PROPAGATOR_BIN} '${JSON.stringify(controlArgs)}'`);

const propagator = spawn(CONFIG.PROPAGATOR_BIN, [JSON.stringify(controlArgs)], {
  stdio: ["ignore", "pipe", "pipe"],
});

propagator.stdout.on("data", (d) => process.stdout.write(`[propagatorv3] ${d}`));
propagator.stderr.on("data", (d) => process.stderr.write(`[propagatorv3:err] ${d}`));
propagator.on("exit", (code, signal) => {
  console.error(`[cosmos-engine-bridge] propagatorv3 exited (code=${code}, signal=${signal})`);
});
propagator.on("error", (err) => {
  console.error(`[cosmos-engine-bridge] failed to launch propagatorv3: ${err.message}`);
  console.error(`  Checked path: ${CONFIG.PROPAGATOR_BIN} — set PROPAGATOR_BIN if it's installed elsewhere.`);
});

// ---------------------------------------------------------------------------
// 2. Listen for propagatorv3's UDP broadcast telemetry (postevent output)
// ---------------------------------------------------------------------------
const udpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });

udpSocket.on("listening", () => {
  udpSocket.setBroadcast(true);
  const addr = udpSocket.address();
  console.log(`[cosmos-engine-bridge] listening for propagatorv3 telemetry on UDP ${addr.address}:${addr.port}`);
});

udpSocket.on("message", (msg) => {
  let parsed;
  try {
    parsed = JSON.parse(msg.toString());
  } catch (e) {
    return; // ignore anything that isn't a clean JSON packet
  }
  // propagatorv3's postevent packets look like:
  //   { "mtype":"soh", "utc":<mjd>, "node":"...", "ecipos"|"scipos": {x,y,z}, "alphaatt": {...}, ... }
  if (parsed.mtype !== "soh") return;

  // Once the real-time SGP4 ticker is running, it's the source of truth for
  // position — relaying propagatorv3's own broadcasts too would make the
  // frontend flicker between the accurate and lagging positions each second.
  if (sgp4Ticker) return;

  broadcastToClients(parsed);
});

udpSocket.on("error", (err) => {
  console.error(`[cosmos-engine-bridge] UDP socket error: ${err.message}`);
});

udpSocket.bind(CONFIG.UDP_PORT, "0.0.0.0");

// ---------------------------------------------------------------------------
// 3. HTTP + WebSocket server (one port)
// ---------------------------------------------------------------------------
// ws:// upgrades carry telemetry as before. In addition, a small read/write
// filesystem API under /api/ lets the cosmos-web Mission Configurator browse
// and edit realm / node config files. Only two roots are ever exposed
// (~/cosmos/realms and ~/cosmos/nodes) and path traversal outside them is
// refused. Disable with FS_API=0, or make it read-only with FS_API_WRITE=0.

const FS_ROOTS = {
  realms: path.join(CONFIG.COSMOS_ROOT, "realms"),
  nodes: path.join(CONFIG.COSMOS_ROOT, "nodes"),
};

function sendJson(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

// Resolve (rootKey, relPath) to an absolute path, refusing anything that
// escapes the root directory.
function resolveSafe(rootKey, relPath) {
  const rootDir = FS_ROOTS[rootKey];
  if (!rootDir) return null;
  const abs = path.resolve(rootDir, "." + path.sep + (relPath || "").replace(/^[/\\]+/, ""));
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) return null;
  return { rootDir, abs };
}

// Bounded recursive directory listing: [{ path, type, size? }, ...].
function listTree(dir, base = "", depth = 0, out = [], limit = 5000) {
  if (depth > 8 || out.length >= limit) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
  );
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push({ path: rel, type: "dir" });
      listTree(path.join(dir, ent.name), rel, depth + 1, out, limit);
    } else if (ent.isFile()) {
      let size = 0;
      try { size = fs.statSync(path.join(dir, ent.name)).size; } catch (e) { /* ignore */ }
      out.push({ path: rel, type: "file", size });
    }
  }
  return out;
}

function handleApi(req, res) {
  if (req.method === "OPTIONS") { sendJson(res, 204, {}); return; }

  const u = new URL(req.url, "http://localhost");
  const route = u.pathname;

  if (route === "/api/health") {
    sendJson(res, 200, { ok: true, roots: FS_ROOTS, write: CONFIG.FS_API_WRITE, maxReadBytes: CONFIG.FS_MAX_READ_BYTES });
    return;
  }

  if (route === "/api/tree") {
    const rootKey = u.searchParams.get("root");
    const r = resolveSafe(rootKey, "");
    if (!r) { sendJson(res, 400, { error: "unknown root (use realms|nodes)" }); return; }
    const exists = fs.existsSync(r.rootDir);
    sendJson(res, 200, { root: rootKey, dir: r.rootDir, exists, entries: exists ? listTree(r.rootDir) : [] });
    return;
  }

  if (route === "/api/file") {
    const rootKey = u.searchParams.get("root");
    const rel = u.searchParams.get("path") || "";
    const r = resolveSafe(rootKey, rel);
    if (!r) { sendJson(res, 400, { error: "bad root or path" }); return; }

    if (req.method === "GET") {
      let st;
      try { st = fs.statSync(r.abs); } catch (e) { sendJson(res, 404, { error: "not found" }); return; }
      if (!st.isFile()) { sendJson(res, 400, { error: "not a file" }); return; }
      if (st.size > CONFIG.FS_MAX_READ_BYTES) { sendJson(res, 413, { error: `file too large (${st.size} bytes)` }); return; }
      let content;
      try { content = fs.readFileSync(r.abs, "utf8"); } catch (e) { sendJson(res, 500, { error: e.message }); return; }
      sendJson(res, 200, { root: rootKey, path: rel, size: st.size, mtimeMs: st.mtimeMs, content });
      return;
    }

    if (req.method === "PUT") {
      if (!CONFIG.FS_API_WRITE) { sendJson(res, 403, { error: "writes disabled (FS_API_WRITE=0)" }); return; }
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c) => { raw += c; if (raw.length > 4 * 1024 * 1024) req.destroy(); });
      req.on("end", () => {
        let content;
        try { content = JSON.parse(raw).content; } catch (e) { sendJson(res, 400, { error: "body must be JSON {\"content\": \"...\"}" }); return; }
        if (typeof content !== "string") { sendJson(res, 400, { error: "content must be a string" }); return; }
        try {
          fs.mkdirSync(path.dirname(r.abs), { recursive: true });
          fs.writeFileSync(r.abs, content, "utf8");
        } catch (e) { sendJson(res, 500, { error: e.message }); return; }
        console.log(`[cosmos-engine-bridge] wrote ${r.abs} (${content.length} bytes)`);
        sendJson(res, 200, { ok: true, root: rootKey, path: rel, bytes: content.length });
      });
      return;
    }

    sendJson(res, 405, { error: "GET or PUT" });
    return;
  }

  sendJson(res, 404, { error: "no such route" });
}

const httpServer = http.createServer((req, res) => {
  if (CONFIG.FS_API && req.url && req.url.startsWith("/api/")) { handleApi(req, res); return; }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(
    "cosmos-engine-bridge\n" +
    "  ws://<host>:" + CONFIG.WS_PORT + "   telemetry stream\n" +
    (CONFIG.FS_API ? "  GET/PUT /api/{health,tree,file}   realm/node file API\n" : "")
  );
});

const wss = new WebSocket.Server({ server: httpServer });
let clientCount = 0;

wss.on("connection", (ws) => {
  clientCount++;
  console.log(`[cosmos-engine-bridge] client connected (${clientCount} total)`);
  ws.on("close", () => {
    clientCount--;
    console.log(`[cosmos-engine-bridge] client disconnected (${clientCount} total)`);
  });
});

httpServer.listen(CONFIG.WS_PORT, "0.0.0.0", () => {
  console.log(`[cosmos-engine-bridge] WebSocket server on ws://0.0.0.0:${CONFIG.WS_PORT}`);
  if (CONFIG.FS_API) {
    console.log(
      `[cosmos-engine-bridge] realm/node file API on http://0.0.0.0:${CONFIG.WS_PORT}/api/  ` +
      `(roots: ${FS_ROOTS.realms}, ${FS_ROOTS.nodes}; writes ${CONFIG.FS_API_WRITE ? "enabled" : "disabled"})`
    );
  }
  console.log(`[cosmos-engine-bridge] point the cosmos-web "Live bridge" field at ws://<this-host>:${CONFIG.WS_PORT}`);
});

function broadcastToClients(payload) {
  // Normalize scipos -> ecipos so the frontend doesn't need to know which
  // frame propagatorv3 chose for a given timestep (it switches near the Moon).
  const out = { ...payload };
  if (out.scipos && !out.ecipos) out.ecipos = out.scipos;
  if (typeof out.utc === "number") out.utc += utcCorrectionDays;

  const data = JSON.stringify(out);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

// ---------------------------------------------------------------------------
// Real-time SGP4 ticker (bypasses propagatorv3's clock-lag limitation)
// ---------------------------------------------------------------------------
// propagatorv3's own postevent broadcasts are anchored to the TLE's epoch and
// tick forward with elapsed process time — accurate in *shape* (SGP4 math is
// correct) but permanently offset in *time* by however old the TLE was when
// the bridge started (see the UTC drift correction above, which only fixes
// the displayed clock text, not the actual computed position). Rather than
// let that lag compound over a long-running session, this ticker computes
// the satellite's position fresh against the real current time on every
// tick, using satellite.js directly on the same TLE file. This is what
// actually drives the frontend's satellite marker.
let sgp4Ticker = null;
try {
  const tleDatPath = path.join(os.homedir(), "cosmos/realms", CONFIG.REALMNAME, CONFIG.TLEFILE);
  const tleLines = fs.readFileSync(tleDatPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const line1 = tleLines.find((l) => l.startsWith("1 "));
  const line2 = tleLines.find((l) => l.startsWith("2 "));
  const nameLine = tleLines.find((l) => !l.startsWith("1 ") && !l.startsWith("2 "));

  if (line1 && line2) {
    const satrec = satellite.twoline2satrec(line1, line2);
    console.log(`[cosmos-engine-bridge] real-time SGP4 ticker started for ${nameLine || "(unnamed)"}`);
    // The ticker computes true current time directly (Date.now()), so the
    // TLE-epoch drift correction above (meant for propagatorv3's own lagging
    // broadcasts, which are now suppressed below) would otherwise
    // double-adjust an already-correct timestamp.
    utcCorrectionDays = 0;

    sgp4Ticker = setInterval(() => {
      const now = new Date();
      const pv = satellite.propagate(satrec, now);
      if (!pv.position || !pv.velocity) return; // satellite.js returns false on propagation error (e.g. decayed orbit)

      const mjdNow = nowAsMjd();
      broadcastToClients({
        mtype: "soh",
        utc: mjdNow,
        node: nameLine ? nameLine.trim() : CONFIG.REALMNAME,
        ecipos: {
          utc: mjdNow,
          s: { col: [pv.position.x * 1000, pv.position.y * 1000, pv.position.z * 1000] }, // km -> m
          v: { col: [pv.velocity.x * 1000, pv.velocity.y * 1000, pv.velocity.z * 1000] },
        },
      });
    }, 1000);
  } else {
    console.warn(`[cosmos-engine-bridge] no valid TLE lines found in ${tleDatPath} — real-time ticker not started, falling back to propagatorv3's own (potentially lagging) broadcasts`);
  }
} catch (e) {
  console.warn(`[cosmos-engine-bridge] could not start real-time SGP4 ticker: ${e.message} — falling back to propagatorv3's own broadcasts`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown() {
  console.log("\n[cosmos-engine-bridge] shutting down...");
  if (sgp4Ticker) clearInterval(sgp4Ticker);
  propagator.kill("SIGTERM");
  udpSocket.close();
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
