import React, { useEffect, useState } from "react";
import RealmDiagram from "../components/RealmDiagram.jsx";
import { btnStyle } from "../lib/ui.js";
import {
  COSMOS_REALMS_DIR, COSMOS_NODES_DIR, EXAMPLE_REALMS,
  realmIniTemplate, nodeIniTemplate,
} from "../lib/mission.js";

/**
 * Mission Configurator page: the COSMOS server connector, realm scope, its node
 * list, the realm/node config editors, and a browser for the server's realm /
 * node files. Realm/node identity state lives in the parent (the header shows
 * it, telemetry auto-registers nodes); the config-file + server state is local
 * to this view.
 */
export default function MissionConfigurator({
  realm, setRealm, realms, setRealms,
  nodesByRealm, setNodesByRealm,
  nodeName, setNodeName,
  groundStations, isMobile,
}) {
  const nodeList = nodesByRealm[realm] || [];

  // Config-file working copies (persisted to localStorage), seeded from a template.
  const [realmFiles, setRealmFiles] = useState(() => {
    try { return JSON.parse(localStorage.getItem("cosmos-web:realm-files")) || {}; } catch (e) { return {}; }
  });
  const [nodeFiles, setNodeFiles] = useState(() => {
    try { return JSON.parse(localStorage.getItem("cosmos-web:node-files")) || {}; } catch (e) { return {}; }
  });
  useEffect(() => { try { localStorage.setItem("cosmos-web:realm-files", JSON.stringify(realmFiles)); } catch (e) { /* private mode */ } }, [realmFiles]);
  useEffect(() => { try { localStorage.setItem("cosmos-web:node-files", JSON.stringify(nodeFiles)); } catch (e) { /* private mode */ } }, [nodeFiles]);

  // Bridge filesystem API (bridge/server.js /api/…).
  const [bridgeApiUrl, setBridgeApiUrl] = useState(() => {
    try { return localStorage.getItem("cosmos-web:bridge-api") || `http://${location.hostname || "localhost"}:8080`; }
    catch (e) { return "http://localhost:8080"; }
  });
  useEffect(() => { try { localStorage.setItem("cosmos-web:bridge-api", bridgeApiUrl); } catch (e) { /* */ } }, [bridgeApiUrl]);
  const [bridgeStatus, setBridgeStatus] = useState({ state: "idle", msg: "" }); // idle|checking|ok|error
  const [bridgeTree, setBridgeTree] = useState({ realms: null, nodes: null });
  const [bridgeFile, setBridgeFile] = useState(null); // { root, path, dir, content }
  // Names of the realms / nodes that exist on the bridge host.
  const [remoteRealms, setRemoteRealms] = useState([]);
  const [remoteNodes, setRemoteNodes] = useState([]);

  const bridgeApi = (p, opts) => fetch(`${bridgeApiUrl.replace(/\/$/, "")}${p}`, opts).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  });

  // Top-level directory names in a /api/tree listing = realm / node names.
  const topDirs = (tree) =>
    !tree || !tree.entries ? [] : tree.entries.filter((e) => e.type === "dir" && !e.path.includes("/")).map((e) => e.path);

  const bridgeConnect = async () => {
    setBridgeStatus({ state: "checking", msg: "" });
    try {
      const h = await bridgeApi("/api/health");
      const [rt, nt] = await Promise.all([
        bridgeApi("/api/tree?root=realms").catch(() => ({ exists: false, entries: [] })),
        bridgeApi("/api/tree?root=nodes").catch(() => ({ exists: false, entries: [] })),
      ]);
      setBridgeTree({ realms: rt, nodes: nt });

      const rRealms = topDirs(rt), rNodes = topDirs(nt);
      setRemoteRealms(rRealms);
      setRemoteNodes(rNodes);
      // Merge the server's realms/nodes into the selectable lists so they can
      // actually be picked (and drive the header + the config editors).
      if (rRealms.length) {
        setRealms((prev) => Array.from(new Set([...prev, ...rRealms])));
        setNodesByRealm((m) => {
          const next = { ...m };
          for (const r of rRealms) if (!next[r]) next[r] = [...rNodes];
          return next;
        });
      }
      setBridgeStatus({
        state: "ok",
        msg: `${rRealms.length} realm(s), ${rNodes.length} node(s) on ${h.roots.realms.replace(/\/realms\/?$/, "")}`,
      });
    } catch (e) {
      setBridgeTree({ realms: null, nodes: null });
      setRemoteRealms([]); setRemoteNodes([]);
      setBridgeStatus({ state: "error", msg: e.message });
    }
  };

  // Try once when the page opens, so the server lists are ready without a click.
  useEffect(() => {
    if (bridgeApiUrl) bridgeConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bridgeOpen = async (root, relPath, dir) => {
    try {
      const j = await bridgeApi(`/api/file?root=${root}&path=${encodeURIComponent(relPath)}`);
      setBridgeFile({ root, path: relPath, dir, content: j.content });
    } catch (e) {
      setBridgeStatus({ state: "error", msg: `open ${relPath}: ${e.message}` });
    }
  };

  const bridgeSave = async (root, relPath, content) => {
    const j = await bridgeApi(`/api/file?root=${root}&path=${encodeURIComponent(relPath)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    return j;
  };

  // One labelled picker section (realm or node). `remoteSet` marks items that
  // exist on the connected COSMOS server (badged SERVER); everything else is a
  // browser-local entry (badged LOCAL).
  const renderSelectorPanel = ({ heading, note, items, current, onSelect, onAdd, onRemove, addPlaceholder, remoteSet }) => (
    <>
      <div style={{ fontSize: 13, color: "#7d93b8", marginBottom: 6, fontFamily: "system-ui,sans-serif", letterSpacing: 0.5 }}>{heading}</div>
      <div style={{ fontSize: 11, color: "#5f7396", marginBottom: 16, fontFamily: "system-ui,sans-serif", lineHeight: 1.5 }}>{note}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item) => {
          const active = item === current;
          const onServer = remoteSet && remoteSet.has(item);
          return (
            <div key={item} style={{
              display: "flex", alignItems: "center", gap: 10,
              background: active ? "rgba(143,215,255,0.16)" : "rgba(9,14,28,0.5)",
              border: `1px solid ${active ? "rgba(143,215,255,0.5)" : "rgba(143,215,255,0.14)"}`,
              borderRadius: 8, padding: "10px 12px",
            }}>
              <button onClick={() => onSelect(item)} style={{
                flex: 1, textAlign: "left", background: "transparent", border: "none",
                color: active ? "#eaf3ff" : "#cfe6ff", fontSize: 13, cursor: "pointer",
                fontFamily: "'IBM Plex Mono',monospace",
              }}>
                {active ? "● " : "○ "}{item}
              </button>
              {remoteSet && (
                onServer
                  ? <span style={{ fontSize: 9, letterSpacing: 0.4, color: "#5eff9c", border: "1px solid rgba(94,255,156,0.4)", borderRadius: 999, padding: "2px 6px", whiteSpace: "nowrap" }}>SERVER</span>
                  : <span style={{ fontSize: 9, letterSpacing: 0.4, color: "#7d93b8", border: "1px solid rgba(143,215,255,0.25)", borderRadius: 999, padding: "2px 6px", whiteSpace: "nowrap" }}>LOCAL</span>
              )}
              {onRemove && items.length > 1 && (
                <button onClick={() => onRemove(item)} title="Remove" style={{
                  background: "transparent", border: "none", color: "#5f7396",
                  fontSize: 16, lineHeight: 1, cursor: "pointer", padding: "0 4px",
                }}>✕</button>
              )}
            </div>
          );
        })}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = e.target.elements.entry.value.trim();
          if (v) { onAdd(v); e.target.reset(); }
        }}
        style={{ display: "flex", gap: 8, marginTop: 14 }}
      >
        <input name="entry" placeholder={addPlaceholder} autoComplete="off" style={{
          flex: 1, background: "#0c1428", border: "1px solid rgba(143,215,255,0.25)",
          color: "#cfe6ff", borderRadius: 4, padding: "8px 10px", fontSize: 13,
        }} />
        <button type="submit" style={{ ...btnStyle, flex: "none", padding: "8px 16px" }}>Add</button>
      </form>
    </>
  );

  // A load-from-file / edit-as-text config editor. Pass bridgeRoot+bridgePath to
  // enable the load/save-to-server buttons.
  const renderConfigEditor = ({ title, path, value, onChange, onReset, bridgeRoot, bridgePath }) => {
    const b = { ...btnStyle, flex: "none", padding: "6px 12px" };
    return (
      <div style={{ marginTop: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 13, color: "#7d93b8", fontFamily: "system-ui,sans-serif", letterSpacing: 0.5 }}>{title}</span>
          <span style={{ fontSize: 10, color: "#5f7396", fontFamily: "'IBM Plex Mono',monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{path}</span>
        </div>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={10}
          style={{
            width: "100%", resize: "vertical", background: "#0c1428", border: "1px solid rgba(143,215,255,0.25)",
            color: "#cfe6ff", borderRadius: 4, padding: "8px 10px", fontSize: 12, lineHeight: 1.5,
            fontFamily: "'IBM Plex Mono',monospace",
          }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ ...b, cursor: "pointer" }}>
            Load file…
            <input
              type="file" accept=".ini,.cfg,.conf,.json,.txt,text/*" style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => onChange(String(reader.result));
                reader.readAsText(file);
                e.target.value = "";
              }}
            />
          </label>
          {onReset && <button onClick={onReset} style={b}>Reset to template</button>}
          {bridgeRoot && bridgePath && (
            <>
              <button
                onClick={() => bridgeApi(`/api/file?root=${bridgeRoot}&path=${encodeURIComponent(bridgePath)}`)
                  .then((j) => onChange(j.content))
                  .catch((err) => setBridgeStatus({ state: "error", msg: err.message }))}
                style={b}
              >↓ Load from server</button>
              <button
                onClick={() => bridgeSave(bridgeRoot, bridgePath, value)
                  .then((j) => setBridgeStatus({ state: "ok", msg: `saved ${j.path} (${j.bytes} B)` }))
                  .catch((err) => setBridgeStatus({ state: "error", msg: err.message }))}
                style={{ ...b, background: "rgba(94,255,156,0.16)", border: "1px solid rgba(94,255,156,0.45)", color: "#c9ffe0" }}
              >↑ Save to server</button>
            </>
          )}
          <span style={{ fontSize: 10, color: "#5f7396" }}>
            {bridgeRoot ? "load/save hits the cosmos server filesystem" : "working copy · saved in this browser"}
          </span>
        </div>
      </div>
    );
  };

  const renderBridgeTree = (rootKey, tree) => {
    if (!tree) return null;
    if (!tree.exists) return <div style={{ fontSize: 10, color: "#5f7396", fontFamily: "'IBM Plex Mono',monospace" }}>{tree.dir || rootKey} — not found on the cosmos server</div>;
    if (!tree.entries.length) return <div style={{ fontSize: 10, color: "#5f7396" }}>(empty)</div>;
    return (
      <div style={{ maxHeight: 190, overflow: "auto", border: "1px solid rgba(143,215,255,0.12)", borderRadius: 6, padding: "6px 8px", fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
        {tree.entries.map((ent) => {
          const depth = ent.path.split("/").length - 1;
          const name = ent.path.split("/").pop();
          if (ent.type === "dir") {
            return <div key={ent.path} style={{ padding: "2px 0", paddingLeft: depth * 14, color: "#8fa2c2" }}>{name}/</div>;
          }
          const isOpen = bridgeFile && bridgeFile.root === rootKey && bridgeFile.path === ent.path;
          return (
            <div
              key={ent.path}
              onClick={() => bridgeOpen(rootKey, ent.path, tree.dir)}
              style={{ padding: "2px 0", paddingLeft: depth * 14 + 12, cursor: "pointer", color: isOpen ? "#c9ffe0" : "#cfe6ff", display: "flex", justifyContent: "space-between", gap: 10 }}
            >
              <span>{isOpen ? "▸ " : ""}{name}</span>
              <span style={{ color: "#5f7396" }}>{ent.size} B</span>
            </div>
          );
        })}
      </div>
    );
  };

  // Top of the page: the COSMOS server connector — URL, Connect, status. Kept
  // separate from the file listing (which moves below the realm/node pickers).
  const renderServerConnector = () => (
    <div style={{ border: "1px solid rgba(143,215,255,0.14)", borderRadius: 8, padding: "12px 14px", marginBottom: 20, background: "rgba(9,14,28,0.4)" }}>
      <div style={{ fontSize: 12, color: "#7d93b8", fontFamily: "system-ui,sans-serif", letterSpacing: 0.5, marginBottom: 4 }}>COSMOS SERVER</div>
      <div style={{ fontSize: 10, color: "#5f7396", marginBottom: 8, lineHeight: 1.45 }}>
        Connect to a COSMOS server (bridge/server.js <code>/api/…</code>) to load its realms and nodes and edit their config files.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <input value={bridgeApiUrl} onChange={(e) => setBridgeApiUrl(e.target.value)} placeholder="http://<cosmos-server>:8080"
          style={{ flex: 1, minWidth: 180, background: "#0c1428", border: "1px solid rgba(143,215,255,0.25)", color: "#cfe6ff", borderRadius: 4, padding: "6px 8px", fontSize: 12, fontFamily: "'IBM Plex Mono',monospace" }} />
        <button onClick={bridgeConnect} style={{ ...btnStyle, flex: "none", padding: "6px 14px" }}>
          {bridgeStatus.state === "checking" ? "…" : "Connect"}
        </button>
      </div>
      {bridgeStatus.state !== "idle" && (
        <div style={{ fontSize: 10, color: bridgeStatus.state === "ok" ? "#5eff9c" : bridgeStatus.state === "error" ? "#ff6a6a" : "#8fa2c2" }}>
          {bridgeStatus.state === "ok" ? `● connected — ${bridgeStatus.msg}` : bridgeStatus.state === "error" ? `✕ ${bridgeStatus.msg}` : "checking…"}
        </div>
      )}
    </div>
  );

  // Placed after the realm / node selectors: the server's realm & node folders
  // with an inline editor for whichever file is open.
  const renderServerFiles = () => {
    if (bridgeStatus.state !== "ok") return null;
    return (
      <div style={{ border: "1px solid rgba(143,215,255,0.14)", borderRadius: 8, padding: "12px 14px", margin: "22px 0", background: "rgba(9,14,28,0.4)" }}>
        <div style={{ fontSize: 12, color: "#7d93b8", fontFamily: "system-ui,sans-serif", letterSpacing: 0.5, marginBottom: 8 }}>COSMOS SERVER FILES</div>
        <div style={{ fontSize: 10, letterSpacing: 0.5, color: "#5f7396", fontFamily: "system-ui,sans-serif", margin: "2px 0 4px" }}>{COSMOS_REALMS_DIR}</div>
        {renderBridgeTree("realms", bridgeTree.realms)}
        <div style={{ fontSize: 10, letterSpacing: 0.5, color: "#5f7396", fontFamily: "system-ui,sans-serif", margin: "10px 0 4px" }}>{COSMOS_NODES_DIR}</div>
        {renderBridgeTree("nodes", bridgeTree.nodes)}
        {bridgeFile && (
          <div style={{ marginTop: 10 }}>
            {renderConfigEditor({
              title: "OPEN FILE",
              path: `${bridgeFile.dir}/${bridgeFile.path}`,
              value: bridgeFile.content,
              onChange: (v) => setBridgeFile((bf) => ({ ...bf, content: v })),
              bridgeRoot: bridgeFile.root,
              bridgePath: bridgeFile.path,
            })}
          </div>
        )}
      </div>
    );
  };

  const realmText = realmFiles[realm] ?? realmIniTemplate(realm, nodeList);
  const activeGs = groundStations.find((g) => nodeName && (g.name === nodeName || nodeName.includes(g.name)));
  const nodeText = nodeFiles[nodeName] ?? nodeIniTemplate(nodeName || "node", activeGs);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: isMobile ? "20px 12px" : "32px 22px", WebkitOverflowScrolling: "touch" }}>
      <div style={{ maxWidth: 620, margin: "0 auto" }}>
        <div style={{ fontSize: 13, color: "#7d93b8", letterSpacing: 0.5, fontFamily: "system-ui,sans-serif", marginBottom: 6 }}>MISSION CONFIGURATOR</div>
        <div style={{ fontSize: 11, color: "#5f7396", fontFamily: "system-ui,sans-serif", lineHeight: 1.55, marginBottom: 14 }}>
          Choose the realm this session works in, then the node it represents. A <b>realm</b> groups a mission's
          nodes with their shared configuration. A <b>node</b> is an element of the mission that can communicate
          with other elements of the mission — a spacecraft, ground station, payload, simulator or operations
          centre; each has a name used to route messages between nodes, its own configuration, and a
          state-of-health namespace it publishes.
        </div>

        <div style={{
          display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 3, columnGap: 10, marginBottom: 20,
          fontFamily: "'IBM Plex Mono',monospace", fontSize: 11,
        }}>
          <span style={{ color: "#5f7396" }}>Realms folder</span><span style={{ color: "#cfe6ff" }}>{COSMOS_REALMS_DIR}&lt;realm&gt;/</span>
          <span style={{ color: "#5f7396" }}>Nodes folder</span><span style={{ color: "#cfe6ff" }}>{COSMOS_NODES_DIR}&lt;node&gt;/</span>
        </div>

        {renderServerConnector()}

        {renderSelectorPanel({
          heading: "REALM",
          note: bridgeStatus.state === "ok"
            ? `${remoteRealms.length} realm(s) loaded from the cosmos server (badged SERVER); the rest are LOCAL to this browser. Selecting one sets the active realm shown in the header and points the config editors at its files.`
            : "Switching realms changes which nodes are available below. Connect a cosmos server above to load the realms that exist on it.",
          items: Array.from(new Set([...realms, ...remoteRealms])),
          current: realm,
          remoteSet: new Set(remoteRealms),
          onSelect: (r) => {
            setRealm(r);
            setNodesByRealm((m) => (m[r] ? m : { ...m, [r]: remoteRealms.includes(r) ? [...remoteNodes] : [] }));
          },
          onAdd: (r) => {
            setRealms((rs) => (rs.includes(r) ? rs : [...rs, r]));
            setNodesByRealm((m) => (m[r] ? m : { ...m, [r]: [] }));
          },
          onRemove: (r) => {
            const all = Array.from(new Set([...realms, ...remoteRealms]));
            const remaining = all.filter((x) => x !== r);
            if (!remaining.length) return;
            setRealms((rs) => rs.filter((x) => x !== r));
            setNodesByRealm((m) => { const c = { ...m }; delete c[r]; return c; });
            if (realm === r) setRealm(remaining[0]);
          },
          addPlaceholder: "New realm name",
        })}

        <div style={{ marginTop: 14 }}>
          {renderConfigEditor({
            title: "REALM CONFIG",
            path: `${COSMOS_REALMS_DIR}${realm}/realm.ini`,
            value: realmText,
            onChange: (v) => setRealmFiles((f) => ({ ...f, [realm]: v })),
            onReset: () => setRealmFiles((f) => { const c = { ...f }; delete c[realm]; return c; }),
            bridgeRoot: "realms",
            bridgePath: `${realm}/realm.ini`,
          })}
        </div>

        <div style={{ height: 1, background: "rgba(143,215,255,0.12)", margin: "24px 0" }} />

        {renderSelectorPanel({
          heading: "NODE",
          note: `Nodes under realm “${realm}”${bridgeStatus.state === "ok" ? ` — ${remoteNodes.length} from the cosmos server (badged SERVER)` : ""}. Selecting one sets the active node shown in the header and points the config editor at its file. Live telemetry still auto-registers whatever node it reports.`,
          items: Array.from(new Set([...(nodesByRealm[realm] || []), ...remoteNodes])),
          current: nodeName,
          remoteSet: new Set(remoteNodes),
          onSelect: (n) => {
            setNodeName(n);
            setNodesByRealm((m) => {
              const cur = m[realm] || [];
              return cur.includes(n) ? m : { ...m, [realm]: [...cur, n] };
            });
          },
          onAdd: (n) => setNodesByRealm((m) => {
            const cur = m[realm] || [];
            return cur.includes(n) ? m : { ...m, [realm]: [...cur, n] };
          }),
          onRemove: (n) => setNodesByRealm((m) => ({ ...m, [realm]: (m[realm] || []).filter((x) => x !== n) })),
          addPlaceholder: "New node name",
        })}

        <div style={{ marginTop: 14 }}>
          {renderConfigEditor({
            title: "NODE CONFIG",
            path: `${COSMOS_NODES_DIR}${nodeName || "<node>"}/${nodeName || "<node>"}.ini`,
            value: nodeText,
            onChange: (v) => setNodeFiles((f) => ({ ...f, [nodeName]: v })),
            onReset: () => setNodeFiles((f) => { const c = { ...f }; delete c[nodeName]; return c; }),
            bridgeRoot: nodeName ? "nodes" : undefined,
            bridgePath: nodeName ? `${nodeName}/${nodeName}.ini` : undefined,
          })}
        </div>

        {renderServerFiles()}

        <div style={{ height: 1, background: "rgba(143,215,255,0.12)", margin: "26px 0 18px" }} />
        <div style={{ fontSize: 10, letterSpacing: 0.5, color: "#5f7396", fontFamily: "system-ui,sans-serif", marginBottom: 6 }}>EXAMPLE MISSIONS</div>
        {EXAMPLE_REALMS.map((ex) => (
          <div key={ex.realm} style={{
            border: "1px solid rgba(143,215,255,0.14)", borderRadius: 8, padding: "12px 14px 6px", marginBottom: 12,
            background: "rgba(9,14,28,0.4)",
          }}>
            <div style={{
              display: "inline-flex", alignItems: "baseline", gap: 8, padding: "5px 10px", borderRadius: 6, marginBottom: 6,
              background: "rgba(143,215,255,0.14)", border: "1px solid rgba(143,215,255,0.35)",
            }}>
              <span style={{ fontSize: 9, letterSpacing: 0.6, color: "#5f7396" }}>REALM</span>
              <span style={{ fontSize: 13, color: "#eaf3ff", fontWeight: 600 }}>{ex.realm}</span>
            </div>
            <RealmDiagram example={ex} />
            <div style={{ fontSize: 9, color: "#5f7396", textAlign: "center", marginTop: 2 }}>double-headed arrows = nodes that communicate</div>
          </div>
        ))}
      </div>
    </div>
  );
}
