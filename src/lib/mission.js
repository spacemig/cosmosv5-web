/**
 * Mission Configurator constants: on-disk COSMOS layout, the tab list, the
 * illustrative example missions, and the realm/node config-file templates.
 */

export const COSMOS_WEB_VERSION = "0.3.0";
// Bridge/server version this build targets — keep in sync with bridge/package.json.
export const COSMOS_BRIDGE_VERSION = "0.2.0";

// COSMOS on-disk layout (see bridge/README.md).
export const COSMOS_REALMS_DIR = "~/cosmos/realms/";
export const COSMOS_NODES_DIR = "~/cosmos/nodes/";

export const VIEW_TABS = [
  { id: "mission", label: "Mission Configurator" },
  { id: "3d", label: "3D Orbit" },
  { id: "2d", label: "2D Orbit" },
  { id: "satellite", label: "Satellite 3D" },
  { id: "telemetry", label: "Telemetry" },
  { id: "groundstations", label: "Ground Stations" },
  { id: "game", label: "Space Game" },
];

// Illustrative realm → node structures shown as a layered diagram. Layers:
// satellites (top), ground stations, MOCs; connections run between adjacent
// layers (MOC ↔ GS ↔ satellite).
export const EXAMPLE_REALMS = [
  {
    realm: "HiTechSat-1 Mission",
    layers: [
      { kind: "Satellite", nodes: ["HTS-1 Satellite"] },
      { kind: "Ground Station", nodes: ["HSFL-HIG Ground Station"] },
      { kind: "MOC", nodes: ["HSFL MOC"] },
    ],
  },
  {
    realm: "ACMES Mission",
    layers: [
      { kind: "Satellite", nodes: ["ACMES Satellite"] },
      { kind: "Ground Station", nodes: ["KSAT Ground Station 1", "KSAT Ground Station 2"] },
      { kind: "MOC", nodes: ["ACMES MOC at USU", "ACMES MOC at HSFL"] },
    ],
  },
];

export function realmIniTemplate(realmName, nodes) {
  return [
    `# ${COSMOS_REALMS_DIR}${realmName}/realm.ini`,
    `realm_name = ${realmName}`,
    "",
    "# nodes participating in this realm",
    ...(nodes.length ? nodes.map((n) => `node = ${n}`) : ["node ="]),
    "",
    "# shared configuration",
    "timestep_sec = 1",
    "propagator = propagatorv3",
    "",
  ].join("\n");
}

export function nodeIniTemplate(nodeName, gs) {
  const type = /sat/i.test(nodeName) ? "satellite"
    : /ground|(\bgs\b)|station/i.test(nodeName) ? "ground_station"
    : /moc|control|operations/i.test(nodeName) ? "operations_center"
    : "generic";
  const lines = [
    `# ${COSMOS_NODES_DIR}${nodeName}/${nodeName}.ini`,
    `node_name = ${nodeName}`,
    `node_type = ${type}`,
  ];
  if (type === "ground_station") {
    lines.push(
      `latitude_deg = ${gs ? gs.lat : 0}`,
      `longitude_deg = ${gs ? gs.lon : 0}`,
      `altitude_km = ${gs ? gs.alt : 0}`,
    );
  }
  lines.push("", `agent = agent_${nodeName.replace(/\s+/g, "_").toLowerCase()}`, "");
  return lines.join("\n");
}
