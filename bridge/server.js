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
// 3. WebSocket server — re-emit each telemetry packet to browser clients
// ---------------------------------------------------------------------------
const wss = new WebSocket.Server({ port: CONFIG.WS_PORT });
let clientCount = 0;

wss.on("connection", (ws) => {
  clientCount++;
  console.log(`[cosmos-engine-bridge] client connected (${clientCount} total)`);
  ws.on("close", () => {
    clientCount--;
    console.log(`[cosmos-engine-bridge] client disconnected (${clientCount} total)`);
  });
});

console.log(`[cosmos-engine-bridge] WebSocket server on ws://0.0.0.0:${CONFIG.WS_PORT}`);
console.log(`[cosmos-engine-bridge] point the cosmos-web "Live bridge" field at ws://<this-host>:${CONFIG.WS_PORT}`);

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
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
