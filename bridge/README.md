# cosmos-engine-bridge (prototype)

Spawns `propagatorv3`, listens for its UDP broadcast telemetry on port `10031`, and re-emits it
to any connected WebSocket client. This is the "Live bridge" backend for the `cosmos-web` orbit
viewer.

This folder is a working prototype of what will become the standalone `cosmos-engine` repo (see
the main [README](../README.md#roadmap)) — kept here for now so live data can flow without
splitting repos yet.

## Prerequisites (critical, easy to miss)

`propagatorv3` needs `~/cosmos/resources/` to exist and be populated — specifically Earth
orientation data, JPL ephemeris, and (most importantly for orbit visualization) the EGM2008
gravity model coefficients. **Without this, `propagatorv3` does not error — it silently runs with
zero gravitational acceleration**, producing a straight-line "orbit" (constant velocity, zero
curvature) instead of a real one. This is genuinely easy to miss since nothing crashes.

If `~/cosmos/resources/` doesn't exist:

```bash
git clone https://github.com/hsfl/cosmos-resources.git ~/cosmos/resources
```

Sanity check after cloning:

```bash
ls ~/cosmos/resources/general/ | grep egm2008   # should show egm2008_coef.txt
```

If you ever see `eciax`/`eciay`/`eciaz` printed as flat `0.000` and velocity frozen across
timesteps when running `propagatorv3` directly with `printevent:1`, check this first before
suspecting `orbit.dat`/`sats.dat` config.

## Setup

```bash
cd bridge
npm install
```

You **must** set `SATFILE` to a real satellite init file for your node — `propagatorv3` has no
usable default and will exit immediately without one:

```bash
SATFILE=/home/pi/cosmos/nodes/<your-node>/<your-node>.ini node server.js
```

Other environment variables, all optional:

| Variable          | Default                        | Purpose                                      |
| ----------------- | ------------------------------- | --------------------------------------------- |
| `PROPAGATOR_BIN`  | `~/cosmos/bin/propagatorv3`      | Path to the propagatorv3 executable           |
| `ORBITFILE`       | *(none)*                        | Optional orbit file argument                  |
| `REALMNAME`       | `propagate`                     | COSMOS realm name                             |
| `SIMDT`           | `1`                             | Simulation timestep, seconds                  |
| `RUNCOUNT`        | effectively unlimited            | How many timesteps before propagatorv3 stops  |
| `UDP_PORT`        | `10031`                         | `CLIENT_PORT_OUT` — propagatorv3's broadcast port |
| `WS_PORT`         | `8080`                          | WebSocket port the frontend connects to        |

## Running

```bash
SATFILE=/home/pi/cosmos/nodes/hiakasat/hiakasat.ini npm start
```

You should see:

```
[cosmos-engine-bridge] launching: /home/pi/cosmos/bin/propagatorv3 '{"postevent":1,...}'
[cosmos-engine-bridge] listening for propagatorv3 telemetry on UDP 0.0.0.0:10031
[cosmos-engine-bridge] WebSocket server on ws://0.0.0.0:8080
```

Then in the cosmos-web UI, set the "Live bridge" field to `ws://<host>:8080` and hit Connect.
The status indicator should switch from `SIMULATED` to `LIVE`.

## UTC accuracy

`propagatorv3` anchors its internal clock to the TLE's own epoch timestamp, not to actual current
UTC — it just ticks forward in real-time pace from whenever the TLE says it was generated. Since a
downloaded TLE is often several hours old, the reported time can otherwise permanently lag behind
"now" by that same gap. The bridge corrects for this once at startup: it reads the TLE file's own
epoch (from `TLEFILE`, default `tle.dat`, resolved the same way as `SATFILE`/`ORBITFILE` — inside
`~/cosmos/realms/<REALMNAME>/`), compares it to the real current time, and applies that offset to
every relayed packet's `utc` field. Look for a line like:

```
[cosmos-engine-bridge] TLE epoch is 6.42h old — correcting all relayed timestamps by that amount
```

in the bridge's log output at startup. If that line is missing or warns that it couldn't find the
TLE file, timestamps will show raw (uncorrected) TLE-epoch time instead of real current UTC.

## Troubleshooting

- **Satellite doesn't move, or moves in a perfectly straight line / ECI numbers frozen or all
  zero** — almost always the missing `~/cosmos/resources/` directory described above, not a bug
  in this bridge or the frontend. Confirm with a direct `printevent:1` test (see Prerequisites)
  before debugging anything else.

- **propagatorv3 exits immediately** — almost always a bad `SATFILE` path, or a missing
  `orbitfile`/support data file it expects relative to the working directory. Check the
  `[propagatorv3]`-prefixed stdout/stderr this script prints for the actual error.
- **No UDP packets arrive** — confirm the bridge and propagatorv3 are on the same host or the
  same broadcast domain (port 10031 is a plain UDP broadcast, not multicast, so it won't cross
  subnets/VLANs without a relay).
- **WebSocket connects but no telemetry updates** — check that `postevent` actually made it into
  the spawned command (see the `launching:` log line) and that `mtype` in the raw UDP payload is
  `"soh"` — the bridge silently drops anything else.
