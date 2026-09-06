# Cosmos Web

A browser-based visualization tool for the [COSMOS](https://github.com/hsfl/cosmosv5) mission
operations framework. Cosmos Web renders live or simulated satellite orbits in an interactive
3D globe, and (planned) surfaces which COSMOS agents are currently connected on the network.

This is the successor to `hsfl/cosmos-web` (the earlier Grafana-based telemetry dashboard, now
archived). For now this repo lives at
[`spacemig/cosmos-web`](https://github.com/spacemig/cosmos-web) as a private working repo before
it moves under the `hsfl` org.

The companion backend service — the UDP↔WebSocket bridge that connects this frontend to live
COSMOS agents — is a separate repo, **`cosmos-engine`** (not yet created).

## Status

- ✅ 3D orbit viewer (`CosmosOrbitViewer.jsx`) — client-side Keplerian propagator for standalone
  use, with a WebSocket hook for live telemetry
- ⏳ `cosmos-engine` bridge service — not yet built. Required to drive the viewer from a real
  `propagatorv3` process instead of the simulated orbit
- ⏳ Agent-discovery panel — not yet built. Will list live COSMOS agents by listening to the
  `225.1.1.1` heartbeat multicast group

## How it fits into COSMOS

[`propagatorv3`](https://github.com/hsfl/cosmosv5-agent/blob/main/programs/general/propagatorv3.cpp)
(part of `cosmosv5-agent`) already has a `cosmos_web_addr` output mode designed for a consumer
like this tool: it streams each simulated node's ECI position/velocity and ICRF attitude as JSON
over UDP on port `10096` every simulation timestep. Cosmos Engine's orbit viewer is built to
consume that exact JSON shape:

```json
{
  "node": "hiakasat",
  "utc": 60107.512345,
  "icrfatt": { "w": 0.0, "x": 0.0, "y": 0.0, "z": 1.0 },
  "ecipos":  { "x": 0.0, "y": 0.0, "z": 0.0 },
  "lvlhatt": { "...": "..." },
  "lvlhpos": { "...": "..." }
}
```

`ecipos` is in meters (standard COSMOS/SI convention); the viewer converts to kilometers
internally. Until `cosmos-engine` exists, the viewer runs a two-body Keplerian propagator
client-side so it's usable without a live agent.

```
┌────────────────┐      UDP :10096       ┌───────────────────┐      WebSocket      ┌──────────────────────┐
│  propagatorv3   │ ───────────────────▶ │  cosmos-engine      │ ──────────────────▶ │  cosmos-web (this repo)│
│  (cosmosv5-agent│   telegraf channel    │  (Node.js, TBD)     │                     │  browser client       │
└────────────────┘                       └───────────────────┘                     └──────────────────────┘
                                                    ▲
                                          UDP :225.1.1.1 (multicast)
                                          agent heartbeats — TBD panel
```

## Prerequisites

- Node.js 20 LTS
- A modern browser with WebGL support

## Quick start (local development)

```bash
git clone https://github.com/spacemig/cosmos-web.git
cd cosmos-web
npm install
npm run dev
```

Open the printed `localhost` URL. The globe renders immediately in simulated mode — drag to
rotate, scroll to zoom, and use the on-screen sliders to change orbital elements (perigee/apogee
altitude, inclination, RAAN, argument of periapsis).

## Production build

```bash
npm run build
```

Outputs a static bundle to `dist/`. No server-side runtime is required — everything (3D scene,
orbit propagation) runs client-side.

## Deploying to a Raspberry Pi 4

```bash
# OS + prerequisites
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y curl git build-essential

# Node.js 20 LTS (arm64)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Clone, install, build
git clone https://github.com/spacemig/cosmos-web.git
cd cosmos-web
npm install
npm run build

# Serve the static bundle
npm install -g serve
serve -s dist -l 3000
```

Visit `http://<pi-ip>:3000` from any browser on the same network — rendering happens in the
viewing browser, not on the Pi.

To keep it running across reboots, install as a systemd service:

```bash
sudo tee /etc/systemd/system/cosmos-web.service > /dev/null <<'EOF'
[Unit]
Description=Cosmos Web orbit viewer
After=network.target

[Service]
ExecStart=/usr/bin/serve -s /home/pi/cosmos-web/dist -l 3000
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now cosmos-web
```

If a 2GB Pi runs out of memory during `npm run build`, increase swap first:

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

## Connecting to live telemetry

Point the "Live bridge" field in the UI at a WebSocket URL that re-emits the JSON shape above
(one message per node per timestep). The viewer switches from `SIMULATED` to `LIVE` on connect
and drives the satellite marker from real position updates instead of the built-in propagator.

The bridge service (`cosmos-engine` — listening on `propagatorv3`'s UDP telegraf port and
re-broadcasting to WebSocket clients) is a separate repo and not yet built — see Roadmap.

## Roadmap

- [ ] Create `cosmos-engine`: Node.js bridge, UDP `:10096` (telegraf) → WebSocket
- [ ] `cosmos-engine`: UDP `:225.1.1.1` (agent heartbeat multicast) → REST/WebSocket, for
      an agent-discovery panel in this app (name, node, IP, last-heartbeat age, CPU/memory)
- [ ] Multi-node support (render more than one satellite at once)
- [ ] Ground station / target markers, using the `target` metadata `propagatorv3` posts on its
      API channel (UDP `:10097`)
- [ ] Move this repo from `spacemig/cosmos-web` to `hsfl/cosmos-web` once the legacy
      Grafana-based `hsfl/cosmos-web` is archived (see Naming below)

## Naming

The original `hsfl/cosmos-web` (TypeScript, Grafana-based telemetry dashboard) is being replaced
by this project. Plan: archive/rename the legacy repo (e.g. to `hsfl/cosmos-web-legacy`) first —
GitHub redirects the old URL automatically — then rename this repo into the freed-up
`hsfl/cosmos-web` slot. Until that happens, this stays at `spacemig/cosmos-web` as a private
working repo. Any telemetry/Grafana capability the legacy dashboard provided that isn't covered
here yet should be accounted for before the legacy repo is fully retired.

## Related repositories

- [`hsfl/cosmosv5`](https://github.com/hsfl/cosmosv5) — workspace repo, all layers
- [`hsfl/cosmosv5-agent`](https://github.com/hsfl/cosmosv5-agent) — `propagatorv3` source
- `hsfl/cosmos-web` — legacy Grafana-based telemetry dashboard, being replaced by this repo

## License

TBD
