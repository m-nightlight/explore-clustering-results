import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as d3 from "d3";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, GeoJsonLayer, LineLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { SphereGeometry } from "@luma.gl/engine";
import { WebMercatorViewport, FlyToInterpolator, AmbientLight, _SunLight as SunLight, LightingEffect } from "@deck.gl/core";
import Map from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { getSunInfo, getSunPath } from "./utils/sunPosition";
import { fetchStrangData, getIrradiance, clearSkyEstimate } from "./utils/smhiIrradiance";
import DegreeHoursMap from "./DegreeHoursMap";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

// AmbientLight and SunLight are both reactive — created inside MapView via useMemo.
const MAP_STYLES = [
  { id: "dark",           name: "Dark",           url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" },
  { id: "light",          name: "Light",          url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" },
  { id: "voyager",        name: "Voyager",        url: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json" },
  { id: "satellite",      name: "Satellite",      url: "mapbox://styles/matspmapping/cmg9qmif500a801sa4f0b5p5o" },
  { id: "street-numbers", name: "Street Numbers", url: "mapbox://styles/matspmapping/cmj2jmgfx004701se4c711vwc" },
];
const resolveStyle = (url) =>
  url.startsWith("mapbox://styles/")
    ? `https://api.mapbox.com/styles/v1/${url.slice(16)}?access_token=${MAPBOX_TOKEN}`
    : url;
const hexToRgb = (hex) => [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];

// 6-stop blue→red temperature color scale (matches the former HeatmapLayer colorRange)
const TEMP_COLOR_STOPS = [
  [65, 105, 225],   // cold  (blue)
  [100, 180, 220],
  [180, 220, 180],  // mild  (green-ish)
  [255, 230, 100],
  [255, 140, 0],    // warm  (orange)
  [200, 30,  30],   // hot   (red)
];
function tempToColor(temp, min, max) {
  const t = Math.max(0, Math.min(1, (temp - min) / Math.max(1, max - min)));
  const scaled = t * (TEMP_COLOR_STOPS.length - 1);
  const lo = Math.floor(scaled), hi = Math.min(lo + 1, TEMP_COLOR_STOPS.length - 1);
  const f = scaled - lo;
  return TEMP_COLOR_STOPS[lo].map((c, i) => Math.round(c + f * (TEMP_COLOR_STOPS[hi][i] - c)));
}

const API = "http://localhost:8000";

// ─── Theme & Constants ───────────────────────────────────────────
const COLORS = [
  "#E63946","#457B9D","#2A9D8F","#E9C46A","#F4A261",
  "#6BCB77","#A8DADC","#6A0572","#AB83A1","#1D3557",
  "#F77F00","#D62828","#023E8A","#0077B6","#00B4D8",
  "#90BE6D","#F94144","#277DA1","#577590","#4D908E",
  "#43AA8B","#F3722C","#F8961E","#F9844A","#F9C74F",
];

const getClusterColor = (i) => COLORS[i % COLORS.length];

// Visually distinct group colours, different enough from COLORS palette
const GROUP_COLORS = ["#FFFFFF","#FFD93D","#FF6B9D","#6BCB77","#C8B6FF","#FF9A3C","#4CC9F0"];

const SPHERE_GEOMETRY = new SphereGeometry({ radius: 1, nlat: 8, nlong: 8 });

// ─── API Utilities ───────────────────────────────────────────────
const fetchData = async (endpoint) => {
  const res = await fetch(`${API}${endpoint}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
};

// ─── Tabs ────────────────────────────────────────────────────────
const TABS = [
  { id: "profiles",  label: "Cluster Profiles",     icon: "◈" },
  { id: "timeseries",label: "Time Series",          icon: "◆" },
  { id: "metadata",  label: "Metadata Statistics",  icon: "▦" },
  { id: "map",       label: "Sensor Map",           icon: "◉" },
  { id: "deghours",  label: "Degree Hours",         icon: "▲" },
];

// ─── Main App ────────────────────────────────────────────────────
export default function App() {
  const [metadataData, setMetadataData] = useState(null);
  const [activeTab, setActiveTab] = useState("map");
  const [selectedK, setSelectedK] = useState(null);
  const [clusterColumns, setClusterColumns] = useState([]);
  const [selectedClusters, setSelectedClusters] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // ── Cluster groups ──
  const [clusterGroups, setClusterGroups] = useState([]);
  const [groupingMode, setGroupingMode] = useState(false);
  const [pendingGroupMembers, setPendingGroupMembers] = useState(new Set());

  // ── Custom CSV cluster columns ──
  const [customClusterCols, setCustomClusterCols] = useState({});
  const csvInputRef = useRef();
  const [pendingCSV, setPendingCSV] = useState(null); // { mapping, defaultName }
  const [pendingCSVName, setPendingCSVName] = useState("");

  // Derive cluster columns from metadata, preserving any custom CSV columns already loaded
  useEffect(() => {
    if (!metadataData || metadataData.length === 0) return;
    const cols = Object.keys(metadataData[0]).filter(
      (c) => c.toLowerCase().includes("cluster") || c.toLowerCase().startsWith("k_") || c.toLowerCase().match(/^k\d+/)
    );
    const base = cols.length === 0
      ? Object.keys(metadataData[0]).filter((c) => {
          const unique = new Set(metadataData.map((r) => r[c]));
          return unique.size >= 2 && unique.size <= 50 && c !== "lat" && c !== "lon";
        })
      : cols;
    // Keep any custom CSV columns that are already registered
    setClusterColumns((prev) => {
      const customNames = prev.filter((c) => !base.includes(c));
      return [...base, ...customNames];
    });
  }, [metadataData]);

  useEffect(() => {
    if (clusterColumns.length > 0 && !selectedK) {
      const saved = localStorage.getItem("sensorExplorer_selectedK");
      setSelectedK(saved && clusterColumns.includes(saved) ? saved : clusterColumns[0]);
    }
  }, [clusterColumns]);

  // Persist active cluster column selection
  useEffect(() => {
    if (selectedK) localStorage.setItem("sensorExplorer_selectedK", selectedK);
  }, [selectedK]);

  // Get unique clusters for selected k
  const clusters = useMemo(() => {
    if (!metadataData || !selectedK) return [];
    const unique = [...new Set(metadataData.map((r) => r[selectedK]))].filter(v => v !== null && v !== undefined);
    unique.sort((a, b) => Number(a) - Number(b));
    return unique;
  }, [metadataData, selectedK]);

  // Initialize selected clusters
  useEffect(() => {
    if (clusters.length > 0) {
      setSelectedClusters(new Set(clusters));
    }
  }, [clusters]);

  // Sensor-to-cluster map
  const sensorClusterMap = useMemo(() => {
    if (!metadataData || !selectedK) return {};
    const map = {};
    const sensorCol = Object.keys(metadataData[0]).find(
      (c) => c.toLowerCase().includes("sensor") || c.toLowerCase().includes("name") || c.toLowerCase() === "id"
    ) || Object.keys(metadataData[0])[0];
    metadataData.forEach((row) => {
      map[row[sensorCol]] = row[selectedK];
    });
    return map;
  }, [metadataData, selectedK]);

  // Sensor ID column name
  const sensorIdCol = useMemo(() => {
    if (!metadataData || metadataData.length === 0) return null;
    return Object.keys(metadataData[0]).find(
      (c) => c.toLowerCase().includes("sensor") || c.toLowerCase().includes("name") || c.toLowerCase() === "id"
    ) || Object.keys(metadataData[0])[0];
  }, [metadataData]);


  const sensorList = useMemo(() => {
    if (!metadataData || !sensorIdCol) return [];
    return metadataData.map((r) => r[sensorIdCol]).filter(Boolean);
  }, [metadataData, sensorIdCol]);

  const loadData = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [metadata, savedCols] = await Promise.all([
        fetchData("/api/metadata"),
        fetchData("/api/custom-cluster-cols").catch(() => []),
      ]);
      if (!metadata.length) throw new Error("No sensor metadata returned");
      // Apply saved custom columns to metadata before setting state
      let enriched = metadata;
      for (const { name, mapping } of savedCols) {
        enriched = enriched.map((r) => ({ ...r, [name]: mapping[r.sensor_id] ?? null }));
      }
      setMetadataData(enriched);
      if (savedCols.length) {
        setCustomClusterCols(Object.fromEntries(savedCols.map(({ name, mapping }) => [name, mapping])));
        setClusterColumns((prev) => {
          const names = savedCols.map((c) => c.name);
          const builtins = prev.filter((c) => !names.includes(c));
          return [...names, ...builtins]; // CSV cols first
        });
      }
    } catch (e) {
      setError(`Failed to load data: ${e.message}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleCluster = (c) => {
    setSelectedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const selectAllClusters = () => setSelectedClusters(new Set(clusters));
  const selectNoneClusters = () => setSelectedClusters(new Set());

  // ── Custom CSV cluster columns ──
  const parseClusterCSV = (text) => {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error("CSV must have a header and at least one data row");
    const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const nameIdx = headers.findIndex((h) => h.toLowerCase() === "combined_name");
    if (nameIdx === -1) throw new Error('CSV must have a "combined_name" column');
    const clusterIdx = headers.findIndex((_, i) => i !== nameIdx);
    if (clusterIdx === -1) throw new Error("CSV must have at least two columns");
    const colName = headers[clusterIdx];
    const mapping = {};
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
      const sensorId = parts[nameIdx];
      const raw = parts[clusterIdx];
      if (sensorId && raw !== "" && raw != null) {
        mapping[sensorId] = parseInt(raw, 10);
      }
    }
    if (Object.keys(mapping).length === 0) throw new Error("No valid rows found in CSV");
    return { colName, mapping };
  };

  const addCustomClusterCol = (colName, mapping) => {
    setCustomClusterCols((prev) => ({ ...prev, [colName]: mapping }));
    setMetadataData((prev) => prev.map((r) => ({ ...r, [colName]: mapping[r.sensor_id] ?? null })));
    setClusterColumns((prev) => (prev.includes(colName) ? prev : [colName, ...prev]));
  };

  const removeCustomClusterCol = (colName) => {
    setCustomClusterCols((prev) => { const next = { ...prev }; delete next[colName]; return next; });
    setMetadataData((prev) => prev.map((r) => { const next = { ...r }; delete next[colName]; return next; }));
    setClusterColumns((prev) => prev.filter((c) => c !== colName));
    if (selectedK === colName) setSelectedK(clusterColumns.find((c) => c !== colName) ?? null);
    // Delete from server
    fetch(`${API}/api/custom-cluster-cols/${encodeURIComponent(colName)}`, { method: "DELETE" })
      .catch((e) => console.warn("Failed to delete custom cluster col:", e));
  };

  const handleCSVFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const { colName, mapping } = parseClusterCSV(ev.target.result);
        // Stage the parsed CSV — user will confirm a name before it's added
        const defaultName = file.name.replace(/\.csv$/i, "");
        setPendingCSV({ mapping, colName });
        setPendingCSVName(defaultName);
      } catch (err) {
        alert(`CSV import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const confirmPendingCSV = () => {
    if (!pendingCSV) return;
    const name = pendingCSVName.trim() || pendingCSV.colName;
    // Deduplicate if name already exists
    const existingNames = new Set([
      ...Object.keys(customClusterCols),
      ...Object.keys(metadataData?.[0] ?? {}),
    ]);
    let finalName = name;
    let suffix = 2;
    while (existingNames.has(finalName)) finalName = `${name}_${suffix++}`;
    addCustomClusterCol(finalName, pendingCSV.mapping);
    // Persist to server (fire-and-forget — local state is already updated)
    fetch(`${API}/api/custom-cluster-cols/${encodeURIComponent(finalName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mapping: pendingCSV.mapping }),
    }).catch((e) => console.warn("Failed to save custom cluster col:", e));
    setPendingCSV(null);
    setPendingCSVName("");
  };

  // Map clusterID → group index for fast lookup
  const clusterToGroupIdx = useMemo(() => {
    const map = {};
    clusterGroups.forEach((g, gi) => g.memberIds.forEach((cid) => { map[String(cid)] = gi; }));
    return map;
  }, [clusterGroups]);

  const getEffectiveClusterColor = useCallback((cluster, ci) => {
    const gi = clusterToGroupIdx[String(cluster)];
    return gi !== undefined ? GROUP_COLORS[gi % GROUP_COLORS.length] : getClusterColor(ci >= 0 ? ci : 0);
  }, [clusterToGroupIdx]);

  // Cross-tab navigation: MetadataStats → Map
  const [navigateToBuilding, setNavigateToBuilding] = useState(null);
  const handleNavigateToBuilding = useCallback((bid, lat, lon) => {
    setNavigateToBuilding({ bid, lat, lon, ts: Date.now() });
    setActiveTab("map");
  }, []);

  const togglePending = (c) => {
    setPendingGroupMembers((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  const createGroup = () => {
    if (pendingGroupMembers.size < 2) return;
    setClusterGroups((prev) => [
      ...prev,
      { id: `g${Date.now()}`, name: `Group ${prev.length + 1}`, memberIds: new Set(pendingGroupMembers) },
    ]);
    setPendingGroupMembers(new Set());
    setGroupingMode(false);
  };

  const deleteGroup = (gid) => setClusterGroups((prev) => prev.filter((g) => g.id !== gid));

  const isDataLoaded = metadataData !== null;

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div>
            <h1 style={styles.title}>Sensor Cluster Explorer</h1>
            <p style={styles.subtitle}>Temperature sensor analysis & cluster profiling</p>
          </div>
          {selectedK && (
            <div style={styles.kSelector}>
              <label style={styles.kLabel}>Cluster Assignment:</label>
              <select
                value={selectedK}
                onChange={(e) => setSelectedK(e.target.value)}
                style={styles.select}
              >
                {(() => {
                  const csvNames = new Set(Object.keys(customClusterCols));
                  const csvCols = clusterColumns.filter((c) => csvNames.has(c));
                  const builtinCols = clusterColumns.filter((c) => !csvNames.has(c));
                  return (
                    <>
                      {csvCols.length > 0 && (
                        <optgroup label="CSV imports">
                          {csvCols.map((c) => <option key={c} value={c}>{c}</option>)}
                        </optgroup>
                      )}
                      {builtinCols.length > 0 && (
                        <optgroup label="Built-in">
                          {builtinCols.map((c) => <option key={c} value={c}>{c}</option>)}
                        </optgroup>
                      )}
                    </>
                  );
                })()}
              </select>
              <span style={styles.kBadge}>{clusters.length} clusters</span>
              {Object.keys(customClusterCols).map((colName) => (
                <button
                  key={colName}
                  onClick={() => removeCustomClusterCol(colName)}
                  title={`Remove custom column "${colName}"`}
                  style={{ ...styles.miniBtn, borderColor: "#4CC9F0", color: "#4CC9F0", fontSize: 9 }}
                >
                  {colName} ×
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* Loading / Error State */}
      {!metadataData && (
        <div style={styles.uploadSection}>
          {loading && <div style={styles.loading}>Loading data from server...</div>}
          {error && (
            <div style={{ textAlign: "center" }}>
              <div style={styles.error}>{error}</div>
              <button style={styles.retryBtn} onClick={loadData}>Retry</button>
            </div>
          )}
        </div>
      )}

      {/* Main Content */}
      {isDataLoaded && (
        <>
          {/* Tabs */}
          <nav style={styles.tabBar}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  ...styles.tab,
                  ...(activeTab === tab.id ? styles.tabActive : {}),
                }}
              >
                <span style={styles.tabIcon}>{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>

          {/* Cluster Selector */}
          <div style={styles.clusterBar}>
            <div style={styles.clusterBarHeader}>
              <span style={styles.clusterBarTitle}>Clusters</span>
              <button onClick={selectAllClusters} style={styles.miniBtn}>All</button>
              <button onClick={selectNoneClusters} style={styles.miniBtn}>None</button>
              <button
                onClick={() => { setGroupingMode((v) => !v); setPendingGroupMembers(new Set()); }}
                style={{ ...styles.miniBtn, borderColor: groupingMode ? "#FFD93D" : "#3d4555", color: groupingMode ? "#FFD93D" : "#8b949e", background: groupingMode ? "#FFD93D22" : "none" }}
              >
                ⊕ Group
              </button>
              <button
                onClick={() => csvInputRef.current?.click()}
                title="Import a CSV with combined_name + cluster column"
                style={{ ...styles.miniBtn }}
              >
                ⊕ CSV
              </button>
              <input ref={csvInputRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleCSVFileChange} />
              {pendingCSV && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, background: "#1f2a3a", border: "1px solid #457B9D", borderRadius: 6, padding: "3px 6px" }}>
                  <span style={{ fontSize: 10, color: "#8b949e", whiteSpace: "nowrap" }}>Name:</span>
                  <input
                    autoFocus
                    value={pendingCSVName}
                    onChange={(e) => setPendingCSVName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") confirmPendingCSV(); if (e.key === "Escape") { setPendingCSV(null); setPendingCSVName(""); } }}
                    style={{ width: 120, background: "transparent", border: "none", outline: "none", color: "#c9d1d9", fontSize: 11, fontFamily: "monospace" }}
                  />
                  <button onClick={confirmPendingCSV} style={{ ...styles.miniBtn, padding: "2px 8px", fontSize: 10, borderColor: "#457B9D", color: "#457B9D" }}>Add</button>
                  <button onClick={() => { setPendingCSV(null); setPendingCSVName(""); }} style={{ ...styles.miniBtn, padding: "2px 6px", fontSize: 10 }}>✕</button>
                </div>
              )}
              {groupingMode && pendingGroupMembers.size >= 2 && (
                <button onClick={createGroup} style={{ ...styles.miniBtn, borderColor: "#6BCB77", color: "#6BCB77", background: "#6BCB7722" }}>
                  ✓ Create ({pendingGroupMembers.size})
                </button>
              )}
            </div>
            <div style={styles.clusterChips}>
              {/* Existing groups */}
              {clusterGroups.map((g, gi) => {
                const groupColor = GROUP_COLORS[gi % GROUP_COLORS.length];
                const memberList = [...g.memberIds].sort((a, b) => a - b);
                const count = metadataData.filter((r) => memberList.includes(r[selectedK])).length;
                const allOn = memberList.every((c) => selectedClusters.has(c));
                return (
                  <span key={g.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                    <button
                      onClick={() => setSelectedClusters((prev) => {
                        const next = new Set(prev);
                        if (allOn) memberList.forEach((c) => next.delete(c)); else memberList.forEach((c) => next.add(c));
                        return next;
                      })}
                      style={{ ...styles.chip, backgroundColor: allOn ? groupColor : "transparent", color: allOn ? "#111" : "#999", borderColor: groupColor, fontWeight: 600 }}
                    >
                      {g.name}: {memberList.join("+")} <span style={styles.chipCount}>({count})</span>
                    </button>
                    <button onClick={() => deleteGroup(g.id)} style={{ ...styles.miniBtn, padding: "1px 5px", fontSize: 10, color: "#f85149", borderColor: "#f85149", lineHeight: 1 }}>×</button>
                  </span>
                );
              })}
              {/* Individual cluster chips */}
              {clusters.map((c, i) => {
                const inGroup = clusterToGroupIdx[String(c)] !== undefined;
                if (inGroup) return null; // grouped clusters hidden from individual list
                const count = metadataData.filter((r) => r[selectedK] === c).length;
                const isPending = pendingGroupMembers.has(c);
                const isSelected = selectedClusters.has(c);
                const color = getEffectiveClusterColor(c, i);
                return (
                  <button
                    key={c}
                    onClick={() => groupingMode ? togglePending(c) : toggleCluster(c)}
                    style={{
                      ...styles.chip,
                      backgroundColor: groupingMode
                        ? (isPending ? color + "55" : "transparent")
                        : (isSelected ? color : "transparent"),
                      color: (groupingMode ? isPending : isSelected) ? "#fff" : "#999",
                      borderColor: color,
                      borderStyle: groupingMode ? (isPending ? "solid" : "dashed") : "solid",
                      opacity: groupingMode && !isPending ? 0.5 : 1,
                    }}
                  >
                    {c} <span style={styles.chipCount}>({count})</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tab Content */}
          <main style={styles.main}>
            {activeTab === "profiles" && (
              <ClusterProfiles
                selectedK={selectedK}
                clusters={clusters}
                selectedClusters={selectedClusters}
                clusterGroups={clusterGroups}
                getEffectiveClusterColor={getEffectiveClusterColor}
                customColMapping={customClusterCols[selectedK] ?? null}
              />
            )}
            {activeTab === "timeseries" && (
              <TimeSeriesView
                selectedK={selectedK}
                clusters={clusters}
                selectedClusters={selectedClusters}
                sensorClusterMap={sensorClusterMap}
                sensorList={sensorList}
                customColMapping={customClusterCols[selectedK] ?? null}
              />
            )}
            {activeTab === "metadata" && (
              <MetadataStats
                metadataData={metadataData}
                selectedK={selectedK}
                clusters={clusters}
                selectedClusters={selectedClusters}
                getEffectiveClusterColor={getEffectiveClusterColor}
                customClusterCols={customClusterCols}
                onNavigateToBuilding={handleNavigateToBuilding}
              />
            )}
            {activeTab === "map" && (
              <MapView
                metadataData={metadataData}
                selectedK={selectedK}
                clusters={clusters}
                selectedClusters={selectedClusters}
                sensorIdCol={sensorIdCol}
                clusterGroups={clusterGroups}
                getEffectiveClusterColor={getEffectiveClusterColor}
                customClusterCols={customClusterCols}
                navigateToBuilding={navigateToBuilding}
              />
            )}
            {activeTab === "deghours" && (
              <DegreeHoursMap metadataData={metadataData} />
            )}

          </main>
        </>
      )}
    </div>
  );
}


// ─── Metadata Statistics helpers ─────────────────────────────────

function classifyColumn(key, rows) {
  const vals = rows.map((r) => r[key]).filter((v) => v != null && v !== "");
  if (vals.length < 2) return null;
  const unique = [...new Set(vals.map(String))];
  if (unique.length <= 1) return null;
  const numeric = vals.every((v) => !isNaN(Number(v)));
  if (numeric) {
    const nums = vals.map(Number);
    const uNums = new Set(nums);
    return uNums.size > 20 ? "continuous" : "ordinal";
  }
  if (unique.length <= 40) return "categorical";
  return null; // too many categories — skip
}

// Chi-squared test of independence: returns a p-value bucket string
function chiSquaredPBucket(rows, key, selectedK) {
  const counts = {};
  rows.forEach((r) => {
    const cat = String(r[key] ?? "__null");
    const cid = String(r[selectedK] ?? "__null");
    if (!counts[cat]) counts[cat] = {};
    counts[cat][cid] = (counts[cat][cid] || 0) + 1;
  });
  const cats = Object.keys(counts);
  const cids = [...new Set(rows.map((r) => String(r[selectedK] ?? "__null")))];
  const rowTotals = cats.map((c) => Object.values(counts[c]).reduce((s, n) => s + n, 0));
  const colTotals = {};
  cids.forEach((cid) => { colTotals[cid] = cats.reduce((s, c) => s + (counts[c][cid] || 0), 0); });
  const n = rowTotals.reduce((s, v) => s + v, 0);
  if (n === 0) return null;
  let chi2 = 0;
  cats.forEach((c, ci) => {
    cids.forEach((cid) => {
      const O = counts[c][cid] || 0;
      const E = (rowTotals[ci] * colTotals[cid]) / n;
      if (E > 0) chi2 += (O - E) ** 2 / E;
    });
  });
  const df = (cats.length - 1) * (cids.length - 1);
  if (df <= 0) return null;
  // Approximation: use chi2/df ratio as a proxy for significance thresholds
  const ratio = chi2 / df;
  if (ratio > 10)  return { label: "p < 0.001", color: "#2a9d8f" };
  if (ratio > 5)   return { label: "p < 0.01",  color: "#57cc99" };
  if (ratio > 2.5) return { label: "p < 0.05",  color: "#e9c46a" };
  return { label: "n.s.", color: "#556677" };
}

// Kruskal-Wallis H proxy for continuous columns
function kwPBucket(rows, key, selectedK) {
  const groups = {};
  rows.forEach((r) => {
    const v = Number(r[key]);
    if (isNaN(v)) return;
    const cid = String(r[selectedK] ?? "__null");
    if (!groups[cid]) groups[cid] = [];
    groups[cid].push(v);
  });
  const gVals = Object.values(groups).filter((g) => g.length >= 2);
  if (gVals.length < 2) return null;
  const allVals = gVals.flat().sort((a, b) => a - b);
  const n = allVals.length;
  const rankMap = new Map();
  allVals.forEach((v, i) => {
    if (!rankMap.has(v)) rankMap.set(v, []);
    rankMap.get(v).push(i + 1);
  });
  const avgRank = (v) => { const rs = rankMap.get(v); return rs.reduce((s, r) => s + r, 0) / rs.length; };
  const H = (12 / (n * (n + 1))) *
    gVals.reduce((s, g) => s + (g.length * (d3.mean(g.map(avgRank)) - (n + 1) / 2) ** 2), 0);
  const df = gVals.length - 1;
  const ratio = H / df;
  if (ratio > 10)  return { label: "p < 0.001", color: "#2a9d8f" };
  if (ratio > 5)   return { label: "p < 0.01",  color: "#57cc99" };
  if (ratio > 2.5) return { label: "p < 0.05",  color: "#e9c46a" };
  return { label: "n.s.", color: "#556677" };
}

function renderMetaStackedBars(canvas, rows, key, selectedK, clusters, normalize, colorFn) {
  if (!canvas || !rows?.length) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);

  const ML = 40, MR = 12, MT = 10, MB = 52;
  const pw = w - ML - MR, ph = h - MT - MB;
  ctx.fillStyle = "#1a1f2e"; ctx.fillRect(0, 0, w, h);

  // Build counts[label][clusterId]
  const counts = {};
  rows.forEach((r) => {
    const lbl = String(r[key] ?? "—");
    const cid = r[selectedK];
    if (cid == null) return;
    if (!counts[lbl]) counts[lbl] = {};
    counts[lbl][cid] = (counts[lbl][cid] || 0) + 1;
  });
  const labels = Object.keys(counts).sort();
  if (!labels.length) return;

  const clusterTotals = {};
  clusters.forEach((c) => { clusterTotals[c] = rows.filter((r) => r[selectedK] === c).length || 1; });

  const barW = Math.max(3, pw / labels.length - 2);
  const gap = Math.max(1, (pw - barW * labels.length) / Math.max(1, labels.length - 1));

  // y-axis: max stack height
  const maxVal = normalize
    ? 100
    : Math.max(...labels.map((l) => clusters.reduce((s, c) => s + (counts[l][c] || 0), 0)), 1);

  // Grid
  ctx.strokeStyle = "#252c3d"; ctx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach((pct) => {
    const y = MT + ph * (1 - pct);
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + pw, y); ctx.stroke();
    ctx.fillStyle = "#8899bb"; ctx.font = "9px system-ui, sans-serif"; ctx.textAlign = "right";
    ctx.fillText(normalize ? `${Math.round(pct * 100)}%` : Math.round(pct * maxVal), ML - 4, y + 3);
  });

  // Bars
  labels.forEach((lbl, i) => {
    const x = ML + i * (barW + gap);
    const stackTotal = clusters.reduce((s, c) => s + (counts[lbl][c] || 0), 0);
    let y = MT + ph;
    clusters.forEach((c, ci) => {
      const raw = counts[lbl][c] || 0;
      if (!raw) return;
      const val = normalize ? (raw / (clusterTotals[c] || 1)) * 100 : raw;
      const barH = Math.max(1, (val / maxVal) * ph);
      ctx.fillStyle = colorFn(c);
      ctx.fillRect(x, y - barH, barW, barH);
      y -= barH;
    });
    // x label
    ctx.save();
    ctx.translate(x + barW / 2, MT + ph + 8);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#667788"; ctx.font = "8px system-ui, sans-serif"; ctx.textAlign = "left";
    ctx.fillText(lbl.length > 14 ? lbl.slice(0, 13) + "…" : lbl, 0, 0);
    ctx.restore();
  });
}

function renderMetaBoxPlots(canvas, rows, key, selectedK, clusters, colorFn) {
  if (!canvas || !rows?.length) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);

  const ML = 44, MR = 12, MT = 10, MB = 28;
  const pw = w - ML - MR, ph = h - MT - MB;
  ctx.fillStyle = "#1a1f2e"; ctx.fillRect(0, 0, w, h);

  const grouped = {};
  clusters.forEach((c) => { grouped[c] = []; });
  rows.forEach((r) => {
    const v = Number(r[key]);
    const c = r[selectedK];
    if (!isNaN(v) && c != null && grouped[c]) grouped[c].push(v);
  });

  const allVals = Object.values(grouped).flat();
  if (!allVals.length) return;
  // Clip axis to 1–99th percentile; whiskers/outliers beyond are clipped at the edge
  const sortedAll = [...allVals].sort((a, b) => a - b);
  const yMin = d3.quantile(sortedAll, 0.01);
  const yMax = d3.quantile(sortedAll, 0.99);
  const yPad = (yMax - yMin) * 0.05 || 1;
  const yScale = d3.scaleLinear().domain([yMin - yPad, yMax + yPad]).range([MT + ph, MT]);

  // Grid
  ctx.strokeStyle = "#252c3d"; ctx.lineWidth = 1;
  yScale.ticks(4).forEach((t) => {
    const y = yScale(t);
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + pw, y); ctx.stroke();
    ctx.fillStyle = "#8899bb"; ctx.font = "9px system-ui, sans-serif"; ctx.textAlign = "right";
    ctx.fillText(t % 1 === 0 ? t : t.toFixed(1), ML - 4, y + 3);
  });

  const boxW = Math.min(28, pw / clusters.length * 0.6);
  const step = pw / clusters.length;

  clusters.forEach((c, ci) => {
    const vals = grouped[c].sort((a, b) => a - b);
    if (vals.length < 2) return;
    const x = ML + ci * step + step / 2;
    const q1 = d3.quantile(vals, 0.25);
    const med = d3.quantile(vals, 0.5);
    const q3 = d3.quantile(vals, 0.75);
    const iqr = q3 - q1;
    const wLo = Math.max(vals[0], q1 - 1.5 * iqr);
    const wHi = Math.min(vals[vals.length - 1], q3 + 1.5 * iqr);
    const color = colorFn(c);
    const [r, g, b] = hexToRgb(color);

    // Box fill
    ctx.fillStyle = `rgba(${r},${g},${b},0.18)`;
    ctx.fillRect(x - boxW / 2, yScale(q3), boxW, yScale(q1) - yScale(q3));
    // Box border
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.strokeRect(x - boxW / 2, yScale(q3), boxW, yScale(q1) - yScale(q3));
    // Median
    ctx.beginPath(); ctx.moveTo(x - boxW / 2, yScale(med)); ctx.lineTo(x + boxW / 2, yScale(med));
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
    // Whiskers
    ctx.lineWidth = 1; ctx.strokeStyle = color + "aa";
    ctx.beginPath(); ctx.moveTo(x, yScale(q1)); ctx.lineTo(x, yScale(wLo)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, yScale(q3)); ctx.lineTo(x, yScale(wHi)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - boxW / 4, yScale(wLo)); ctx.lineTo(x + boxW / 4, yScale(wLo)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - boxW / 4, yScale(wHi)); ctx.lineTo(x + boxW / 4, yScale(wHi)); ctx.stroke();
    // Cluster label
    ctx.fillStyle = "#8899bb"; ctx.font = "9px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`C${c}`, x, MT + ph + 16);
  });
}

function renderMetaKDE(canvas, rows, key, selectedK, clusters, colorFn) {
  if (!canvas || !rows?.length) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);

  const ML = 44, MR = 12, MT = 10, MB = 24;
  const pw = w - ML - MR, ph = h - MT - MB;
  ctx.fillStyle = "#1a1f2e"; ctx.fillRect(0, 0, w, h);

  const grouped = {};
  clusters.forEach((c) => { grouped[c] = []; });
  rows.forEach((r) => {
    const v = Number(r[key]);
    const c = r[selectedK];
    if (!isNaN(v) && c != null && grouped[c]) grouped[c].push(v);
  });

  const allVals = Object.values(grouped).flat();
  if (allVals.length < 4) return;
  // Clip to 2–98th percentile so outliers don't squash the distribution
  const sorted = [...allVals].sort((a, b) => a - b);
  const xMin = d3.quantile(sorted, 0.02);
  const xMax = d3.quantile(sorted, 0.98);
  const xPad = (xMax - xMin) * 0.1 || 1;
  const xScale = d3.scaleLinear().domain([xMin - xPad, xMax + xPad]).range([ML, ML + pw]);
  const xGrid = d3.range(xMin - xPad, xMax + xPad, (xMax - xMin + 2 * xPad) / 200);

  const gaussian = (u) => Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
  const densities = {};
  clusters.forEach((c) => {
    const data = grouped[c];
    if (data.length < 2) return;
    const std = d3.deviation(data) || 1;
    const bw = Math.max(0.5, 1.06 * std * Math.pow(data.length, -0.2));
    densities[c] = xGrid.map((x) => d3.mean(data, (v) => gaussian((x - v) / bw) / bw));
  });

  const maxD = Math.max(...Object.values(densities).flat(), 1e-9);
  const yScale = d3.scaleLinear().domain([0, maxD * 1.1]).range([MT + ph, MT]);

  // Grid
  ctx.strokeStyle = "#252c3d"; ctx.lineWidth = 1;
  xScale.ticks(5).forEach((t) => {
    const x = xScale(t);
    ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + ph); ctx.stroke();
    ctx.fillStyle = "#8899bb"; ctx.font = "9px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(t % 1 === 0 ? t : t.toFixed(1), x, MT + ph + 14);
  });
  ctx.fillStyle = "#445566"; ctx.font = "8px system-ui, sans-serif"; ctx.textAlign = "right";
  ctx.fillText("2–98%ile", ML + pw, MT - 2);

  // KDE fills + lines
  clusters.forEach((c) => {
    const pts = densities[c];
    if (!pts) return;
    const color = colorFn(c);
    const [r, g, b] = hexToRgb(color);

    ctx.beginPath();
    ctx.moveTo(xScale(xGrid[0]), yScale(0));
    xGrid.forEach((x, i) => ctx.lineTo(xScale(x), yScale(pts[i])));
    ctx.lineTo(xScale(xGrid[xGrid.length - 1]), yScale(0));
    ctx.closePath();
    ctx.fillStyle = `rgba(${r},${g},${b},0.15)`; ctx.fill();

    ctx.beginPath();
    xGrid.forEach((x, i) => i === 0 ? ctx.moveTo(xScale(x), yScale(pts[i])) : ctx.lineTo(xScale(x), yScale(pts[i])));
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  });
}

// ─── Building cluster panel ───────────────────────────────────────
function BuildingClusterPanel({ enrichedRows, selectedK, clusters, colorFn, onNavigateToBuilding }) {
  const [sortMode, setSortMode] = useState("dominant"); // "dominant" | "mixed"
  const [minSensors, setMinSensors] = useState(2);
  const [search, setSearch] = useState("");

  const buildingStats = useMemo(() => {
    if (!enrichedRows?.length || !selectedK) return [];
    const groups = {};
    enrichedRows.forEach((r) => {
      const bid = r["lm_building_id"] || r["area"] || "Unknown";
      if (!groups[bid]) groups[bid] = { sensors: [], lats: [], lons: [] };
      groups[bid].sensors.push(r);
      if (r.lat != null) groups[bid].lats.push(Number(r.lat));
      if (r.lon != null) groups[bid].lons.push(Number(r.lon));
    });

    return Object.entries(groups).map(([bid, { sensors, lats, lons }]) => {
      const counts = {};
      sensors.forEach((s) => {
        const cid = s[selectedK];
        if (cid != null) counts[String(cid)] = (counts[String(cid)] || 0) + 1;
      });
      const total = Object.values(counts).reduce((s, v) => s + v, 0);
      if (total < 1) return null;
      const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
      const top1Pct = total > 0 ? (sorted[0]?.[1] || 0) / total : 0;
      const top2Pct = total > 0 ? ((sorted[0]?.[1] || 0) + (sorted[1]?.[1] || 0)) / total : 0;
      const avgLat = lats.length ? lats.reduce((s, v) => s + v, 0) / lats.length : null;
      const avgLon = lons.length ? lons.reduce((s, v) => s + v, 0) / lons.length : null;
      return { bid, total, counts, sorted, top1Pct, top2Pct, avgLat, avgLon };
    }).filter(Boolean);
  }, [enrichedRows, selectedK]);

  const filtered = useMemo(() => {
    let rows = buildingStats.filter((b) => b.total >= minSensors);
    if (search) rows = rows.filter((b) => b.bid.toLowerCase().includes(search.toLowerCase()));
    if (sortMode === "dominant") {
      rows = [...rows].sort((a, b) => b.top1Pct - a.top1Pct);
    } else {
      // "mixed": sort by how evenly top-2 clusters share (top2 close to 100%, top1 not too high)
      rows = [...rows].sort((a, b) => {
        const mixA = a.top2Pct - a.top1Pct; // higher = more even split between top-2
        const mixB = b.top2Pct - b.top1Pct;
        return mixB - mixA;
      });
    }
    return rows;
  }, [buildingStats, sortMode, minSensors, search]);

  if (!enrichedRows?.length) return null;

  return (
    <div style={{ borderTop: "1px solid #2e3440", marginTop: 18, paddingTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#c9d1d9" }}>Building cluster affinity</span>
        <span style={{ fontSize: 10, color: "#556677" }}>{filtered.length} buildings</span>
        <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
          {["dominant", "mixed"].map((m) => (
            <button key={m} onClick={() => setSortMode(m)}
              style={{ fontSize: 9, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                border: `1px solid ${sortMode === m ? "#457B9D" : "#3d4555"}`,
                background: sortMode === m ? "#457B9D22" : "transparent",
                color: sortMode === m ? "#4CC9F0" : "#8b949e" }}>
              {m === "dominant" ? "Most homogeneous" : "Most mixed"}
            </button>
          ))}
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter…"
          style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, border: "1px solid #3d4555",
            background: "#141820", color: "#c9d1d9", width: 90 }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 340, overflowY: "auto" }}>
        {filtered.slice(0, 120).map(({ bid, total, sorted, top1Pct, avgLat, avgLon }) => (
          <div key={bid}
            onClick={() => onNavigateToBuilding?.(bid, avgLat, avgLon)}
            title={`${bid} — click to view on map`}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px",
              borderRadius: 5, cursor: "pointer", background: "#1d2232",
              border: "1px solid #252c3d", transition: "border-color 0.15s" }}
            onMouseEnter={(e) => e.currentTarget.style.borderColor = "#457B9D"}
            onMouseLeave={(e) => e.currentTarget.style.borderColor = "#252c3d"}
          >
            {/* Building name */}
            <span style={{ fontSize: 10, color: "#c9d1d9", width: 140, flexShrink: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={bid}>
              {bid}
            </span>
            {/* Sensor count */}
            <span style={{ fontSize: 9, color: "#556677", width: 28, textAlign: "right", flexShrink: 0 }}>
              {total}
            </span>
            {/* Stacked proportion bar */}
            <div style={{ flex: 1, height: 8, borderRadius: 3, overflow: "hidden", display: "flex", minWidth: 60 }}>
              {sorted.map(([cidStr, cnt]) => (
                <div key={cidStr}
                  title={`C${cidStr}: ${Math.round(cnt / total * 100)}%`}
                  style={{ width: `${cnt / total * 100}%`, background: colorFn(Number(cidStr)), height: "100%" }} />
              ))}
            </div>
            {/* Top cluster label(s) */}
            <div style={{ display: "flex", gap: 3, flexShrink: 0, minWidth: 56 }}>
              {sorted.slice(0, 3).map(([cidStr, cnt]) => {
                const pct = Math.round(cnt / total * 100);
                if (pct < 10) return null;
                return (
                  <span key={cidStr} style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3,
                    background: colorFn(Number(cidStr)) + "33", color: colorFn(Number(cidStr)),
                    border: `1px solid ${colorFn(Number(cidStr))}55` }}>
                    C{cidStr} {pct}%
                  </span>
                );
              })}
            </div>
            {/* Map icon */}
            <span style={{ fontSize: 10, color: "#3d4555", flexShrink: 0 }}>⌖</span>
          </div>
        ))}
        {filtered.length > 120 && (
          <p style={{ fontSize: 9, color: "#445566", textAlign: "center", margin: "4px 0 0" }}>
            Showing 120 of {filtered.length}. Use filter to narrow results.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── MetadataStats component ──────────────────────────────────────
const SKIP_COLS = new Set(["sensor_id", "lat", "lon", "lm_building_id", "geom", "building_geom"]);

function MetadataStats({ metadataData, selectedK, clusters, selectedClusters, getEffectiveClusterColor, customClusterCols, onNavigateToBuilding }) {
  const [fullData, setFullData] = useState(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [normalize, setNormalize] = useState(false);
  const [sortBySig, setSortBySig] = useState(true);
  const hasFetched = useRef(false);

  // Lazy-fetch once on first render
  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    setLoadingFull(true);
    setFetchError(null);
    fetch(`${API}/api/metadata-full`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => {
        if (!Array.isArray(data)) throw new Error("Unexpected response format");
        setFullData(data);
        setLoadingFull(false);
      })
      .catch((e) => { setFetchError(e.message); setLoadingFull(false); });
  }, []);

  // Merge fullData with metadataData to get cluster assignments (incl. custom CSV cols)
  const enrichedRows = useMemo(() => {
    if (!Array.isArray(fullData) || !metadataData) return null;
    const metaMap = Object.fromEntries(metadataData.map((r) => [r.sensor_id, r]));
    return fullData.map((r) => ({ ...r, ...(metaMap[r.sensor_id] || {}) }));
  }, [fullData, metadataData]);

  // Discover and classify columns
  const columnDefs = useMemo(() => {
    if (!enrichedRows?.length || !selectedK) return [];
    const clusterCols = new Set(
      Object.keys(enrichedRows[0]).filter((k) =>
        k.toLowerCase().includes("cluster") || k.toLowerCase().startsWith("k_") || k.match(/^k\d+/)
      )
    );
    // Also skip the selectedK itself and custom col keys
    [...Object.keys(customClusterCols), selectedK].forEach((k) => clusterCols.add(k));

    return Object.keys(enrichedRows[0])
      .filter((k) => !SKIP_COLS.has(k) && !clusterCols.has(k))
      .map((k) => ({ key: k, type: classifyColumn(k, enrichedRows) }))
      .filter((d) => d.type !== null);
  }, [enrichedRows, selectedK, customClusterCols]);

  // Compute significance for each column (wrapped in try-catch per column)
  const sigMap = useMemo(() => {
    if (!enrichedRows || !selectedK) return {};
    const result = {};
    columnDefs.forEach(({ key, type }) => {
      try {
        result[key] = type === "continuous"
          ? kwPBucket(enrichedRows, key, selectedK)
          : chiSquaredPBucket(enrichedRows, key, selectedK);
      } catch { result[key] = null; }
    });
    return result;
  }, [enrichedRows, columnDefs, selectedK]);

  const sortedCols = useMemo(() => {
    if (!sortBySig) return columnDefs;
    const order = { "p < 0.001": 0, "p < 0.01": 1, "p < 0.05": 2, "n.s.": 3 };
    return [...columnDefs].sort((a, b) => {
      const sa = sigMap[a.key]?.label ?? "n.s.";
      const sb = sigMap[b.key]?.label ?? "n.s.";
      return (order[sa] ?? 4) - (order[sb] ?? 4);
    });
  }, [columnDefs, sigMap, sortBySig]);

  const visibleClusters = useMemo(
    () => clusters.filter((c) => selectedClusters.has(c)),
    [clusters, selectedClusters]
  );

  const colorFn = useCallback(
    (c) => getEffectiveClusterColor(c, clusters.indexOf(c)),
    [getEffectiveClusterColor, clusters]
  );

  if (!metadataData) return null;

  return (
    <div style={{ padding: "16px 20px", overflowY: "auto", height: "100%" }}>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: fetchError ? "#f85149" : "#8b949e" }}>
          {loadingFull ? "Loading full metadata…" : fetchError ? `Error: ${fetchError}` : enrichedRows ? `${enrichedRows.length} sensors · ${sortedCols.length} columns` : ""}
        </span>
        <button
          onClick={() => setNormalize((v) => !v)}
          style={{ fontSize: 10, padding: "3px 10px", borderRadius: 4, border: `1px solid ${normalize ? "#457B9D" : "#3d4555"}`, background: normalize ? "#457B9D22" : "transparent", color: normalize ? "#4CC9F0" : "#8b949e", cursor: "pointer" }}
        >
          % Normalize
        </button>
        <button
          onClick={() => setSortBySig((v) => !v)}
          style={{ fontSize: 10, padding: "3px 10px", borderRadius: 4, border: `1px solid ${sortBySig ? "#2a9d8f" : "#3d4555"}`, background: sortBySig ? "#2a9d8f22" : "transparent", color: sortBySig ? "#2a9d8f" : "#8b949e", cursor: "pointer" }}
        >
          Sort by significance
        </button>
        {/* Cluster legend */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginLeft: "auto" }}>
          {visibleClusters.map((c) => (
            <span key={c} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#c9d1d9" }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: colorFn(c), display: "inline-block" }} />
              C{c}
            </span>
          ))}
        </div>
      </div>

      {!enrichedRows && !loadingFull && (
        <p style={{ color: "#8b949e", fontSize: 12 }}>No data loaded.</p>
      )}

      {/* Card grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
        {sortedCols.map(({ key, type }) => (
          <MetaCard
            key={`${key}-${selectedK}`}
            colKey={key}
            type={type}
            rows={enrichedRows}
            selectedK={selectedK}
            clusters={visibleClusters}
            allClusters={clusters}
            normalize={normalize}
            sig={sigMap[key]}
            colorFn={colorFn}
          />
        ))}
      </div>

      {/* Building cluster affinity panel */}
      <BuildingClusterPanel
        enrichedRows={enrichedRows}
        selectedK={selectedK}
        clusters={clusters}
        colorFn={colorFn}
        onNavigateToBuilding={onNavigateToBuilding}
      />
    </div>
  );
}

function MetaCard({ colKey, type, rows, selectedK, clusters, normalize, sig, colorFn }) {
  const barRef = useRef(null);
  const kdeRef = useRef(null);
  const boxRef = useRef(null);
  const isContinuous = type === "continuous";

  useEffect(() => {
    if (!rows?.length || !clusters?.length) return;
    // Double-rAF: first ensures layout pass, second ensures paint pass with correct clientWidth/clientHeight
    let outer, inner;
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        try {
          if (isContinuous) {
            renderMetaKDE(kdeRef.current, rows, colKey, selectedK, clusters, colorFn);
            renderMetaBoxPlots(boxRef.current, rows, colKey, selectedK, clusters, colorFn);
          } else {
            renderMetaStackedBars(barRef.current, rows, colKey, selectedK, clusters, normalize, colorFn);
          }
        } catch (e) { console.warn("MetaCard render error", colKey, e); }
      });
    });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [rows, colKey, selectedK, clusters, normalize, colorFn, isContinuous]);

  const canvasStyle = { width: "100%", display: "block", borderRadius: 4 };

  return (
    <div style={{ background: "#1d2232", border: "1px solid #2e3440", borderRadius: 8, padding: "10px 12px", overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: "#8b949e", fontFamily: "system-ui, sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "75%" }} title={colKey}>
          {colKey}
        </span>
        {sig && (
          <span style={{ fontSize: 9, color: sig.color, fontFamily: "system-ui, sans-serif", flexShrink: 0 }}>
            {sig.label}
          </span>
        )}
      </div>
      {isContinuous ? (
        <>
          <canvas ref={kdeRef} style={{ ...canvasStyle, height: "110px" }} />
          <canvas ref={boxRef} style={{ ...canvasStyle, height: "90px", marginTop: 4 }} />
        </>
      ) : (
        <canvas ref={barRef} style={{ ...canvasStyle, height: "160px" }} />
      )}
    </div>
  );
}

// ─── Cluster Profiles ────────────────────────────────────────────
function ClusterProfiles({ selectedK, clusters, selectedClusters, clusterGroups = [], getEffectiveClusterColor = getClusterColor, customColMapping = null }) {
  const [profileType, setProfileType] = useState("mean");
  const [profiles, setProfiles] = useState(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const canvasRef = useRef();

  useEffect(() => {
    if (!selectedK) return;
    const controller = new AbortController();
    setProfilesLoading(true);
    const req = customColMapping
      ? fetch(`${API}/api/custom-cluster-profiles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mapping: customColMapping }),
          signal: controller.signal,
        })
      : fetch(`${API}/api/cluster-profiles?${new URLSearchParams({ cluster_col: selectedK, agg: profileType })}`, { signal: controller.signal });
    req
      .then((r) => r.json())
      .then((data) => { setProfiles(data); setProfilesLoading(false); })
      .catch((e) => { if (e.name !== "AbortError") setProfilesLoading(false); });
    return () => controller.abort();
  }, [selectedK, profileType, customColMapping]);

  // Draw with canvas for performance
  useEffect(() => {
    if (!profiles || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const margin = { top: 30, right: 30, bottom: 50, left: 60 };
    const pw = w - margin.left - margin.right;
    const ph = h - margin.top - margin.bottom;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#1a1f2e";
    ctx.fillRect(0, 0, w, h);

    // Y scale uses ALL fetched profiles so toggling clusters doesn't rescale
    let allVals = [];
    Object.values(profiles.profiles).forEach((p) => {
      allVals.push(...p.values.filter((v) => v !== null));
      allVals.push(...p.q25.filter((v) => v !== null));
      allVals.push(...p.q75.filter((v) => v !== null));
    });
    if (allVals.length === 0) return;

    const yExtent = d3.extent(allVals);
    const yPad = (yExtent[1] - yExtent[0]) * 0.05;
    const xScale = d3.scaleLinear().domain([0, profiles.timestamps.length - 1]).range([margin.left, margin.left + pw]);
    const yScale = d3.scaleLinear().domain([yExtent[0] - yPad, yExtent[1] + yPad]).range([margin.top + ph, margin.top]);

    // Grid lines
    ctx.strokeStyle = "#252c3d";
    ctx.lineWidth = 1;
    const yTicks = yScale.ticks(6);
    yTicks.forEach((t) => {
      const y = yScale(t);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + pw, y);
      ctx.stroke();
    });

    // Y axis labels
    ctx.fillStyle = "#667";
    ctx.font = "11px monospace";
    ctx.textAlign = "right";
    yTicks.forEach((t) => {
      ctx.fillText(t.toFixed(1), margin.left - 8, yScale(t) + 4);
    });

    // X axis labels
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(profiles.timestamps.length / 8));
    for (let i = 0; i < profiles.timestamps.length; i += step) {
      const label = String(profiles.timestamps[i]).slice(0, 16);
      ctx.fillText(label, xScale(i), margin.top + ph + 20);
    }

    // Draw bands and lines
    clusters.forEach((c, ci) => {
      const p = profiles.profiles[String(c)];
      if (!selectedClusters.has(c) || !p) return;
      const color = getEffectiveClusterColor(c, ci);

      // IQR band
      ctx.fillStyle = color + "18";
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < p.q25.length; i++) {
        if (p.q25[i] === null) continue;
        const x = xScale(i);
        if (!started) { ctx.moveTo(x, yScale(p.q25[i])); started = true; }
        else ctx.lineTo(x, yScale(p.q25[i]));
      }
      for (let i = p.q75.length - 1; i >= 0; i--) {
        if (p.q75[i] === null) continue;
        ctx.lineTo(xScale(i), yScale(p.q75[i]));
      }
      ctx.closePath();
      ctx.fill();

      // Mean/median line
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      started = false;
      for (let i = 0; i < p.values.length; i++) {
        if (p.values[i] === null) continue;
        const x = xScale(i);
        const y = yScale(p.values[i]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    // Draw combined group lines (weighted mean of member profiles)
    clusterGroups.forEach((g, gi) => {
      const memberIds = [...g.memberIds].map(String);
      const memberProfiles = memberIds.map((id) => profiles.profiles[id]).filter(Boolean);
      const visibleMembers = memberProfiles.filter((_, j) => selectedClusters.has([...g.memberIds][j]));
      if (visibleMembers.length < 2) return;
      const n = profiles.timestamps.length;
      const combined = Array.from({ length: n }, (_, i) => {
        const vals = visibleMembers.map((p) => p.values[i]).filter((v) => v !== null);
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      });
      const color = GROUP_COLORS[gi % GROUP_COLORS.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 4]);
      ctx.beginPath();
      let started = false;
      combined.forEach((v, i) => {
        if (v === null) return;
        if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
        else ctx.lineTo(xScale(i), yScale(v));
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Legend
    let lx = margin.left + 10;
    let ly = margin.top + 10;
    clusters.forEach((c, ci) => {
      const p = profiles.profiles[String(c)];
      if (!selectedClusters.has(c) || !p) return;
      ctx.fillStyle = getEffectiveClusterColor(c, ci);
      ctx.fillRect(lx, ly, 12, 12);
      ctx.fillStyle = "#ccc";
      ctx.font = "11px monospace";
      ctx.textAlign = "left";
      const label = `Cluster ${c} (n=${p.count})`;
      ctx.fillText(label, lx + 16, ly + 10);
      lx += ctx.measureText(label).width + 36;
      if (lx > w - 150) { lx = margin.left + 10; ly += 18; }
    });
    // Group legend entries
    clusterGroups.forEach((g, gi) => {
      const color = GROUP_COLORS[gi % GROUP_COLORS.length];
      ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.setLineDash([8, 3]);
      ctx.beginPath(); ctx.moveTo(lx, ly + 6); ctx.lineTo(lx + 18, ly + 6); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ccc"; ctx.font = "11px monospace"; ctx.textAlign = "left";
      const label = `${g.name} (${[...g.memberIds].sort((a,b)=>a-b).join("+")})`;
      ctx.fillText(label, lx + 22, ly + 10);
      lx += ctx.measureText(label).width + 46;
      if (lx > w - 150) { lx = margin.left + 10; ly += 18; }
    });
  }, [profiles, selectedClusters, clusters, clusterGroups, getEffectiveClusterColor]);

  return (
    <div>
      <div style={styles.toolRow}>
        <span style={styles.toolLabel}>Profile Type:</span>
        {["mean", "median"].map((t) => (
          <button
            key={t}
            onClick={() => setProfileType(t)}
            style={{ ...styles.toolBtn, ...(profileType === t ? styles.toolBtnActive : {}) }}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
        {profilesLoading && <span style={{ ...styles.toolLabel, marginLeft: 12 }}>Loading…</span>}
      </div>
      <canvas ref={canvasRef} style={styles.canvas} width={900} height={420} />
    </div>
  );
}

// ─── Time Series View ────────────────────────────────────────────
function TimeSeriesView({ selectedK, clusters, selectedClusters, sensorClusterMap, sensorList, customColMapping = null }) {
  const canvasRef = useRef();
  const drillCanvasRef = useRef();
  const [showIndividual, setShowIndividual] = useState(false);
  const [drillClusters, setDrillClusters] = useState(new Set());
  const [selectedSensors, setSelectedSensors] = useState(new Set());
  const [sensorSearch, setSensorSearch] = useState("");
  const [overviewData, setOverviewData] = useState(null);
  const [sensorData, setSensorData] = useState(null);
  const [allDrillProfiles, setAllDrillProfiles] = useState(null);
  const [drillSensorData, setDrillSensorData] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(false);

  // Fetch cluster overview when cluster column changes (fetch all clusters for stable y scale)
  useEffect(() => {
    if (!selectedK) return;
    const controller = new AbortController();
    setOverviewLoading(true);
    const req = customColMapping
      ? fetch(`${API}/api/custom-timeseries-overview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mapping: customColMapping }),
          signal: controller.signal,
        })
      : fetch(`${API}/api/timeseries-overview?${new URLSearchParams({ cluster_col: selectedK })}`, { signal: controller.signal });
    req
      .then((r) => r.json())
      .then((data) => { setOverviewData(data); setOverviewLoading(false); })
      .catch((e) => { if (e.name !== "AbortError") setOverviewLoading(false); });
    return () => controller.abort();
  }, [selectedK, customColMapping]);

  // Fetch individual sensor data when selection changes
  useEffect(() => {
    if (selectedSensors.size === 0) { setSensorData(null); return; }
    const ids = [...selectedSensors].slice(0, 200).join(",");
    fetch(`${API}/api/sensor-timeseries?sensor_ids=${encodeURIComponent(ids)}`)
      .then((r) => r.json())
      .then(setSensorData)
      .catch(() => {});
  }, [selectedSensors]);

  // Fetch ALL cluster profiles for drill-down (for stable y scale)
  useEffect(() => {
    if (!selectedK) return;
    const controller = new AbortController();
    const req = customColMapping
      ? fetch(`${API}/api/custom-cluster-profiles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mapping: customColMapping }),
          signal: controller.signal,
        })
      : fetch(`${API}/api/cluster-profiles?${new URLSearchParams({ cluster_col: selectedK })}`, { signal: controller.signal });
    req
      .then((r) => r.json())
      .then(setAllDrillProfiles)
      .catch(() => {});
    return () => controller.abort();
  }, [selectedK, customColMapping]);

  // Fetch individual sensor timeseries for selected drill clusters
  useEffect(() => {
    if (drillClusters.size === 0) { setDrillSensorData(null); return; }
    const controller = new AbortController();
    const drillIds = sensorList
      .filter((s) => drillClusters.has(sensorClusterMap[s]))
      .slice(0, 200);
    if (drillIds.length > 0) {
      fetch(
        `${API}/api/sensor-timeseries?sensor_ids=${encodeURIComponent(drillIds.join(","))}`,
        { signal: controller.signal }
      )
        .then((r) => r.json())
        .then(setDrillSensorData)
        .catch(() => {});
    }
    return () => controller.abort();
  }, [drillClusters, sensorList, sensorClusterMap]);

  const filteredSensors = useMemo(() => {
    if (!sensorSearch) return sensorList.slice(0, 100);
    return sensorList.filter((s) => s.toLowerCase().includes(sensorSearch.toLowerCase())).slice(0, 100);
  }, [sensorList, sensorSearch]);

  const toggleSensor = (s) => {
    setSelectedSensors((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const toggleDrillCluster = (c) => {
    setDrillClusters((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  useEffect(() => {
    if (!overviewData || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const margin = { top: 20, right: 30, bottom: 50, left: 60 };
    const pw = w - margin.left - margin.right;
    const ph = h - margin.top - margin.bottom;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#1a1f2e";
    ctx.fillRect(0, 0, w, h);

    const timestamps = overviewData.timestamps;
    const xScale = d3.scaleLinear().domain([0, timestamps.length - 1]).range([margin.left, margin.left + pw]);

    // Y scale uses all fetched means so the axis stays stable when toggling clusters
    let allVals = [];
    Object.values(overviewData.cluster_means).forEach((vals) => {
      if (vals) allVals.push(...vals.filter((v) => v != null));
    });
    if (showIndividual && sensorData) {
      Object.values(sensorData.sensors).forEach((arr) => allVals.push(...arr.filter((v) => v != null)));
    }
    if (allVals.length === 0) return;

    const yExtent = d3.extent(allVals);
    const yPad = (yExtent[1] - yExtent[0]) * 0.05 || 1;
    const yScale = d3.scaleLinear().domain([yExtent[0] - yPad, yExtent[1] + yPad]).range([margin.top + ph, margin.top]);

    ctx.strokeStyle = "#252c3d";
    ctx.lineWidth = 1;
    yScale.ticks(6).forEach((t) => {
      ctx.beginPath(); ctx.moveTo(margin.left, yScale(t)); ctx.lineTo(margin.left + pw, yScale(t)); ctx.stroke();
    });
    ctx.fillStyle = "#667";
    ctx.font = "11px monospace";
    ctx.textAlign = "right";
    yScale.ticks(6).forEach((t) => ctx.fillText(t.toFixed(1), margin.left - 8, yScale(t) + 4));
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(timestamps.length / 8));
    for (let i = 0; i < timestamps.length; i += step) {
      ctx.fillText(String(timestamps[i]).slice(0, 16), xScale(i), margin.top + ph + 20);
    }

    clusters.forEach((c, ci) => {
      const means = overviewData.cluster_means[String(c)];
      if (!selectedClusters.has(c) || !means) return;
      ctx.strokeStyle = getClusterColor(ci);
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      means.forEach((v, i) => {
        if (v == null) return;
        if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
        else ctx.lineTo(xScale(i), yScale(v));
      });
      ctx.stroke();
    });

    if (showIndividual && sensorData) {
      [...selectedSensors].forEach((s) => {
        const vals = sensorData.sensors[s];
        if (!vals) return;
        const ci = clusters.indexOf(sensorClusterMap[s]);
        ctx.strokeStyle = (ci >= 0 ? getClusterColor(ci) : "#888") + "88";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        let started = false;
        vals.forEach((v, i) => {
          if (v == null || isNaN(v)) return;
          if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
          else ctx.lineTo(xScale(i), yScale(v));
        });
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }
  }, [overviewData, sensorData, selectedClusters, clusters, sensorClusterMap, selectedSensors, showIndividual]);

  // Drill-down chart: fetched sensor lines + cluster means
  useEffect(() => {
    if (!drillSensorData || !allDrillProfiles || !drillCanvasRef.current || drillClusters.size === 0) return;
    const canvas = drillCanvasRef.current;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const margin = { top: 20, right: 30, bottom: 50, left: 60 };
    const pw = w - margin.left - margin.right;
    const ph = h - margin.top - margin.bottom;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#1a1f2e";
    ctx.fillRect(0, 0, w, h);

    const timestamps = allDrillProfiles.timestamps;
    const xScale = d3.scaleLinear().domain([0, timestamps.length - 1]).range([margin.left, margin.left + pw]);

    // Y scale from ALL profiles (stable) + current sensor lines
    const allVals = [
      ...Object.values(allDrillProfiles.profiles).flatMap((p) => p.values),
      ...Object.values(drillSensorData.sensors).flat(),
    ].filter((v) => v != null && !isNaN(v));
    if (allVals.length === 0) return;

    const yExtent = d3.extent(allVals);
    const yPad = (yExtent[1] - yExtent[0]) * 0.05 || 1;
    const yScale = d3.scaleLinear().domain([yExtent[0] - yPad, yExtent[1] + yPad]).range([margin.top + ph, margin.top]);

    ctx.strokeStyle = "#252c3d";
    ctx.lineWidth = 1;
    yScale.ticks(6).forEach((t) => {
      ctx.beginPath(); ctx.moveTo(margin.left, yScale(t)); ctx.lineTo(margin.left + pw, yScale(t)); ctx.stroke();
    });
    ctx.fillStyle = "#667";
    ctx.font = "11px monospace";
    ctx.textAlign = "right";
    yScale.ticks(6).forEach((t) => ctx.fillText(t.toFixed(1), margin.left - 8, yScale(t) + 4));
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(timestamps.length / 8));
    for (let i = 0; i < timestamps.length; i += step) {
      ctx.fillText(String(timestamps[i]).slice(0, 16), xScale(i), margin.top + ph + 20);
    }

    // Individual sensor lines
    Object.entries(drillSensorData.sensors).forEach(([sensorId, vals]) => {
      const ci = clusters.indexOf(sensorClusterMap[sensorId]);
      ctx.strokeStyle = (ci >= 0 ? getClusterColor(ci) : "#888") + "40";
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      vals.forEach((v, i) => {
        if (v == null || isNaN(v)) return;
        if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
        else ctx.lineTo(xScale(i), yScale(v));
      });
      ctx.stroke();
    });

    // Cluster mean lines (dashed) — only selected drill clusters
    [...drillClusters].forEach((clusterId) => {
      const p = allDrillProfiles.profiles[String(clusterId)];
      if (!p) return;
      const ci = clusters.indexOf(clusterId);
      ctx.strokeStyle = getClusterColor(ci);
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      let started = false;
      p.values.forEach((v, i) => {
        if (v === null) return;
        if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
        else ctx.lineTo(xScale(i), yScale(v));
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }, [drillSensorData, allDrillProfiles, drillClusters, clusters, sensorClusterMap]);

  return (
    <div>
      {/* ── Chart 1: Cluster averages ── */}
      <div style={styles.toolRow}>
        {overviewLoading && <span style={styles.toolLabel}>Loading…</span>}
        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={showIndividual}
            onChange={(e) => setShowIndividual(e.target.checked)}
            style={styles.checkbox}
          />
          Overlay individual sensors
        </label>
      </div>
      <canvas ref={canvasRef} style={styles.canvas} width={900} height={420} />
      {showIndividual && (
        <div style={styles.sensorPicker}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              type="text"
              placeholder="Search sensors..."
              value={sensorSearch}
              onChange={(e) => setSensorSearch(e.target.value)}
              style={{ ...styles.searchInput, marginBottom: 0, flex: 1 }}
            />
            <button onClick={() => setSelectedSensors(new Set(sensorList))} style={styles.miniBtn}>Select all</button>
            <button onClick={() => setSelectedSensors(new Set())} style={styles.miniBtn}>Clear</button>
          </div>
          <div style={styles.sensorList}>
            {filteredSensors.map((s) => (
              <button
                key={s}
                onClick={() => toggleSensor(s)}
                style={{
                  ...styles.sensorChip,
                  backgroundColor: selectedSensors.has(s) ? getClusterColor(clusters.indexOf(sensorClusterMap[s])) : "transparent",
                  borderColor: selectedSensors.has(s) ? getClusterColor(clusters.indexOf(sensorClusterMap[s])) : "#333",
                  color: selectedSensors.has(s) ? "#fff" : "#8b949e",
                }}
              >
                {s}
              </button>
            ))}
            {filteredSensors.length === 100 && <span style={styles.moreHint}>Showing first 100 results...</span>}
          </div>
          {selectedSensors.size > 0 && (
            <span style={styles.toolLabel}>Selected: {selectedSensors.size} sensors</span>
          )}
        </div>
      )}

      {/* ── Chart 2: Cluster drill-down ── */}
      <div style={{ marginTop: 32, borderTop: "1px solid #2e3440", paddingTop: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <span style={styles.toolLabel}>Cluster drill-down:</span>
          {clusters.map((c, i) => (
            <button
              key={c}
              onClick={() => toggleDrillCluster(c)}
              style={{
                ...styles.chip,
                backgroundColor: drillClusters.has(c) ? getClusterColor(i) : "transparent",
                borderColor: getClusterColor(i),
                color: drillClusters.has(c) ? "#fff" : "#8b949e",
              }}
            >
              Cluster {c}
            </button>
          ))}
          {drillClusters.size > 0 && (
            <button onClick={() => setDrillClusters(new Set())} style={styles.miniBtn}>Clear</button>
          )}
        </div>
        {drillClusters.size > 0 && (
          <>
            <p style={styles.mapInfo}>
              {drillSensorData ? `${Object.keys(drillSensorData.sensors).length} sensors` : "Loading sensor lines…"} — individual lines colored by cluster, dashed = cluster mean
            </p>
            <canvas ref={drillCanvasRef} style={styles.canvas} width={900} height={420} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Stacked bar chart helper (used by Stats tab) ─────────────────
function renderStackedBars(canvas, { labels, counts }, title, clusters, viewClusterIds, rotateLabels = false, colorFn = getClusterColor) {
  if (!canvas || !labels.length) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);
  const margin = { top: 22, right: 16, bottom: rotateLabels ? 72 : 32, left: 36 };
  const pw = w - margin.left - margin.right, ph = h - margin.top - margin.bottom;
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#1a1f2e"; ctx.fillRect(0, 0, w, h);

  const viewCids = [...viewClusterIds].sort();
  const totals = labels.map((l) => viewCids.reduce((s, cid) => s + ((counts[l] || {})[cid] || 0), 0));
  const maxVal = Math.max(...totals, 1);
  const gap = 3;
  const barW = Math.max(4, pw / labels.length - gap);

  // Grid lines
  ctx.strokeStyle = "#252c3d"; ctx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach((pct) => {
    const y = margin.top + ph * (1 - pct);
    ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + pw, y); ctx.stroke();
    ctx.fillStyle = "#555"; ctx.font = "9px monospace"; ctx.textAlign = "right";
    ctx.fillText(Math.round(pct * maxVal), margin.left - 3, y + 3);
  });

  // Bars
  labels.forEach((label, i) => {
    const x = margin.left + i * (barW + gap);
    let y = margin.top + ph;
    viewCids.forEach((cid) => {
      const count = (counts[label] || {})[cid] || 0;
      if (!count) return;
      const barH = Math.max(1, (count / maxVal) * ph);
      const ci = clusters.indexOf(Number(cid));
      ctx.fillStyle = colorFn(Number(cid), ci);
      ctx.fillRect(x, y - barH, barW, barH);
      y -= barH;
    });
    // X label
    ctx.fillStyle = "#667"; ctx.font = "9px monospace";
    if (rotateLabels) {
      ctx.save(); ctx.translate(x + barW / 2, margin.top + ph + 6); ctx.rotate(Math.PI / 4);
      ctx.textAlign = "left"; ctx.fillText(String(label), 0, 0); ctx.restore();
    } else {
      ctx.textAlign = "center"; ctx.fillText(String(label), x + barW / 2, margin.top + ph + 14);
    }
  });

  // Title
  ctx.fillStyle = "#8b949e"; ctx.font = "10px monospace"; ctx.textAlign = "left";
  ctx.fillText(title, margin.left, 14);
}

// ─── Year KDE chart helper ────────────────────────────────────────
function renderYearDensity(canvas, yearByCluster, clusters, viewClusterIds, colorFn = getClusterColor) {
  if (!canvas || !yearByCluster) return;
  const allYears = Object.values(yearByCluster).flat();
  if (!allYears.length) return;

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);

  const margin = { top: 22, right: 16, bottom: 36, left: 36 };
  const pw = w - margin.left - margin.right, ph = h - margin.top - margin.bottom;
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#1a1f2e"; ctx.fillRect(0, 0, w, h);

  const yMin = Math.floor(Math.min(...allYears) / 10) * 10 - 5;
  const yMax = Math.ceil(Math.max(...allYears) / 10) * 10 + 5;
  const xGrid = d3.range(yMin, yMax + 1, 1);
  const xScale = d3.scaleLinear().domain([yMin, yMax]).range([margin.left, margin.left + pw]);

  // KDE per cluster (Gaussian kernel, Silverman bandwidth)
  const gaussian = (u) => Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
  const densities = {};
  [...viewClusterIds].forEach((cid) => {
    const data = yearByCluster[cid];
    if (!data?.length) return;
    const std = d3.deviation(data) || 10;
    const bw = Math.max(3, 1.06 * std * Math.pow(data.length, -0.2));
    densities[cid] = xGrid.map((x) => d3.mean(data, (v) => gaussian((x - v) / bw) / bw));
  });

  const maxDensity = Math.max(...Object.values(densities).flat(), 1e-9);
  const yScale = d3.scaleLinear().domain([0, maxDensity * 1.1]).range([margin.top + ph, margin.top]);

  // Grid
  ctx.strokeStyle = "#252c3d"; ctx.lineWidth = 1;
  yScale.ticks(4).forEach((t) => {
    ctx.beginPath(); ctx.moveTo(margin.left, yScale(t)); ctx.lineTo(margin.left + pw, yScale(t)); ctx.stroke();
  });

  // X decade labels
  ctx.fillStyle = "#667"; ctx.font = "9px monospace"; ctx.textAlign = "center";
  for (let yr = Math.ceil(yMin / 10) * 10; yr <= yMax; yr += 10)
    ctx.fillText(yr, xScale(yr), margin.top + ph + 14);

  // KDE fills + lines
  [...viewClusterIds].sort().forEach((cid) => {
    const pts = densities[cid];
    if (!pts) return;
    const ci = clusters.indexOf(Number(cid));
    const color = colorFn(Number(cid), ci);
    const [r, g, b] = hexToRgb(color);

    ctx.beginPath();
    ctx.moveTo(xScale(xGrid[0]), yScale(0));
    pts.forEach((y, i) => ctx.lineTo(xScale(xGrid[i]), yScale(y)));
    ctx.lineTo(xScale(xGrid[xGrid.length - 1]), yScale(0));
    ctx.closePath();
    ctx.fillStyle = `rgba(${r},${g},${b},0.12)`;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((y, i) => { if (i === 0) ctx.moveTo(xScale(xGrid[i]), yScale(y)); else ctx.lineTo(xScale(xGrid[i]), yScale(y)); });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  });

  // Rug marks
  [...viewClusterIds].forEach((cid) => {
    const data = yearByCluster[cid];
    if (!data?.length) return;
    const ci = clusters.indexOf(Number(cid));
    const color = colorFn(Number(cid), ci);
    const [r, g, b] = hexToRgb(color);
    ctx.strokeStyle = `rgba(${r},${g},${b},0.5)`; ctx.lineWidth = 1;
    data.forEach((yr) => {
      const x = xScale(yr);
      ctx.beginPath(); ctx.moveTo(x, margin.top + ph); ctx.lineTo(x, margin.top + ph + 5); ctx.stroke();
    });
  });

  // Title
  ctx.fillStyle = "#8b949e"; ctx.font = "10px monospace"; ctx.textAlign = "left";
  ctx.fillText("Construction year (Nybyggnadsår)", margin.left, 14);
}

// ─── Map View ────────────────────────────────────────────────────
function MapView({ metadataData, selectedK, clusters, selectedClusters, sensorIdCol, clusterGroups = [], getEffectiveClusterColor = getClusterColor, customClusterCols = {}, navigateToBuilding = null }) {
  const deckContainerRef = useRef();
  const mapRef = useRef();
  const boxOverlayRef = useRef();
  const boxStartRef = useRef(null);

  // ViewState — initialised to fit all sensors
  const [viewState, setViewState] = useState(() => {
    if (!metadataData?.length) return { longitude: 0, latitude: 0, zoom: 4, pitch: 0, bearing: 0 };
    const lats = metadataData.filter((r) => r.lat != null).map((r) => r.lat);
    const lons = metadataData.filter((r) => r.lon != null).map((r) => r.lon);
    if (!lats.length) return { longitude: 0, latitude: 0, zoom: 4, pitch: 0, bearing: 0 };
    try {
      const vp = new WebMercatorViewport({ width: 800, height: 560 });
      const { longitude, latitude, zoom } = vp.fitBounds(
        [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: 40 }
      );
      return { longitude, latitude, zoom: Math.min(zoom + 1, 15), pitch: 50, bearing: -15 };
    } catch { return { longitude: 0, latitude: 0, zoom: 4, pitch: 0, bearing: 0 }; }
  });

  const [mapStyleId, setMapStyleId] = useState("dark");
  const [boxZoomActive, setBoxZoomActive] = useState(false);
  const [boxRect, setBoxRect] = useState(null);
  const [mode3D, setMode3D] = useState(true);
  const [useParquetCoords, setUseParquetCoords] = useState(true);
  const [colorByMetric, setColorByMetric] = useState(null);
  const [pointHeights, setPointHeights] = useState({});
  const [buildings3D, setBuildings3D] = useState(null);


  const [sunTimeIdx, setSunTimeIdx] = useState(null); // index into allClusterProfiles.timestamps
  const [showSunArc, setShowSunArc] = useState(false);
  const [showOutdoorOverlay, setShowOutdoorOverlay] = useState(false);
  const [xZoom, setXZoom] = useState(null); // { lo, hi } index range, or null = full range
  const [tallPlots, setTallPlots] = useState(false);
  const brushRef = useRef(null);
  const [brushOverlay, setBrushOverlay] = useState(null); // { startFrac, curFrac } while dragging
  const [wideMap, setWideMap] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1); // steps per second
  const playIntervalRef = useRef(null);
  const [strangData, setStrangData] = useState(null);
  const [outdoorClimate, setOutdoorClimate] = useState(null); // { year, timestamps, temperature, humidity, global_irradiation }
  const outdoorChartRef = useRef();
  const [outdoorSensors, setOutdoorSensors] = useState(null);   // [{sensor_id, lat, lon, address}]
  const [outdoorTimeseries, setOutdoorTimeseries] = useState(null); // {timestamps, sensors, _year}
  const [showOutdoorSensors, setShowOutdoorSensors] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);

  const [analysedSensors, setAnalysedSensors] = useState(null);
  const [allClusterProfiles, setAllClusterProfiles] = useState(null);
  const [mapSensorData, setMapSensorData] = useState(null);
  const [mapProfilesLoading, setMapProfilesLoading] = useState(false);
  const [sensorProperties, setSensorProperties] = useState(null);
  const [analysisTab, setAnalysisTab] = useState("profiles");
  const [selectedBuildings, setSelectedBuildings] = useState(new Set());
  const [buildingTimeseries, setBuildingTimeseries] = useState(null);
  const [buildingGeometry, setBuildingGeometry] = useState(null);
  const [buildingSearch, setBuildingSearch] = useState("");
  const canvasRef = useRef();
  const sensorCanvasRef = useRef();
  const outdoorSensorsCanvasRef = useRef();
  const irradianceChartRef = useRef(); // wrapper div for playhead x-position calc
  const floorCanvasRef = useRef();
  const yearCanvasRef = useRef();
  const periodCanvasRef = useRef();
  const typeCanvasRef = useRef();
  const buildingCanvasRef = useRef();

  // Fetch full cluster profiles (for stable, representative means)
  useEffect(() => {
    if (!selectedK) return;
    const controller = new AbortController();
    const customMap = customClusterCols[selectedK];
    const req = customMap
      ? fetch(`${API}/api/custom-cluster-profiles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mapping: customMap }),
          signal: controller.signal,
        })
      : fetch(`${API}/api/cluster-profiles?${new URLSearchParams({ cluster_col: selectedK })}`, { signal: controller.signal });
    req
      .then((r) => { if (r.ok) return r.json(); throw new Error(`HTTP ${r.status}`); })
      .then((d) => { if (d?.timestamps) setAllClusterProfiles(d); })
      .catch(() => {});
    return () => controller.abort();
  }, [selectedK, customClusterCols]);

  // Shadow refs so the selectedK-change effect can read current prop values without
  // those props being in its dependency array (avoids spurious re-runs).
  const metadataRef = useRef(metadataData);
  useEffect(() => { metadataRef.current = metadataData; }, [metadataData]);
  const sensorIdColRef = useRef(sensorIdCol);
  useEffect(() => { sensorIdColRef.current = sensorIdCol; }, [sensorIdCol]);
  const customClusterColsRef = useRef(customClusterCols);
  useEffect(() => { customClusterColsRef.current = customClusterCols; }, [customClusterCols]);

  // Cross-tab navigation from Metadata Statistics: fly to the building location.
  // The user then clicks the building on the map to select it and load data.
  useEffect(() => {
    if (!navigateToBuilding) return;
    const { lat, lon } = navigateToBuilding;
    if (lat != null && lon != null) {
      setViewState((vs) => ({
        ...vs, latitude: lat, longitude: lon, zoom: 17, pitch: 60,
        transitionDuration: 1500, transitionInterpolator: new FlyToInterpolator(),
      }));
    }
  }, [navigateToBuilding]);

  // When the cluster assignment column changes, refresh cluster values in-place so
  // building selection and time-series data are preserved — no need to re-run Analyse View.
  const prevSelectedKRef = useRef(selectedK);
  useEffect(() => {
    if (prevSelectedKRef.current === selectedK) return;
    prevSelectedKRef.current = selectedK;
    setXZoom(null);
    setSunTimeIdx(null);
    // allClusterProfiles re-fetches via its own effect; don't null it here
    // so the building chart stays visible while new profiles load

    // Re-map cluster IDs in analysedSensors to the new column
    const meta = metadataRef.current;
    const idCol = sensorIdColRef.current;
    if (meta && idCol) {
      const clusterMap = {};
      meta.forEach((r) => { clusterMap[r[idCol]] = r[selectedK] ?? null; });
      setAnalysedSensors((prev) =>
        prev?.map((s) => ({ ...s, cluster: clusterMap[s.id] ?? null })) ?? null
      );
    }

    // For custom cluster cols, add the new column to sensorProperties if not already there
    const customMap = customClusterColsRef.current?.[selectedK];
    if (customMap) {
      setSensorProperties((prev) => {
        if (!prev?.length) return prev;
        // Skip if column already present (avoids re-triggering buildingTimeseries fetch)
        if (selectedK in prev[0]) return prev;
        return prev.map((s) => ({ ...s, [selectedK]: customMap[s.sensor_id] ?? null }));
      });
    }
  }, [selectedK]);

  // ── Filters ──
  const [filterOptions, setFilterOptions] = useState(null);
  const [activeFilters, setActiveFilters] = useState({});
  const [minBuildingFloors, setMinBuildingFloors] = useState(0);
  const [filteredIds, setFilteredIds] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    fetchData("/api/filter-options").then(setFilterOptions).catch(() => {});
    fetchData("/api/point-heights").then(setPointHeights).catch(() => {});
  }, []);

  // Fetch all building footprints once when entering 3D mode
  useEffect(() => {
    if (!mode3D) { setBuildings3D(null); return; }
    fetchData("/api/all-buildings").then(setBuildings3D).catch(() => {});
  }, [mode3D]);


  useEffect(() => {
    const active = Object.entries(activeFilters).filter(([, s]) => s.size > 0);
    if (active.length === 0 && minBuildingFloors === 0) { setFilteredIds(null); return; }
    const params = new URLSearchParams();
    active.forEach(([field, vals]) => params.set(field, [...vals].join(",")));
    if (minBuildingFloors > 0) params.set("min_building_floors", minBuildingFloors);
    fetchData(`/api/filtered-sensor-ids?${params}`)
      .then((d) => setFilteredIds(d.sensor_ids ? new Set(d.sensor_ids) : null))
      .catch(() => {});
  }, [activeFilters, minBuildingFloors]);

  const toggleFilterValue = (field, value) => {
    setActiveFilters((prev) => {
      const next = { ...prev };
      const s = new Set(next[field] || []);
      if (s.has(value)) s.delete(value); else s.add(value);
      next[field] = s;
      return next;
    });
  };
  const clearFilters = () => { setActiveFilters({}); setMinBuildingFloors(0); setFilteredIds(null); };
  const activeFilterCount = Object.values(activeFilters).reduce((n, s) => n + s.size, 0) + (minBuildingFloors > 0 ? 1 : 0);

  // ── Sensor data ──
  const sensorLocations = useMemo(() => {
    if (!metadataData) return [];
    return metadataData
      .filter((r) =>
        r.lat != null && r.lon != null &&
        selectedClusters.has(r[selectedK]) &&
        (filteredIds === null || filteredIds.has(r[sensorIdCol]))
      )
      .map((r) => {
        const h = pointHeights[r[sensorIdCol]];
        const elevation = h && h.lm_height != null && h.lm_max_floor != null && h.lm_max_floor > 0
          ? (Math.min(h.floor ?? 0, h.lm_max_floor) / h.lm_max_floor) * h.lm_height
          : 0;
        const lat = (useParquetCoords && h?.lat != null) ? h.lat : r.lat;
        const lon = (useParquetCoords && h?.lon != null) ? h.lon : r.lon;
        return { id: r[sensorIdCol], lat, lon, cluster: r[selectedK], elevation };
      });
  }, [metadataData, selectedK, selectedClusters, sensorIdCol, filteredIds, pointHeights, useParquetCoords]);

  const visibleSensors = useMemo(() => {
    if (!deckContainerRef.current) return sensorLocations;
    const { clientWidth: w, clientHeight: h } = deckContainerRef.current;
    if (!w || !h) return sensorLocations;
    try {
      const vp = new WebMercatorViewport({ ...viewState, width: w, height: h });
      const [west, south] = vp.unproject([0, h]);
      const [east, north] = vp.unproject([w, 0]);
      return sensorLocations.filter((d) => d.lat >= south && d.lat <= north && d.lon >= west && d.lon <= east);
    } catch { return sensorLocations; }
  }, [sensorLocations, viewState]);

  const sensorPropLookup = useMemo(() => {
    if (!Array.isArray(sensorProperties)) return {};
    const map = {};
    sensorProperties.forEach((s) => { map[s.sensor_id] = s; });
    return map;
  }, [sensorProperties]);

  const buildingHighlightIds = useMemo(() => {
    if (selectedBuildings.size === 0 || !Array.isArray(sensorProperties)) return null;
    return new Set(
      sensorProperties
        .filter((s) => selectedBuildings.has(s["lm_building_id"] || "Unknown"))
        .map((s) => s.sensor_id)
    );
  }, [selectedBuildings, sensorProperties]);

  // Sensor properties filtered to selected building (drives stats + profiles when building active)
  const activeSensorProperties = useMemo(() => {
    if (!Array.isArray(sensorProperties)) return sensorProperties;
    if (selectedBuildings.size === 0) return sensorProperties;
    return sensorProperties.filter((s) => selectedBuildings.has(s["lm_building_id"] || "Unknown"));
  }, [sensorProperties, selectedBuildings]);

  // ── Metric color map (sensor_id → [r,g,b]) for continuous coloring ──
  const metricColorMap = useMemo(() => {
    if (!colorByMetric || !sensorProperties) return null;
    const vals = sensorProperties
      .map((s) => ({ id: s.sensor_id, v: Number(s[colorByMetric]) }))
      .filter((x) => !isNaN(x.v));
    if (!vals.length) return null;
    const min = Math.min(...vals.map((x) => x.v));
    const max = Math.max(...vals.map((x) => x.v));
    const range = max - min || 1;
    const map = {};
    vals.forEach(({ id, v }) => {
      const t = (v - min) / range;
      // cool blue → yellow → hot red
      const r = t < 0.5 ? Math.round(76 + (255 - 76) * t * 2) : 255;
      const g = Math.round(t < 0.5 ? 201 * (1 - t * 2) + 217 * t * 2 : 217 * (1 - (t - 0.5) * 2));
      const b = t < 0.5 ? Math.round(240 * (1 - t * 2)) : 0;
      map[id] = [r, g, b];
    });
    return map;
  }, [colorByMetric, sensorProperties]);

  // ── Solar lighting ────────────────────────────────────────────────────────────
  // Seed sunTimeIdx to the first timestamp near 12:00 local time once data arrives.
  useEffect(() => {
    if (allClusterProfiles?.timestamps?.length && sunTimeIdx === null) {
      const ts = allClusterProfiles.timestamps;
      // Find the index whose local hour is closest to 12
      const noonIdx = ts.reduce((best, t, i) => {
        const hour = new Date(t).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", hour12: false });
        const diff = Math.abs(Number(hour) - 12);
        return diff < best.diff ? { i, diff } : best;
      }, { i: 0, diff: Infinity }).i;
      setSunTimeIdx(noonIdx);
    }
  }, [allClusterProfiles, sunTimeIdx]);

  // Playback: advance sunTimeIdx at playSpeed steps/second; stop at end.
  useEffect(() => {
    clearInterval(playIntervalRef.current);
    if (!isPlaying || !allClusterProfiles?.timestamps?.length) return;
    const intervalMs = 1000 / playSpeed;
    playIntervalRef.current = setInterval(() => {
      setSunTimeIdx((idx) => {
        const max = allClusterProfiles.timestamps.length - 1;
        if (idx >= max) { setIsPlaying(false); return max; }
        return idx + 1;
      });
    }, intervalMs);
    return () => clearInterval(playIntervalRef.current);
  }, [isPlaying, playSpeed, allClusterProfiles]);

  // Fetch SMHI STRÅNG irradiance for the date range covered by the loaded time series.
  useEffect(() => {
    if (!allClusterProfiles?.timestamps?.length) return;
    const ts = allClusterProfiles.timestamps;
    const fromDate = new Date(ts[0]).toISOString().slice(0, 10);
    // Add one day to toDate: the API returns entries up to toDate T00:00 only,
    // so the last day's daytime hours would be missing without this.
    const toDate = new Date(new Date(ts[ts.length - 1]).getTime() + 86400000).toISOString().slice(0, 10);
    fetchStrangData(fromDate, toDate).then(setStrangData);
  }, [allClusterProfiles]);

  // Fetch outdoor sensor locations once on mount
  useEffect(() => {
    fetchData("/api/outdoor-sensors")
      .then(setOutdoorSensors)
      .catch(() => {});
  }, []);

  // Fetch outdoor sensor timeseries (lazy — only when overlay or heatmap is enabled)
  useEffect(() => {
    if (!allClusterProfiles?.timestamps?.length) return;
    if (!showOutdoorSensors && !showHeatmap) return;
    const year = new Date(allClusterProfiles.timestamps[0]).getFullYear();
    if (outdoorTimeseries?._year === year) return;
    fetchData(`/api/outdoor-timeseries?year=${year}`)
      .then((d) => { if (d?.timestamps) setOutdoorTimeseries({ ...d, _year: year }); })
      .catch(() => {});
  }, [allClusterProfiles, showOutdoorSensors, showHeatmap, outdoorTimeseries?._year]);

  // Fetch outdoor climate (temperature, humidity, station irradiance) for the data year.
  useEffect(() => {
    if (!allClusterProfiles?.timestamps?.length) return;
    const year = new Date(allClusterProfiles.timestamps[0]).getUTCFullYear();
    if (outdoorClimate?.year === year) return; // already loaded
    fetchData(`/api/outdoor-climate?year=${year}`)
      .then(setOutdoorClimate)
      .catch(() => {});
  }, [allClusterProfiles, outdoorClimate?.year]);

  // Derive the Unix-ms timestamp for the sun from the loaded time series, or
  // fall back to a fixed June noon so lighting always looks reasonable.
  const sunTimestampMs = useMemo(() => {
    if (sunTimeIdx !== null && allClusterProfiles?.timestamps?.[sunTimeIdx]) {
      return new Date(allClusterProfiles.timestamps[sunTimeIdx]).getTime();
    }
    return Date.UTC(2024, 5, 21, 12); // fallback: midsummer noon
  }, [sunTimeIdx, allClusterProfiles]);

  // deck.gl's LightingEffect is NOT reactive — create a new one whenever the
  // timestamp changes.  useMemo ensures we only re-create on actual changes.
  const sunInfo = useMemo(() => getSunInfo(sunTimestampMs), [sunTimestampMs]);

  // W/m² from STRÅNG for the current scrubber position; null when unavailable.
  const irradiance = useMemo(
    () => getIrradiance(sunTimestampMs, strangData),
    [sunTimestampMs, strangData],
  );

  // Linearly interpolate a named series from outdoorClimate at sunTimestampMs.
  const interpOutdoor = useCallback((series) => {
    if (!outdoorClimate?.timestamps?.length) return null;
    const tms = outdoorClimate.timestamps;
    const vals = outdoorClimate[series];
    // Binary search for bracketing indices
    let lo = 0, hi = tms.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (new Date(tms[mid]).getTime() <= sunTimestampMs) lo = mid; else hi = mid;
    }
    const t0 = new Date(tms[lo]).getTime(), t1 = new Date(tms[hi]).getTime();
    const v0 = vals[lo], v1 = vals[hi];
    if (v0 == null && v1 == null) return null;
    if (v0 == null) return v1;
    if (v1 == null) return v0;
    if (t1 === t0) return v0;
    const f = (sunTimestampMs - t0) / (t1 - t0);
    return v0 + f * (v1 - v0);
  }, [outdoorClimate, sunTimestampMs]);

  const outdoorTemp = useMemo(() => interpOutdoor("temperature"), [interpOutdoor]);
  const outdoorRH   = useMemo(() => interpOutdoor("humidity"),    [interpOutdoor]);

  const lightingEffect = useMemo(() => {
    const alt = sunInfo.altitude; // degrees above horizon

    // horizonBlend: 0 below -5°, ramps to 1 above +5° — smooth dusk/dawn transition.
    // Without this, ambient jumps hard at alt=0 and creates a visible "light bump".
    const horizonBlend = Math.max(0, Math.min(1, (alt + 5) / 10));
    // dayT: 0 at horizon, 1 at 45°+ — drives mid-day intensity.
    const dayT = Math.max(0, Math.min(1, alt / 45));

    // Ambient: 0.8 at night/horizon, 0.4 at noon. No night boost — level never rises
    // below horizon, so there is no brightness bump when the sun sets.
    const ambientIntensity = 0.8 - dayT * 0.4;

    // Geometric sun intensity (altitude-based only)
    const geoSunIntensity = horizonBlend * (0.8 + dayT * 1.2);

    // SMHI STRÅNG modulation: scale sun intensity by measured irradiance.
    // Peak Gothenburg summer GHI ~850 W/m² → factor 1.0; 0 W/m² → 0.
    // When data is unavailable, fall back to geometric-only (factor 1).
    const irradianceFactor = irradiance !== null ? Math.min(1, irradiance / 850) : 1;
    const sunIntensity = geoSunIntensity * irradianceFactor;

    // Detect overcast: irradiance well below what clear-sky geometry predicts.
    // Threshold: actual < 30% of estimated clear-sky (and sky is lit enough to matter).
    const clearSky = clearSkyEstimate(alt);
    const isOvercast = irradiance !== null && clearSky > 80 && irradiance < clearSky * 0.3;

    // Overcast → raise ambient and tint blue-grey (diffuse skylight feel).
    const ambientColor = isOvercast ? [200, 215, 240] : [255, 255, 255];
    const effectiveAmbient = isOvercast ? Math.min(1.0, ambientIntensity * 1.4) : ambientIntensity;

    // Colour: cool blue-white night → deep gold at horizon → warm white noon.
    const sunColor = [
      Math.min(255, Math.round(200 + horizonBlend * 55)),                       // 200 → 255
      Math.min(255, Math.round(220 + horizonBlend * (dayT * 80 - 45))),         // 220 → 175 → 255
      Math.min(255, Math.round(255 + horizonBlend * (dayT * 150 - 175))),       // 255 → 80 → 230
    ];

    // NOTE: _shadow is intentionally omitted. deck.gl v9's experimental shadow
    // system injects shadow shader code into all layer pipelines and causes
    // consistent "Bad texture binding for shadow_uShadowMap0" errors on
    // SimpleMeshLayer and SolidPolygonLayer sublayers that can't be suppressed
    // at the application level. Directional shading on building faces still works.

    const ambientLight = new AmbientLight({ color: ambientColor, intensity: effectiveAmbient });
    const sunLight = new SunLight({ timestamp: sunTimestampMs, color: sunColor, intensity: sunIntensity });
    return new LightingEffect({ ambientLight, sunLight });
  }, [sunInfo, sunTimestampMs, irradiance]);

  // ── Sun arc layers (3D sky dome showing today's sun path) ──
  const sunArcLayers = useMemo(() => {
    if (!showSunArc || !mode3D) return [];

    const R = 800; // sky dome radius in metres
    const DEG2RAD = Math.PI / 180;
    const clat = viewState.latitude;
    const clng = viewState.longitude;
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(clat * DEG2RAD);

    // Convert azimuth (°, N=0 CW) + altitude (°) → [lng, lat, elevation_m]
    const toPos = (azimuth, altitude) => {
      const az  = azimuth  * DEG2RAD;
      const alt = altitude * DEG2RAD;
      const horiz = R * Math.cos(alt);
      return [
        clng + (horiz * Math.sin(az)) / mPerDegLng,
        clat + (horiz * Math.cos(az)) / mPerDegLat,
        Math.max(0, R * Math.sin(alt)),
      ];
    };

    const path = getSunPath(sunTimestampMs);
    if (!path.length) return [];

    // Build per-segment data so each segment can be colour-coded by altitude
    const segments = [];
    for (let i = 0; i < path.length - 1; i++) {
      segments.push({
        from: toPos(path[i].azimuth, path[i].altitude),
        to:   toPos(path[i + 1].azimuth, path[i + 1].altitude),
        alt:  (path[i].altitude + path[i + 1].altitude) / 2,
      });
    }

    const arcLayer = new LineLayer({
      id: "sun-path-arc",
      data: segments,
      getSourcePosition: (d) => d.from,
      getTargetPosition: (d) => d.to,
      getColor: (d) => {
        // orange at horizon → yellow-white at peak altitude (~50° midsummer)
        const t = Math.max(0, Math.min(1, d.alt / 50));
        return [255, Math.round(120 + t * 120), Math.round(t * 30), 210];
      },
      getWidth: 3,
      widthUnits: "pixels",
      widthMinPixels: 2,
    });

    const ls = [arcLayer];

    // Bright disc at the current sun position (only when above horizon)
    if (sunInfo.isAboveHorizon) {
      ls.push(new ScatterplotLayer({
        id: "sun-marker",
        data: [{ position: toPos(sunInfo.azimuth, sunInfo.altitude) }],
        getPosition: (d) => d.position,
        getFillColor: [255, 230, 60, 255],
        getLineColor:  [255, 255, 255, 180],
        stroked: true,
        lineWidthMinPixels: 2,
        getRadius: 14,
        radiusUnits: "pixels",
        parameters: { depthTest: false }, // always on top — not occluded by buildings
      }));
    }

    return ls;
  }, [showSunArc, mode3D, sunTimestampMs, sunInfo, viewState.latitude, viewState.longitude]);

  // Fixed summer temperature range for a consistent color scale
  const outdoorTempRange = { min: 5, max: 35 };

  // Per-sensor temperature at the current sun timestamp, for the colored scatter layer
  const tempPoints = useMemo(() => {
    if (!showHeatmap || !outdoorSensors?.length || !outdoorTimeseries?.timestamps?.length || sunTimeIdx === null || !allClusterProfiles?.timestamps) return null;
    const sunMs = new Date(allClusterProfiles.timestamps[sunTimeIdx]).getTime();
    const odTms = outdoorTimeseries.timestamps.map((t) => new Date(t).getTime());
    let bestIdx = 0, bestDiff = Infinity;
    odTms.forEach((t, i) => { const d = Math.abs(t - sunMs); if (d < bestDiff) { bestDiff = d; bestIdx = i; } });
    return outdoorSensors.flatMap((s) => {
      const temp = outdoorTimeseries.sensors[s.sensor_id]?.[bestIdx];
      return temp != null ? [{ position: [s.lon, s.lat], temp }] : [];
    });
  }, [showHeatmap, outdoorSensors, outdoorTimeseries, sunTimeIdx, allClusterProfiles]);

  // Per-sensor arrays aligned to the indoor timeseries axis (for the outdoor sensors chart)
  const outdoorSensorsAligned = useMemo(() => {
    if (!allClusterProfiles?.timestamps?.length || !outdoorTimeseries?.timestamps?.length) return null;
    const ts = allClusterProfiles.timestamps;
    const odTms = outdoorTimeseries.timestamps.map((t) => new Date(t).getTime());
    const sensorIds = Object.keys(outdoorTimeseries.sensors);
    // Pre-build index mapping: for each indoor ts, find nearest outdoor ts index
    const idxMap = ts.map((t) => {
      const ms = new Date(t).getTime();
      let best = 0, bestDiff = Infinity;
      odTms.forEach((ot, j) => { const d = Math.abs(ot - ms); if (d < bestDiff) { bestDiff = d; best = j; } });
      return best;
    });
    const sensors = {};
    sensorIds.forEach((id) => {
      sensors[id] = idxMap.map((j) => outdoorTimeseries.sensors[id]?.[j] ?? null);
    });
    const mean = ts.map((_, i) => {
      const vals = sensorIds.map((id) => sensors[id][i]).filter((v) => v != null);
      return vals.length > 0 ? d3.mean(vals) : null;
    });
    return { sensors, mean, sensorIds };
  }, [allClusterProfiles, outdoorTimeseries]);

  // ── deck.gl layers ──
  const layers = useMemo(() => {
    const ls = [];
    if (mode3D) {
      ls.push(new LineLayer({
        id: "sensor-struts",
        data: sensorLocations.filter((d) => d.elevation > 0),
        getSourcePosition: (d) => [d.lon, d.lat, 0],
        getTargetPosition: (d) => [d.lon, d.lat, d.elevation],
        getColor: (d) => {
          const [r, g, b] = metricColorMap
            ? (metricColorMap[d.id] || [150, 150, 150])
            : hexToRgb(getEffectiveClusterColor(d.cluster, clusters.indexOf(d.cluster)));
          return [r, g, b, buildingHighlightIds ? (buildingHighlightIds.has(d.id) ? 160 : 20) : 80];
        },
        getWidth: 1,
        widthUnits: "pixels",
        updateTriggers: { getColor: [clusters, buildingHighlightIds, clusterGroups, metricColorMap] },
      }));
    }
    if (mode3D) {
      ls.push(new SimpleMeshLayer({
        id: "sensors-3d",
        data: sensorLocations,
        mesh: SPHERE_GEOMETRY,
        getPosition: (d) => [d.lon, d.lat, d.elevation],
        getScale: (d) => {
          const r = buildingHighlightIds?.has(d.id) ? 2.5 : 1.5;
          return [r, r, r];
        },
        getColor: (d) => {
          const color = metricColorMap
            ? (metricColorMap[d.id] || [150, 150, 150])
            : hexToRgb(getEffectiveClusterColor(d.cluster, clusters.indexOf(d.cluster)));
          const alpha = buildingHighlightIds
            ? (buildingHighlightIds.has(d.id) ? 255 : 40)
            : 220;
          return [...color, alpha];
        },
        sizeScale: 1,
        pickable: true,
        material: false, // opt out of shadow system — prevents shadow_uShadowMap0 binding error on hover pick pass
        parameters: { depthTest: true },
        updateTriggers: { getColor: [clusters, buildingHighlightIds, clusterGroups, metricColorMap], getScale: [buildingHighlightIds] },
      }));
    } else {
      ls.push(new ScatterplotLayer({
        id: "sensors",
        data: sensorLocations,
        getPosition: (d) => [d.lon, d.lat, 0],
        getFillColor: (d) => {
          const color = metricColorMap
            ? (metricColorMap[d.id] || [150, 150, 150])
            : hexToRgb(getEffectiveClusterColor(d.cluster, clusters.indexOf(d.cluster)));
          const alpha = buildingHighlightIds
            ? (buildingHighlightIds.has(d.id) ? 255 : 30)
            : 210;
          return [...color, alpha];
        },
        getRadius: (d) => buildingHighlightIds?.has(d.id) ? 5 : 1,
        radiusUnits: "pixels",
        radiusMinPixels: buildingHighlightIds ? 3 : 2,
        radiusMaxPixels: buildingHighlightIds ? 14 : 8,
        pickable: true,
        updateTriggers: { getFillColor: [clusters, buildingHighlightIds, clusterGroups, metricColorMap], getRadius: [buildingHighlightIds] },
      }));
    }
    if (mode3D && buildings3D?.features?.length) {
      ls.push(new GeoJsonLayer({
        id: "buildings-3d-all",
        data: buildings3D,
        filled: true,
        stroked: false,
        extruded: true,
        getElevation: (f) => f.properties?.height ?? 10,
        getFillColor: [100, 180, 255, 170],
        material: { ambient: 0.35, diffuse: 0.6, shininess: 32, specularColor: [60, 60, 60] },
      }));
    }
    // Outdoor sensor temperature — one dot per sensor, colored by actual temperature
    if (showHeatmap && tempPoints?.length) {
      const { min, max } = outdoorTempRange;
      ls.push(new ScatterplotLayer({
        id: "outdoor-temp",
        data: tempPoints,
        getPosition: (d) => d.position,
        getFillColor: (d) => [...tempToColor(d.temp, min, max), 230],
        getLineColor: [30, 30, 30, 180],
        stroked: true,
        lineWidthMinPixels: 1,
        getRadius: 60,
        radiusUnits: "meters",
        radiusMinPixels: 10,
        radiusMaxPixels: 40,
        pickable: false,
        updateTriggers: { getFillColor: [tempPoints, min, max] },
      }));
    }
    // Outdoor sensor location dots
    if (showOutdoorSensors && outdoorSensors?.length) {
      ls.push(new ScatterplotLayer({
        id: "outdoor-sensors",
        data: outdoorSensors,
        getPosition: (d) => [d.lon, d.lat, 0],
        getFillColor: [255, 140, 0, 220],
        getLineColor: [255, 255, 255, 180],
        stroked: true,
        lineWidthMinPixels: 1,
        getRadius: 5,
        radiusUnits: "pixels",
        pickable: false,
      }));
    }
    if (buildingGeometry?.features?.length) {
      ls.push(new GeoJsonLayer({
        id: "buildings",
        data: buildingGeometry,
        filled: true,
        stroked: true,
        extruded: mode3D,
        getElevation: (f) => f.properties?.height ?? 10,
        getFillColor: mode3D ? [88, 166, 255, 180] : [88, 166, 255, 25],
        getLineColor: [88, 166, 255, 200],
        lineWidthMinPixels: 1,
        lineWidthMaxPixels: 2,
        material: mode3D ? { ambient: 0.35, diffuse: 0.6, shininess: 32, specularColor: [60, 60, 60] } : undefined,
        updateTriggers: { extruded: [mode3D], getFillColor: [mode3D] },
      }));
    }
    return ls;
  }, [sensorLocations, clusters, buildingHighlightIds, buildingGeometry, buildings3D, mode3D, metricColorMap, showHeatmap, tempPoints, outdoorTempRange, showOutdoorSensors, outdoorSensors]);

  const handleViewStateChange = useCallback(({ viewState: vs, interactionState }) => {
    setViewState({ ...vs });
    if (interactionState?.isDragging || interactionState?.isPanning || interactionState?.isZooming) {
      setIsPlaying(false);
    }
  }, []);

  const toggle3D = () => {
    setMode3D((prev) => {
      const next = !prev;
      setViewState((vs) => ({
        ...vs,
        // When turning 3D off, flatten the view. When turning on, keep current
        // pitch so top-down (pitch 0) stays top-down — shadows are visible there.
        ...(!next && { pitch: 0, bearing: 0 }),
        transitionDuration: 500,
        transitionInterpolator: new FlyToInterpolator(),
      }));
      return next;
    });
  };

  // ── Box zoom ──
  const getPos = (e) => {
    const r = boxOverlayRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onBoxDown = (e) => { boxStartRef.current = getPos(e); setBoxRect({ x: getPos(e).x, y: getPos(e).y, w: 0, h: 0 }); };
  const onBoxMove = (e) => {
    if (!boxStartRef.current) return;
    const p = getPos(e), s = boxStartRef.current;
    setBoxRect({ x: Math.min(p.x, s.x), y: Math.min(p.y, s.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const onBoxUp = (e) => {
    if (!boxStartRef.current || !mapRef.current) { boxStartRef.current = null; setBoxRect(null); return; }
    const end = getPos(e), start = boxStartRef.current;
    boxStartRef.current = null; setBoxRect(null); setBoxZoomActive(false);
    if (Math.abs(end.x - start.x) < 5 || Math.abs(end.y - start.y) < 5) return;
    const map = mapRef.current.getMap();
    const sw = map.unproject([Math.min(start.x, end.x), Math.max(start.y, end.y)]);
    const ne = map.unproject([Math.max(start.x, end.x), Math.min(start.y, end.y)]);
    const { clientWidth: w, clientHeight: h } = deckContainerRef.current;
    try {
      const vp = new WebMercatorViewport({ ...viewState, width: w, height: h });
      const { longitude, latitude, zoom } = vp.fitBounds([[sw.lng, sw.lat], [ne.lng, ne.lat]], { padding: 20 });
      setViewState({ longitude, latitude, zoom: Math.min(zoom, 18), pitch: 0, bearing: 0, transitionDuration: 400, transitionInterpolator: new FlyToInterpolator() });
    } catch {}
  };

  // ── Analysis ──
  const analyseView = () => {
    setAnalysedSensors(visibleSensors);
    setMapSensorData(null);
    setSensorProperties(null);
    setSelectedBuildings(new Set());
    setBuildingTimeseries(null);
    setBuildingGeometry(null);
    setColorByMetric(null);
    if (!visibleSensors.length || !selectedK) return;
    setMapProfilesLoading(true);

    const allIds = visibleSensors.map((d) => d.id);
    const sampleIds = visibleSensors.filter((d) => selectedClusters.has(d.cluster)).slice(0, 200).map((d) => d.id);

    if (sampleIds.length > 0)
      fetch(`${API}/api/sensor-timeseries?sensor_ids=${encodeURIComponent(sampleIds.join(","))}`)
        .then((r) => r.json())
        .then((d) => { setMapSensorData(d); setMapProfilesLoading(false); })
        .catch(() => setMapProfilesLoading(false));
    else
      setMapProfilesLoading(false);

    // Fetch full properties for stats/buildings (capped at 500)
    const customMap = customClusterCols[selectedK];
    fetch(`${API}/api/sensors-properties`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensor_ids: allIds.slice(0, 500) }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) { console.error("sensors-properties:", data); return; }
        const enriched = customMap
          ? data.map((s) => ({ ...s, [selectedK]: customMap[s.sensor_id] ?? null }))
          : data;
        setSensorProperties(enriched);
      })
      .catch((e) => console.error("sensors-properties fetch failed:", e));
  };

  // Auto-run analysis once on initial load when sensors + selectedK are ready
  const autoAnalysedRef = useRef(false);
  useEffect(() => {
    if (autoAnalysedRef.current) return;
    if (visibleSensors.length > 0 && selectedK) {
      autoAnalysedRef.current = true;
      analyseView();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSensors, selectedK]);

  // Shared brush handlers — drag on any chart to zoom the time axis
  const onChartMouseDown = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const startFrac = (e.clientX - rect.left) / rect.width;
    brushRef.current = { startFrac };
    setBrushOverlay({ startFrac, curFrac: startFrac });
  }, []);

  const onChartMouseMove = useCallback((e) => {
    if (!brushRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const curFrac = (e.clientX - rect.left) / rect.width;
    setBrushOverlay({ startFrac: brushRef.current.startFrac, curFrac });
  }, []);

  const onChartMouseUp = useCallback((e) => {
    if (!brushRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const endFrac = (e.clientX - rect.left) / rect.width;
    const startFrac = brushRef.current.startFrac;
    brushRef.current = null;
    setBrushOverlay(null);
    // Ignore tiny drags (clicks)
    if (Math.abs(endFrac - startFrac) < 0.01) return;
    const n = allClusterProfiles?.timestamps?.length ?? 1;
    // Map fraction to index within current zoom range
    const base = xZoom?.lo ?? 0;
    const range = xZoom ? (xZoom.hi - xZoom.lo) : (n - 1);
    // Adjust for left margin (~5.5% of container) and right (~3%)
    const toIdx = (f) => {
      const normalized = (f - 0.055) / (0.97 - 0.055);
      return Math.round(base + Math.max(0, Math.min(1, normalized)) * range);
    };
    let lo = toIdx(Math.min(startFrac, endFrac));
    let hi = toIdx(Math.max(startFrac, endFrac));
    lo = Math.max(0, lo); hi = Math.min(n - 1, hi);
    if (hi - lo < 2) return;
    setXZoom({ lo, hi });
  }, [allClusterProfiles, xZoom]);

  const zoomIn = useCallback(() => {
    const n = allClusterProfiles?.timestamps?.length ?? 1;
    const center = sunTimeIdx ?? Math.floor(n / 2);
    const lo = xZoom?.lo ?? 0, hi = xZoom?.hi ?? (n - 1);
    const half = Math.max(1, Math.floor((hi - lo) / 4));
    setXZoom({ lo: Math.max(0, center - half), hi: Math.min(n - 1, center + half) });
  }, [allClusterProfiles, xZoom, sunTimeIdx]);

  const zoomOut = useCallback(() => {
    const n = allClusterProfiles?.timestamps?.length ?? 1;
    if (!xZoom) return;
    const center = sunTimeIdx ?? Math.floor((xZoom.lo + xZoom.hi) / 2);
    const half = xZoom.hi - xZoom.lo;
    const lo = Math.max(0, center - half), hi = Math.min(n - 1, center + half);
    setXZoom(lo <= 0 && hi >= n - 1 ? null : { lo, hi });
  }, [allClusterProfiles, xZoom, sunTimeIdx]);

  const dateToIdx = useCallback((dateStr) => {
    const ts = allClusterProfiles?.timestamps;
    if (!ts?.length) return 0;
    const ms = new Date(dateStr).getTime();
    let best = 0, bestDiff = Infinity;
    ts.forEach((t, i) => { const d = Math.abs(new Date(t).getTime() - ms); if (d < bestDiff) { bestDiff = d; best = i; } });
    return best;
  }, [allClusterProfiles]);

  const displaySensors = analysedSensors ?? [];
  const byCluster = useMemo(() => {
    const counts = {};
    displaySensors.forEach((d) => { counts[d.cluster] = (counts[d.cluster] || 0) + 1; });
    return counts;
  }, [displaySensors]);

  // When a building is selected, count clusters from that building's sensors instead
  const activeByCluster = useMemo(() => {
    if (!Array.isArray(activeSensorProperties) || selectedBuildings.size === 0) return byCluster;
    const counts = {};
    activeSensorProperties.forEach((s) => {
      const cid = s[selectedK];
      if (cid != null) counts[cid] = (counts[cid] || 0) + 1;
    });
    return counts;
  }, [activeSensorProperties, selectedBuildings, byCluster, selectedK]);

  const activeTotal = useMemo(
    () => Object.values(activeByCluster).reduce((s, n) => s + n, 0),
    [activeByCluster]
  );

  // ── Charts ──
  const drawChart = useCallback((canvas, timestamps, yVals, drawFn, xZoom = null, opts = {}) => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);
    const { rightMargin = 20 } = opts;
    const margin = { top: 16, right: rightMargin, bottom: 44, left: 52 };
    const pw = w - margin.left - margin.right, ph = h - margin.top - margin.bottom;
    const lo = xZoom?.lo ?? 0;
    const hi = xZoom?.hi ?? (timestamps.length - 1);
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#1a1f2e"; ctx.fillRect(0, 0, w, h);
    const xScale = d3.scaleLinear().domain([lo, hi]).range([margin.left, margin.left + pw]);
    const yExtent = d3.extent(yVals);
    const yPad = (yExtent[1] - yExtent[0]) * 0.05 || 1;
    const yScale = d3.scaleLinear().domain([yExtent[0] - yPad, yExtent[1] + yPad]).range([margin.top + ph, margin.top]);
    ctx.strokeStyle = "#252c3d"; ctx.lineWidth = 1;
    yScale.ticks(5).forEach((t) => { ctx.beginPath(); ctx.moveTo(margin.left, yScale(t)); ctx.lineTo(margin.left + pw, yScale(t)); ctx.stroke(); });
    // Tick marks on left axis edge
    ctx.strokeStyle = "#66779966"; ctx.lineWidth = 1;
    yScale.ticks(5).forEach((t) => { ctx.beginPath(); ctx.moveTo(margin.left - 4, yScale(t)); ctx.lineTo(margin.left, yScale(t)); ctx.stroke(); });
    ctx.fillStyle = "#8899bb"; ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "right";
    yScale.ticks(5).forEach((t) => ctx.fillText(t.toFixed(1), margin.left - 7, yScale(t) + 3.5));
    ctx.fillStyle = "#556677"; ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "center";
    const step = Math.max(1, Math.floor((hi - lo + 1) / 6));
    for (let i = lo; i <= hi; i += step) ctx.fillText(String(timestamps[i]).slice(0, 10), xScale(i), margin.top + ph + 16);
    drawFn(ctx, xScale, yScale, lo, hi, { margin, pw, ph });
  }, []);

  // Clusters present in the analysed view
  const viewClusterIds = useMemo(() => {
    if (!analysedSensors) return new Set();
    return new Set(analysedSensors.map((d) => String(d.cluster)));
  }, [analysedSensors]);

  // ── Stats derived from sensor properties ──
  const areaGroups = useMemo(() => {
    if (!Array.isArray(sensorProperties)) return {};
    const groups = {};
    sensorProperties.forEach((s) => {
      const key = s["lm_building_id"] || "Unknown";
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    });
    return groups;
  }, [sensorProperties]);

  const floorData = useMemo(() => {
    if (!Array.isArray(activeSensorProperties)) return null;
    const counts = {};
    activeSensorProperties.forEach((s) => {
      const f = s["floor_df1"];
      if (f == null || isNaN(f)) return;
      const lbl = String(Math.round(f));
      const cid = String(s[selectedK]);
      if (!counts[lbl]) counts[lbl] = {};
      counts[lbl][cid] = (counts[lbl][cid] || 0) + 1;
    });
    const labels = Object.keys(counts).map(Number).sort((a, b) => a - b).map(String);
    return { labels, counts };
  }, [activeSensorProperties, selectedK]);

  const yearData = useMemo(() => {
    if (!Array.isArray(activeSensorProperties)) return null;
    const counts = {};
    activeSensorProperties.forEach((s) => {
      const y = s["Nybyggnadsår"];
      if (y == null || isNaN(y) || y < 1800 || y > 2100) return;
      const bin = String(Math.floor(y / 5) * 5);
      const cid = String(s[selectedK]);
      if (!counts[bin]) counts[bin] = {};
      counts[bin][cid] = (counts[bin][cid] || 0) + 1;
    });
    const labels = Object.keys(counts).sort();
    return labels.length ? { labels, counts } : null;
  }, [activeSensorProperties, selectedK]);

  const periodData = useMemo(() => {
    if (!Array.isArray(activeSensorProperties)) return null;
    const counts = {};
    activeSensorProperties.forEach((s) => {
      const p = s["construction_period"];
      if (!p) return;
      const cid = String(s[selectedK]);
      if (!counts[p]) counts[p] = {};
      counts[p][cid] = (counts[p][cid] || 0) + 1;
    });
    const labels = Object.keys(counts).sort();
    return { labels, counts };
  }, [activeSensorProperties, selectedK]);

  const buildingTypeData = useMemo(() => {
    if (!Array.isArray(activeSensorProperties)) return null;
    const counts = {};
    activeSensorProperties.forEach((s) => {
      const t = s["andamal_typ"];
      if (!t) return;
      const cid = String(s[selectedK]);
      if (!counts[t]) counts[t] = {};
      counts[t][cid] = (counts[t][cid] || 0) + 1;
    });
    const labels = Object.keys(counts).sort((a, b) =>
      Object.values(counts[b]).reduce((s, n) => s + n, 0) - Object.values(counts[a]).reduce((s, n) => s + n, 0)
    );
    return { labels, counts };
  }, [activeSensorProperties, selectedK]);

  // ── Irradiance values aligned to sensor timestamps ──
  const irradianceVals = useMemo(() => {
    if (!allClusterProfiles?.timestamps?.length || !strangData) return null;
    return allClusterProfiles.timestamps.map((t) => getIrradiance(new Date(t).getTime(), strangData) ?? 0);
  }, [allClusterProfiles, strangData]);

  // ── Outdoor climate values aligned to sensor timestamps ──
  const outdoorClimateVals = useMemo(() => {
    if (!allClusterProfiles?.timestamps?.length || !outdoorClimate?.timestamps?.length) return null;
    const ocTs = outdoorClimate.timestamps.map((t) => new Date(t).getTime());
    const interp = (series, tsMs) => {
      const vals = outdoorClimate[series];
      let lo = 0;
      for (let i = 0; i < ocTs.length - 1; i++) { if (ocTs[i] <= tsMs) lo = i; else break; }
      const hi = Math.min(lo + 1, ocTs.length - 1);
      const v0 = vals[lo], v1 = vals[hi];
      if (v0 == null && v1 == null) return null;
      if (v0 == null) return v1;
      if (v1 == null) return v0;
      const f = ocTs[hi] === ocTs[lo] ? 0 : (tsMs - ocTs[lo]) / (ocTs[hi] - ocTs[lo]);
      return v0 + f * (v1 - v0);
    };
    return allClusterProfiles.timestamps.map((t) => {
      const ms = new Date(t).getTime();
      return {
        temp: interp("temperature", ms),
        rh:   interp("humidity", ms),
      };
    });
  }, [allClusterProfiles, outdoorClimate]);

  useEffect(() => {
    if (analysisTab !== "profiles") return;
    if (!allClusterProfiles || !analysedSensors || !canvasRef.current) return;
    const ts = allClusterProfiles.timestamps; if (!ts?.length) return;
    const viewProfiles = Object.fromEntries(
      Object.entries(allClusterProfiles.profiles).filter(([cid]) => viewClusterIds.has(cid))
    );
    const outdoorTemps = (showOutdoorOverlay && outdoorClimateVals)
      ? outdoorClimateVals.map((d) => d.temp).filter((v) => v != null)
      : [];
    const yVals = [...Object.values(viewProfiles).flatMap((p) => p.values), ...outdoorTemps].filter((v) => v != null);
    if (!yVals.length) return;
    drawChart(canvasRef.current, ts, yVals, (ctx, xScale, yScale, lo, hi) => {
      Object.entries(viewProfiles).forEach(([cidStr, p]) => {
        const ci = clusters.indexOf(Number(cidStr));
        ctx.strokeStyle = getEffectiveClusterColor(Number(cidStr), ci); ctx.lineWidth = 2; ctx.beginPath();
        let started = false;
        for (let i = lo; i <= hi; i++) {
          const v = p.values[i]; if (v === null) { started = false; continue; }
          if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; } else ctx.lineTo(xScale(i), yScale(v));
        }
        ctx.stroke();
      });
      if (showOutdoorOverlay && outdoorClimateVals) {
        ctx.strokeStyle = "#ff8a65"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]); ctx.beginPath();
        let started = false;
        for (let i = lo; i <= hi; i++) {
          const v = outdoorClimateVals[i]?.temp; if (v == null) { started = false; continue; }
          if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; } else ctx.lineTo(xScale(i), yScale(v));
        }
        ctx.stroke(); ctx.setLineDash([]);
      }
    }, xZoom);
  }, [allClusterProfiles, analysedSensors, viewClusterIds, clusters, drawChart, analysisTab, getEffectiveClusterColor, xZoom, showOutdoorOverlay, outdoorClimateVals]);

  useEffect(() => {
    if (analysisTab !== "profiles") return;
    const activeSensorData = buildingTimeseries || mapSensorData;
    if (!allClusterProfiles || !activeSensorData || !sensorCanvasRef.current) return;
    const ts = allClusterProfiles.timestamps; if (!ts?.length) return;
    const viewProfiles = Object.fromEntries(
      Object.entries(allClusterProfiles.profiles).filter(([cid]) => viewClusterIds.has(cid))
    );
    const yVals = [...Object.values(viewProfiles).flatMap((p) => p.values), ...Object.values(activeSensorData.sensors).flat()].filter((v) => v != null && !isNaN(v));
    if (!yVals.length) return;
    drawChart(sensorCanvasRef.current, ts, yVals, (ctx, xScale, yScale, lo, hi) => {
      Object.entries(activeSensorData.sensors).forEach(([sid, vals]) => {
        const sensor = analysedSensors?.find((d) => d.id === sid);
        const ci = sensor ? clusters.indexOf(sensor.cluster) : -1;
        const baseColor = sensor ? getEffectiveClusterColor(sensor.cluster, ci) : "#888";
        ctx.strokeStyle = baseColor + "40"; ctx.lineWidth = 1; ctx.beginPath();
        let started = false;
        for (let i = lo; i <= hi; i++) {
          const v = vals[i]; if (v == null || isNaN(v)) { started = false; continue; }
          if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; } else ctx.lineTo(xScale(i), yScale(v));
        }
        ctx.stroke();
      });
      Object.entries(viewProfiles).forEach(([cidStr, p]) => {
        const ci = clusters.indexOf(Number(cidStr));
        ctx.strokeStyle = getEffectiveClusterColor(Number(cidStr), ci); ctx.lineWidth = 2; ctx.beginPath();
        let started = false;
        for (let i = lo; i <= hi; i++) {
          const v = p.values[i]; if (v === null) { started = false; continue; }
          if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; } else ctx.lineTo(xScale(i), yScale(v));
        }
        ctx.stroke();
      });
    }, xZoom);
  }, [allClusterProfiles, mapSensorData, buildingTimeseries, viewClusterIds, clusters, analysedSensors, drawChart, analysisTab, getEffectiveClusterColor, xZoom]);

  // ── Outdoor sensors chart ──
  useEffect(() => {
    if (!showOutdoorSensors && !showHeatmap) return;
    if (!outdoorSensorsAligned || !outdoorSensorsCanvasRef.current) return;
    if (!allClusterProfiles?.timestamps?.length) return;
    const { sensors, mean, sensorIds } = outdoorSensorsAligned;
    const smhiTemps = outdoorClimateVals ? outdoorClimateVals.map((d) => d.temp) : [];
    const allVals = [...mean, ...smhiTemps].filter((v) => v != null);
    if (!allVals.length) return;
    drawChart(outdoorSensorsCanvasRef.current, allClusterProfiles.timestamps, allVals, (ctx, xScale, yScale, lo, hi) => {
      // Individual sensor lines — thin, translucent
      ctx.lineWidth = 0.7;
      sensorIds.forEach((id) => {
        ctx.strokeStyle = "rgba(255,140,0,0.15)";
        ctx.beginPath();
        let started = false;
        for (let i = lo; i <= hi; i++) {
          const v = sensors[id][i];
          if (v == null) { started = false; continue; }
          if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
          else ctx.lineTo(xScale(i), yScale(v));
        }
        ctx.stroke();
      });
      // Mean line — bold, solid orange
      ctx.strokeStyle = "#ff8c00";
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (let i = lo; i <= hi; i++) {
        const v = mean[i];
        if (v == null) { started = false; continue; }
        if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
        else ctx.lineTo(xScale(i), yScale(v));
      }
      ctx.stroke();
      // SMHI station temperature — dashed muted line, only when overlay is on
      if (showOutdoorOverlay && outdoorClimateVals) {
        ctx.strokeStyle = "rgba(160,185,220,0.75)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        let startedSmhi = false;
        for (let i = lo; i <= hi; i++) {
          const v = outdoorClimateVals[i]?.temp;
          if (v == null) { startedSmhi = false; continue; }
          if (!startedSmhi) { ctx.moveTo(xScale(i), yScale(v)); startedSmhi = true; }
          else ctx.lineTo(xScale(i), yScale(v));
        }
        ctx.stroke();
        ctx.setLineDash([]);
        // Label
        ctx.fillStyle = "rgba(160,185,220,0.75)";
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("SMHI station", xScale(hi) - 2, yScale(outdoorClimateVals[hi]?.temp ?? allVals[0]) - 4);
      }
    }, xZoom);
  }, [showOutdoorSensors, showHeatmap, outdoorSensorsAligned, allClusterProfiles, drawChart, xZoom, outdoorClimateVals, showOutdoorOverlay]);

  // ── Building timeseries fetch ──
  useEffect(() => {
    if (selectedBuildings.size === 0 || !sensorProperties) { setBuildingTimeseries(null); return; }
    const ids = sensorProperties
      .filter((s) => selectedBuildings.has(s["lm_building_id"] || "Unknown"))
      .slice(0, 200)
      .map((s) => s.sensor_id);
    if (!ids.length) return;
    fetch(`${API}/api/sensor-timeseries?sensor_ids=${encodeURIComponent(ids.join(","))}`)
      .then((r) => r.json())
      .then(setBuildingTimeseries)
      .catch(() => {});
  }, [selectedBuildings, sensorProperties]);

  // ── Building geometry fetch ──
  useEffect(() => {
    if (selectedBuildings.size === 0) { setBuildingGeometry(null); return; }
    fetch(`${API}/api/building-geometries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lm_building_ids: [...selectedBuildings] }),
    })
      .then((r) => r.json())
      .then((data) => { if (data?.features) setBuildingGeometry(data); })
      .catch(() => {});
  }, [selectedBuildings]);

  // ── Fly to building when geometry loads ──
  useEffect(() => {
    if (!buildingGeometry?.features?.length || !deckContainerRef.current) return;
    const allCoords = buildingGeometry.features.flatMap((f) => {
      const c = f.geometry?.coordinates;
      if (!c) return [];
      if (f.geometry.type === "MultiPolygon") return c.flat(2);
      if (f.geometry.type === "Polygon") return c.flat(1);
      return c;
    });
    if (!allCoords.length) return;
    const lons = allCoords.map((c) => c[0]), lats = allCoords.map((c) => c[1]);
    try {
      const { clientWidth: w, clientHeight: h } = deckContainerRef.current;
      const vp = new WebMercatorViewport({ ...viewState, width: w, height: h });
      const { longitude, latitude, zoom } = vp.fitBounds(
        [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: 80 }
      );
      setViewState((vs) => ({ ...vs, longitude, latitude, zoom: Math.min(zoom, 19), transitionDuration: 700, transitionInterpolator: new FlyToInterpolator() }));
    } catch {}
  }, [buildingGeometry]);

  // ── Stats charts (floor / year / period / building type) ──
  useEffect(() => { if (floorData && floorCanvasRef.current && analysisTab === "stats") renderStackedBars(floorCanvasRef.current, floorData, "Floor level (floor_df1)", clusters, viewClusterIds, false, getEffectiveClusterColor); }, [floorData, clusters, viewClusterIds, analysisTab, getEffectiveClusterColor]);
  useEffect(() => { if (yearData && yearCanvasRef.current && analysisTab === "stats") renderYearDensity(yearCanvasRef.current, yearData, clusters, viewClusterIds, getEffectiveClusterColor); }, [yearData, clusters, viewClusterIds, analysisTab, getEffectiveClusterColor]);
  useEffect(() => { if (periodData && periodCanvasRef.current && analysisTab === "stats") renderStackedBars(periodCanvasRef.current, periodData, "Construction period", clusters, viewClusterIds, true, getEffectiveClusterColor); }, [periodData, clusters, viewClusterIds, analysisTab, getEffectiveClusterColor]);
  useEffect(() => { if (buildingTypeData && typeCanvasRef.current && analysisTab === "stats") renderStackedBars(typeCanvasRef.current, buildingTypeData, "Building type (andamal_typ)", clusters, viewClusterIds, true, getEffectiveClusterColor); }, [buildingTypeData, clusters, viewClusterIds, analysisTab, getEffectiveClusterColor]);

  // ── Building timeseries chart (Buildings tab) ──
  useEffect(() => {
    if (!buildingTimeseries || !allClusterProfiles || !buildingCanvasRef.current || analysisTab !== "buildings") return;
    const ts = allClusterProfiles.timestamps;
    if (!ts.length) return;
    const buildingClusterIds = new Set(Object.keys(activeByCluster).map(String));
    const viewProfiles = Object.fromEntries(
      Object.entries(allClusterProfiles.profiles).filter(([cid]) => buildingClusterIds.has(cid))
    );
    const yVals = [
      ...Object.values(viewProfiles).flatMap((p) => p.values),
      ...Object.values(buildingTimeseries.sensors).flat(),
    ].filter((v) => v != null && !isNaN(v));
    if (!yVals.length) return;
    drawChart(buildingCanvasRef.current, ts, yVals, (ctx, xScale, yScale) => {
      // Group sensors by cluster and draw together so same-cluster lines are visually grouped
      const byCid = {};
      Object.entries(buildingTimeseries.sensors).forEach(([sid, vals]) => {
        const s = sensorProperties?.find((p) => p.sensor_id === sid);
        const ci = s ? clusters.indexOf(s[selectedK]) : -1;
        const cid = ci >= 0 ? String(s[selectedK]) : "__unknown";
        if (!byCid[cid]) byCid[cid] = { ci, lines: [] };
        byCid[cid].lines.push(vals);
      });
      Object.entries(byCid).forEach(([cid, { ci, lines }]) => {
        const color = getEffectiveClusterColor(cid === "__unknown" ? -1 : Number(cid), ci);
        const [r, g, b] = hexToRgb(color);
        ctx.strokeStyle = `rgba(${r},${g},${b},0.65)`;
        ctx.lineWidth = 1.5;
        lines.forEach((vals) => {
          ctx.beginPath();
          let started = false;
          vals.forEach((v, i) => { if (v == null) return; if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; } else ctx.lineTo(xScale(i), yScale(v)); });
          ctx.stroke();
        });
      });
      // Cluster mean lines on top — thick + dashed
      Object.entries(viewProfiles).forEach(([cidStr, p]) => {
        const ci = clusters.indexOf(Number(cidStr));
        ctx.strokeStyle = getEffectiveClusterColor(Number(cidStr), ci);
        ctx.lineWidth = 2.5; ctx.setLineDash([8, 3]); ctx.beginPath();
        let started = false;
        p.values.forEach((v, i) => { if (v === null) return; if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; } else ctx.lineTo(xScale(i), yScale(v)); });
        ctx.stroke(); ctx.setLineDash([]);
      });
      // Legend
      const margin = { top: 16, left: 52 };
      let lx = margin.left, ly = margin.top;
      Object.entries(byCid).forEach(([cid, { ci }]) => {
        if (cid === "__unknown") return;
        const color = getEffectiveClusterColor(Number(cid), ci);
        ctx.fillStyle = color; ctx.fillRect(lx, ly, 10, 10);
        ctx.fillStyle = "#ccc"; ctx.font = "10px monospace"; ctx.textAlign = "left";
        ctx.fillText(`Cluster ${cid}`, lx + 14, ly + 9);
        lx += ctx.measureText(`Cluster ${cid}`).width + 28;
      });
    });
  }, [buildingTimeseries, allClusterProfiles, viewClusterIds, activeByCluster, clusters, sensorProperties, selectedK, analysisTab, drawChart, getEffectiveClusterColor]);

  if (!metadataData) return <div style={styles.emptyState}><p style={styles.emptyIcon}>◉</p><p>No metadata available</p></div>;

  return (
    <div style={{ display: "flex", flexDirection: wideMap ? "column" : "row", gap: 16, alignItems: "flex-start" }}>
      {/* Map column */}
      <div style={{ flex: wideMap ? "0 0 100%" : "0 0 50%", width: wideMap ? "100%" : undefined }}>
        {/* Toolbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6, flexWrap: "wrap" }}>
          <p style={{ ...styles.mapInfo, margin: 0 }}>{sensorLocations.length.toLocaleString()} sensors • {visibleSensors.length.toLocaleString()} in view</p>
          <button onClick={() => setFiltersOpen((v) => !v)} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: activeFilterCount > 0 ? "#2a9d8f" : "#3d4555", color: activeFilterCount > 0 ? "#2a9d8f" : "#8b949e", background: activeFilterCount > 0 ? "#2a9d8f22" : "none" }}>
            ⧉ Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          <button onClick={() => setBoxZoomActive((v) => !v)} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: boxZoomActive ? "#f4a261" : "#3d4555", color: boxZoomActive ? "#f4a261" : "#8b949e", background: boxZoomActive ? "#f4a26122" : "none" }}>
            ⬚ Box zoom
          </button>
          <button onClick={analyseView} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: "#457B9D", color: "#457B9D" }}>
            Analyse view
          </button>
          {analysedSensors && outdoorClimateVals && (
            <button onClick={() => setShowOutdoorOverlay(v => !v)} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: showOutdoorOverlay ? "#ff8a65" : "#3d4555", color: showOutdoorOverlay ? "#ff8a65" : "#8b949e", background: showOutdoorOverlay ? "#ff8a6522" : "none" }}>
              🌡 Outdoor temp
            </button>
          )}
          {outdoorSensors?.length > 0 && (
            <>
              <button onClick={() => setShowOutdoorSensors((v) => !v)} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: showOutdoorSensors ? "#ff8c00" : "#3d4555", color: showOutdoorSensors ? "#ff8c00" : "#8b949e", background: showOutdoorSensors ? "#ff8c0022" : "none" }}>
                ◉ Outdoor
              </button>
              <button onClick={() => setShowHeatmap((v) => !v)} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: showHeatmap ? "#e63946" : "#3d4555", color: showHeatmap ? "#e63946" : "#8b949e", background: showHeatmap ? "#e6394622" : "none" }}>
                ▦ Heatmap
              </button>
            </>
          )}
          {analysedSensors && (
            <button onClick={() => setTallPlots(v => !v)} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: tallPlots ? "#58a6ff" : "#3d4555", color: tallPlots ? "#58a6ff" : "#8b949e", background: tallPlots ? "#58a6ff22" : "none" }}>
              ⇕ Tall plots
            </button>
          )}
          {analysedSensors && (
            <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button onClick={zoomIn} title="Zoom in (2×, centered on playhead)" style={{ ...styles.miniBtn, padding: "4px 9px", fontSize: 13 }}>+</button>
              <button onClick={zoomOut} disabled={!xZoom} title="Zoom out (2×)" style={{ ...styles.miniBtn, padding: "4px 9px", fontSize: 13, opacity: xZoom ? 1 : 0.4 }}>−</button>
              {xZoom && <button onClick={() => setXZoom(null)} title="Reset zoom" style={{ ...styles.miniBtn, padding: "4px 8px", fontSize: 11, borderColor: "#E9C46A", color: "#E9C46A", background: "#E9C46A22" }}>✕</button>}
            </span>
          )}
          {analysedSensors && allClusterProfiles?.timestamps?.length > 0 && (() => {
            const ts = allClusterProfiles.timestamps;
            const n = ts.length;
            const lo = xZoom?.lo ?? 0, hi = xZoom?.hi ?? (n - 1);
            const inputStyle = { background: "#1a1f2e", border: "1px solid #3d4555", borderRadius: 4, color: "#c9d1d9", fontSize: 10, padding: "2px 4px", colorScheme: "dark", cursor: "pointer" };
            return (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input type="date"
                  value={ts[lo]?.slice(0, 10) ?? ""}
                  min={ts[0]?.slice(0, 10)}
                  max={ts[hi - 1]?.slice(0, 10)}
                  style={inputStyle}
                  onChange={(e) => {
                    const idx = dateToIdx(e.target.value);
                    const newHi = xZoom?.hi ?? (n - 1);
                    const newLo = Math.min(idx, newHi - 1);
                    setXZoom(newLo <= 0 && newHi >= n - 1 ? null : { lo: newLo, hi: newHi });
                  }}
                />
                <span style={{ color: "#556677", fontSize: 10 }}>–</span>
                <input type="date"
                  value={ts[hi]?.slice(0, 10) ?? ""}
                  min={ts[lo + 1]?.slice(0, 10)}
                  max={ts[n - 1]?.slice(0, 10)}
                  style={inputStyle}
                  onChange={(e) => {
                    const idx = dateToIdx(e.target.value);
                    const newLo = xZoom?.lo ?? 0;
                    const newHi = Math.max(idx, newLo + 1);
                    setXZoom(newLo <= 0 && newHi >= n - 1 ? null : { lo: newLo, hi: newHi });
                  }}
                />
              </span>
            );
          })()}
          <button onClick={toggle3D} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: mode3D ? "#E9C46A" : "#3d4555", color: mode3D ? "#E9C46A" : "#8b949e", background: mode3D ? "#E9C46A22" : "none" }}>
            ⬡ 3D{Object.keys(pointHeights).length === 0 ? " (loading…)" : ""}
          </button>
          {mode3D && (
            <button onClick={() => setShowSunArc(v => !v)} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: showSunArc ? "#E9C46A" : "#3d4555", color: showSunArc ? "#E9C46A" : "#8b949e", background: showSunArc ? "#E9C46A22" : "none" }}>
              ☀ Sun arc
            </button>
          )}
          <button onClick={() => setUseParquetCoords((v) => !v)} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: useParquetCoords ? "#4CC9F0" : "#3d4555", color: useParquetCoords ? "#4CC9F0" : "#8b949e", background: useParquetCoords ? "#4CC9F022" : "none" }}>
            ⌖ Parquet coords
          </button>
          <button onClick={() => setWideMap((v) => !v)} style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: wideMap ? "#58a6ff" : "#3d4555", color: wideMap ? "#58a6ff" : "#8b949e", background: wideMap ? "#58a6ff22" : "none" }}>
            ⛶ Wide
          </button>
          <select
            value={mapStyleId}
            onChange={(e) => setMapStyleId(e.target.value)}
            style={{ ...styles.select, padding: "3px 8px", fontSize: 11 }}
          >
            {MAP_STYLES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {/* Sun time scrubber + playback controls — only shown in 3D mode */}
        {mode3D && allClusterProfiles?.timestamps?.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: "#E9C46A", whiteSpace: "nowrap", flexShrink: 0 }}>☀ Sun</span>
            {/* Play / pause */}
            <button
              onClick={() => setIsPlaying((v) => !v)}
              style={{ ...styles.miniBtn, padding: "2px 9px", fontSize: 13, lineHeight: 1, flexShrink: 0,
                borderColor: isPlaying ? "#E9C46A" : "#3d4555",
                color:       isPlaying ? "#E9C46A" : "#8b949e",
                background:  isPlaying ? "#E9C46A22" : "none" }}
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
            {/* Speed selector */}
            <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
              {[0.5, 1, 2, 5].map((s) => (
                <button
                  key={s}
                  onClick={() => setPlaySpeed(s)}
                  style={{ ...styles.miniBtn, padding: "1px 5px", fontSize: 10, flexShrink: 0,
                    borderColor: playSpeed === s ? "#E9C46A" : "#3d4555",
                    color:       playSpeed === s ? "#E9C46A" : "#8b949e",
                    background:  playSpeed === s ? "#E9C46A22" : "none" }}
                >
                  {s}×
                </button>
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={allClusterProfiles.timestamps.length - 1}
              step={1}
              value={sunTimeIdx ?? Math.floor(allClusterProfiles.timestamps.length / 2)}
              onChange={(e) => { setIsPlaying(false); setSunTimeIdx(Number(e.target.value)); }}
              style={{ flex: 1, accentColor: "#E9C46A", cursor: "pointer" }}
            />
            <span style={{ fontSize: 10, color: "#8b949e", whiteSpace: "nowrap", flexShrink: 0, fontFamily: "monospace" }}>
              {new Date(allClusterProfiles.timestamps[sunTimeIdx ?? 0]).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        )}

        {/* Filter panel */}
        {filtersOpen && filterOptions && (
          <div style={{ marginBottom: 8, padding: "10px 12px", background: "#232936", border: "1px solid #2e3440", borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.5px" }}>Filter sensors</span>
              {activeFilterCount > 0 && <button onClick={clearFilters} style={{ ...styles.miniBtn, fontSize: 10, color: "#f85149", borderColor: "#f85149" }}>Clear all</button>}
            </div>
            {/* Building floor count filter */}
            <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid #2e3440" }}>
              <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.4px" }}>Min building floors</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {[0, 2, 3, 4, 5, 6].map((n) => (
                  <button key={n} onClick={() => setMinBuildingFloors(n)}
                    style={{ ...styles.sensorChip, fontSize: 10, padding: "2px 8px",
                      backgroundColor: minBuildingFloors === n ? "#2a9d8f33" : "transparent",
                      borderColor: minBuildingFloors === n ? "#2a9d8f" : "#3d4555",
                      color: minBuildingFloors === n ? "#2a9d8f" : "#8b949e" }}>
                    {n === 0 ? "Any" : `${n}+`}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 220, overflowY: "auto" }}>
              {Object.entries(filterOptions).map(([field, values]) => (
                <div key={field}>
                  <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.4px" }}>{field}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {values.map((v) => {
                      const active = activeFilters[field]?.has(String(v));
                      return (
                        <button key={v} onClick={() => toggleFilterValue(field, String(v))} style={{ ...styles.sensorChip, fontSize: 10, padding: "2px 8px", backgroundColor: active ? "#2a9d8f33" : "transparent", borderColor: active ? "#2a9d8f" : "#3d4555", color: active ? "#2a9d8f" : "#8b949e" }}>
                          {v}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* DeckGL map + sun intensity bar */}
        <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <div ref={deckContainerRef} style={{ flex: 1, minWidth: 0, height: wideMap ? 700 : 560, borderRadius: 8, overflow: "hidden", border: "1px solid #2e3440", position: "relative" }}>
          <DeckGL
            viewState={viewState}
            controller={!boxZoomActive}
            layers={[...layers, ...sunArcLayers]}
            effects={mode3D ? [lightingEffect] : []}
            onViewStateChange={handleViewStateChange}
            glOptions={{ webgl2: true }}
            getCursor={({ isHovering }) => isHovering ? "pointer" : "grab"}
            onClick={(info) => {
              if (!info.object?.id) return;
              const sensorId = info.object.id;
              const snapshotVisible = visibleSensors.map((d) => d.id).slice(0, 200);

              const selectBuilding = (bid) => {
                setSelectedBuildings(new Set([bid]));
                setBuildingTimeseries(null);
                setAnalysisTab("profiles");
                if (!snapshotVisible.length) return;
                fetch(`${API}/api/sensor-timeseries?sensor_ids=${encodeURIComponent(snapshotVisible.join(","))}`)
                  .then((r) => r.json())
                  .then(setBuildingTimeseries)
                  .catch(() => {});
              };

              // 1. Fast path: lm_building_id already in the 500-sensor sample
              const cached = sensorPropLookup[sensorId]?.["lm_building_id"];
              if (cached) { selectBuilding(cached); return; }

              // 2. Sensor not in sample — fetch its individual properties (single-row DB lookup)
              fetch(`${API}/api/sensor-properties?sensor_id=${encodeURIComponent(sensorId)}`)
                .then((r) => r.json())
                .then((props) => {
                  let bid = props?.["lm_building_id"];
                  // 3. Still null — spatial fallback: building with most visible sensors in areaGroups
                  if (!bid) {
                    const visibleSet = new Set(snapshotVisible);
                    let bestCount = 0;
                    Object.entries(areaGroups).forEach(([buildingId, sensors]) => {
                      if (buildingId === "Unknown") return;
                      const overlap = sensors.filter((s) => visibleSet.has(s.sensor_id)).length;
                      if (overlap > bestCount) { bestCount = overlap; bid = buildingId; }
                    });
                  }
                  selectBuilding(bid ?? sensorId);
                })
                .catch(() => selectBuilding(sensorId));
            }}
            getTooltip={({ object }) => {
              if (!object) return null;
              const props = sensorPropLookup[object.id];
              const floor = props?.floor_df1 ?? "—";
              const maxFloor = props?.max_floor ?? "—";
              const year = props?.["Nybyggnadsår"] ?? "—";
              const extra = props
                ? `<br/><span style="color:#8b949e">Floor: ${floor} / ${maxFloor} &nbsp;·&nbsp; Built: ${year}</span>`
                : "";
              const ph = pointHeights[object.id];
              const floorStr = mode3D && ph ? ` &nbsp;·&nbsp; floor ${ph.floor}/${ph.lm_max_floor}` : "";
              return {
                html: `<strong style="color:#e0e0e0">${object.id}</strong><br/><span style="color:#8b949e">Cluster: ${object.cluster}${floorStr}</span>${extra}`,
                style: { background: "#2a303d", border: "1px solid #3d4555", borderRadius: "6px", padding: "8px 12px", fontSize: "12px", fontFamily: "monospace" },
              };
            }}
          >
            <Map key={mapStyleId} ref={mapRef} mapStyle={resolveStyle(MAP_STYLES.find(s => s.id === mapStyleId).url)} mapboxAccessToken={MAPBOX_TOKEN} />
          </DeckGL>

          {/* Sun info overlay — 3D mode only */}
          {mode3D && (
            <div style={{
              position: "absolute", bottom: 32, right: 10, zIndex: 5,
              background: "rgba(26, 30, 40, 0.82)", backdropFilter: "blur(4px)",
              border: "1px solid #2e3440", borderRadius: 6,
              padding: "5px 10px", fontFamily: "monospace", fontSize: 11, color: "#c9d1d9",
              pointerEvents: "none", whiteSpace: "nowrap",
            }}>
              {(() => {
                const d = new Date(sunTimestampMs);
                const fmt = (opts) => d.toLocaleString("en-GB", { timeZone: "Europe/Stockholm", ...opts });
                const dateTime = fmt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
                const tz = fmt({ timeZoneName: "short" }).split(" ").at(-1); // "CET" or "CEST"
                const clearSky = clearSkyEstimate(sunInfo.altitude);
                const isOvercast = irradiance !== null && clearSky > 80 && irradiance < clearSky * 0.3;
                return sunInfo.isAboveHorizon ? (
                  <>
                    <span style={{ color: "#E9C46A" }}>☀</span>
                    {" "}<span style={{ color: "#8b949e" }}>{dateTime} {tz}</span>
                    {irradiance !== null && (
                      <>{" | "}<span style={{ color: isOvercast ? "#90b8d8" : "#f0c040" }}>{Math.round(irradiance)} W/m²{isOvercast ? " ☁" : ""}</span></>
                    )}
                    {" | "}Az: <span style={{ color: "#e0e0e0" }}>{Math.round(sunInfo.azimuth)}°</span>
                    {" | "}El: <span style={{ color: "#e0e0e0" }}>{Math.round(sunInfo.altitude)}°</span>
                    {outdoorTemp !== null && <>{" | "}<span style={{ color: "#ff8a65" }}>{outdoorTemp.toFixed(1)}°C</span></>}
                    {outdoorRH   !== null && <>{" "}<span style={{ color: "#4fc3f7" }}>{Math.round(outdoorRH)}% RH</span></>}
                  </>
                ) : (
                  <>
                    <span style={{ color: "#8b949e" }}>🌙</span>
                    {" "}<span style={{ color: "#8b949e" }}>{dateTime} {tz}</span>
                    {" | "}<span style={{ color: "#636e7b" }}>Below horizon</span>
                    {outdoorTemp !== null && <>{" | "}<span style={{ color: "#ff8a65" }}>{outdoorTemp.toFixed(1)}°C</span></>}
                    {outdoorRH   !== null && <>{" "}<span style={{ color: "#4fc3f7" }}>{Math.round(outdoorRH)}% RH</span></>}
                  </>
                );
              })()}
            </div>
          )}

          {/* Temperature color legend */}
          {showHeatmap && tempPoints?.length && (() => {
            const { min, max } = outdoorTempRange;
            const stops = TEMP_COLOR_STOPS.map((c) => `rgb(${c.join(",")})`).join(",");
            const ticks = [min, Math.round((min + max) / 2), max];
            return (
              <div style={{ position: "absolute", bottom: 32, left: 12, zIndex: 5, pointerEvents: "none",
                background: "rgba(26,30,40,0.82)", backdropFilter: "blur(4px)",
                border: "1px solid #2e3440", borderRadius: 6, padding: "6px 10px",
                fontFamily: "monospace", fontSize: 10, color: "#c9d1d9" }}>
                <div style={{ marginBottom: 3 }}>Outdoor temp (°C)</div>
                <div style={{ width: 120, height: 10, borderRadius: 3, background: `linear-gradient(to right, ${stops})` }} />
                <div style={{ display: "flex", justifyContent: "space-between", width: 120, marginTop: 2 }}>
                  {ticks.map((t) => <span key={t}>{t}</span>)}
                </div>
              </div>
            );
          })()}

          {/* Box zoom overlay */}
          {boxZoomActive && (
            <div ref={boxOverlayRef} style={{ position: "absolute", inset: 0, cursor: "crosshair", zIndex: 10 }}
              onMouseDown={onBoxDown} onMouseMove={onBoxMove} onMouseUp={onBoxUp}
            >
              {boxRect && boxRect.w > 2 && (
                <div style={{ position: "absolute", left: boxRect.x, top: boxRect.y, width: boxRect.w, height: boxRect.h, border: "1.5px solid #58a6ff", background: "#58a6ff15", pointerEvents: "none" }} />
              )}
            </div>
          )}
        </div>
        {/* Sun intensity bar */}
        {(() => {
          const mapH = wideMap ? 700 : 560;
          // Level 0–1: real irradiance / 850 when available, else geometric sin(alt)
          const level = irradiance !== null
            ? Math.min(1, irradiance / 850)
            : Math.max(0, sunInfo.isAboveHorizon ? Math.sin(sunInfo.altitude * (Math.PI / 180)) : 0);
          const fillPct = `${(level * 100).toFixed(1)}%`;
          // Always warm amber→yellow; hue 30 (orange) at low, 55 (yellow) at peak
          const fillColor = `hsl(${30 + level * 25}, 90%, ${30 + level * 35}%)`;
          // Tick labels: W/m² values when irradiance available, else plain %
          const ticks = [
            { t: 0.75, label: irradiance !== null ? "638" : "75%" },
            { t: 0.5,  label: irradiance !== null ? "425" : "50%" },
            { t: 0.25, label: irradiance !== null ? "213" : "25%" },
          ];
          const unit = irradiance !== null ? "W/m²" : "%";
          const tooltipVal = irradiance !== null
            ? `${Math.round(irradiance)} W/m²`
            : `El ${Math.round(sunInfo.altitude)}° → ${Math.round(level * 100)}%`;
          return (
            <div style={{ width: 46, height: mapH, flexShrink: 0, position: "relative" }}
              title={tooltipVal}>
              {/* unit label at top */}
              <div style={{ position: "absolute", top: 2, right: 0, width: 14, fontSize: 7, color: "#4a5568", textAlign: "center", fontFamily: "monospace", lineHeight: 1 }}>
                {unit}
              </div>
              {/* tick labels to the left of the bar */}
              {ticks.map(({ t, label }) => (
                <div key={t} style={{
                  position: "absolute", bottom: `calc(${t * 100}% - 5px)`,
                  left: 0, width: 28,
                  fontSize: 8, lineHeight: "10px", color: "#5a6474",
                  textAlign: "right", fontFamily: "monospace", pointerEvents: "none",
                }}>
                  {label}
                </div>
              ))}
              {/* bar */}
              <div style={{
                position: "absolute", right: 0, top: 0, bottom: 0, width: 14,
                borderRadius: 6, border: "1px solid #2e3440", background: "#131820", overflow: "hidden",
              }}>
                {ticks.map(({ t }) => (
                  <div key={t} style={{ position: "absolute", left: 0, right: 0, bottom: `${t * 100}%`, height: 1, background: "#2e3440", zIndex: 1 }} />
                ))}
                <div style={{
                  position: "absolute", bottom: 0, left: 0, right: 0, height: fillPct,
                  background: fillColor, transition: "height 0.4s ease, background 0.4s ease", zIndex: 2,
                }} />
              </div>
            </div>
          );
        })()}
        </div>
      </div>

      {/* Side panel */}
      <div style={{ flex: wideMap ? "0 0 100%" : "0 0 calc(50% - 16px)", width: wideMap ? "100%" : undefined, display: "flex", flexDirection: "column", gap: 10 }}>
        {!analysedSensors ? (
          <p style={styles.mapInfo}>Set your view and click "Analyse view" to inspect the area.</p>
        ) : (
          <>
            {/* Summary */}
            <p style={{ ...styles.mapInfo, margin: 0 }}>
              {selectedBuildings.size > 0 && activeSensorProperties
                ? <>
                    <span style={{ color: "#58a6ff" }}>{activeSensorProperties.length.toLocaleString()} sensors</span>
                    {` · ${selectedBuildings.size} building${selectedBuildings.size > 1 ? "s" : ""} selected`}
                    {` · ${Object.keys(activeByCluster).filter(k => activeByCluster[k] > 0).length} clusters`}
                  </>
                : <>
                    {displaySensors.length.toLocaleString()} sensors
                    {sensorProperties && ` · ${Object.keys(areaGroups).length} buildings`}
                    {` · ${viewClusterIds.size} clusters`}
                  </>
              }
            </p>

            {/* Cluster breakdown bars */}
            {selectedBuildings.size > 0 && (
              <p style={{ ...styles.mapInfo, margin: "0 0 2px", fontSize: 10, color: "#58a6ff" }}>
                ⬡ {[...selectedBuildings].join(", ")}
              </p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {clusters.map((c, i) => {
                const count = activeByCluster[c] || 0;
                if (!count) return null;
                const pct = activeTotal > 0 ? count / activeTotal : 0;
                return (
                  <div key={c} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: getEffectiveClusterColor(c, i), fontSize: 11, fontWeight: 600, width: 70, flexShrink: 0 }}>Cluster {c}</span>
                    <div style={{ flex: 1, background: "#232936", borderRadius: 4, height: 10, overflow: "hidden" }}>
                      <div style={{ width: `${pct * 100}%`, height: "100%", background: getEffectiveClusterColor(c, i), borderRadius: 4 }} />
                    </div>
                    <span style={{ fontSize: 11, color: "#8b949e", width: 36, textAlign: "right", flexShrink: 0 }}>{count}</span>
                  </div>
                );
              })}
            </div>

            {/* Analysis tabs */}
            <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #2e3440", paddingBottom: 0 }}>
              {[["profiles", "Profiles"], ["stats", "Stats"], ["buildings", "Buildings"]].map(([id, label]) => (
                <button key={id} onClick={() => setAnalysisTab(id)} style={{
                  background: "none", border: "none", borderBottom: analysisTab === id ? "2px solid #58a6ff" : "2px solid transparent",
                  color: analysisTab === id ? "#58a6ff" : "#8b949e", padding: "6px 14px", fontSize: 12,
                  cursor: "pointer", fontFamily: "inherit", marginBottom: -1,
                }}>
                  {label}
                </button>
              ))}
            </div>

            {/* ── Profiles tab ── */}
            {analysisTab === "profiles" && (
              <>
                {selectedBuildings.size > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: "#1f6feb22", border: "1px solid #58a6ff55", borderRadius: 6 }}>
                    <span style={{ fontSize: 11, color: "#58a6ff", flex: 1 }}>
                      ⬡ {[...selectedBuildings].join(", ")}
                    </span>
                    <button onClick={() => { setSelectedBuildings(new Set()); setBuildingTimeseries(null); setBuildingGeometry(null); setColorByMetric(null); }} style={{ ...styles.miniBtn, fontSize: 10, padding: "2px 8px", color: "#8b949e", borderColor: "#3d4555" }}>
                      Clear
                    </button>
                  </div>
                )}
                {mapProfilesLoading && <p style={styles.mapInfo}>Loading sensors…</p>}
                {allClusterProfiles && viewClusterIds.size > 0 && (
                  <>
                    <p style={{ ...styles.mapInfo, marginBottom: 0 }}>Full cluster means — {viewClusterIds.size} cluster{viewClusterIds.size > 1 ? "s" : ""} in view</p>
                    <div style={{ position: "relative" }}>
                      <canvas ref={canvasRef} style={{ ...styles.canvas, height: tallPlots ? 420 : (showOutdoorOverlay ? 240 : 200) }} onMouseDown={onChartMouseDown} onMouseMove={onChartMouseMove} onMouseUp={onChartMouseUp} onMouseLeave={() => { brushRef.current = null; setBrushOverlay(null); }} />
                      {brushOverlay && (() => {
                        const l = Math.min(brushOverlay.startFrac, brushOverlay.curFrac) * 100;
                        const w = Math.abs(brushOverlay.curFrac - brushOverlay.startFrac) * 100;
                        return <div style={{ position: "absolute", top: 0, bottom: 0, left: `${l}%`, width: `${w}%`, background: "rgba(233,196,106,0.12)", borderLeft: "1px solid rgba(233,196,106,0.5)", borderRight: "1px solid rgba(233,196,106,0.5)", pointerEvents: "none", zIndex: 3 }} />;
                      })()}
                      {sunTimeIdx !== null && canvasRef.current && (() => {
                        const n = allClusterProfiles.timestamps.length;
                        const x = 52 + (sunTimeIdx / Math.max(1, n - 1)) * (canvasRef.current.clientWidth - 72);
                        return (
                          <div style={{ position: "absolute", left: x, top: 16, bottom: 44, width: 1, background: "rgba(233,196,106,0.55)", pointerEvents: "none", zIndex: 2 }}>
                            <div style={{ position: "absolute", top: -4, left: -4, width: 9, height: 9, borderRadius: "50%", background: "#E9C46A", boxShadow: "0 0 6px #E9C46A" }} />
                          </div>
                        );
                      })()}
                    </div>
                    <p style={{ ...styles.mapInfo, marginBottom: 0, marginTop: 4 }}>
                      {buildingTimeseries
                        ? `${Object.keys(buildingTimeseries.sensors).length} sensors (building)`
                        : mapSensorData ? `${Object.keys(mapSensorData.sensors).length} sensors` : "Loading…"
                      } + cluster means
                    </p>
                    <div style={{ position: "relative" }}>
                      <canvas ref={sensorCanvasRef} style={{ ...styles.canvas, height: tallPlots ? 420 : (showOutdoorOverlay ? 240 : 200) }} onMouseDown={onChartMouseDown} onMouseMove={onChartMouseMove} onMouseUp={onChartMouseUp} onMouseLeave={() => { brushRef.current = null; setBrushOverlay(null); }} />
                      {brushOverlay && (() => {
                        const l = Math.min(brushOverlay.startFrac, brushOverlay.curFrac) * 100;
                        const w = Math.abs(brushOverlay.curFrac - brushOverlay.startFrac) * 100;
                        return <div style={{ position: "absolute", top: 0, bottom: 0, left: `${l}%`, width: `${w}%`, background: "rgba(233,196,106,0.12)", borderLeft: "1px solid rgba(233,196,106,0.5)", borderRight: "1px solid rgba(233,196,106,0.5)", pointerEvents: "none", zIndex: 3 }} />;
                      })()}
                      {sunTimeIdx !== null && sensorCanvasRef.current && (() => {
                        const n = allClusterProfiles.timestamps.length;
                        const x = 52 + (sunTimeIdx / Math.max(1, n - 1)) * (sensorCanvasRef.current.clientWidth - 72);
                        return (
                          <div style={{ position: "absolute", left: x, top: 16, bottom: 44, width: 1, background: "rgba(233,196,106,0.55)", pointerEvents: "none", zIndex: 2 }}>
                            <div style={{ position: "absolute", top: -4, left: -4, width: 9, height: 9, borderRadius: "50%", background: "#E9C46A", boxShadow: "0 0 6px #E9C46A" }} />
                          </div>
                        );
                      })()}
                    </div>
                    {(showOutdoorSensors || showHeatmap) && outdoorSensorsAligned && (
                      <>
                        <p style={{ ...styles.mapInfo, marginBottom: 0, marginTop: 4 }}>
                          Outdoor sensors — {outdoorSensorsAligned.sensorIds.length} stations{showOutdoorSensors ? " (orange), mean (bold)" : ", mean (bold)"}{showOutdoorOverlay ? ", SMHI (dashed)" : ""}
                        </p>
                        <div style={{ position: "relative" }}>
                          <canvas ref={outdoorSensorsCanvasRef} style={{ ...styles.canvas, height: tallPlots ? 420 : 160 }} onMouseDown={onChartMouseDown} onMouseMove={onChartMouseMove} onMouseUp={onChartMouseUp} onMouseLeave={() => { brushRef.current = null; setBrushOverlay(null); }} />
                          {brushOverlay && (() => {
                            const l = Math.min(brushOverlay.startFrac, brushOverlay.curFrac) * 100;
                            const w = Math.abs(brushOverlay.curFrac - brushOverlay.startFrac) * 100;
                            return <div style={{ position: "absolute", top: 0, bottom: 0, left: `${l}%`, width: `${w}%`, background: "rgba(233,196,106,0.12)", borderLeft: "1px solid rgba(233,196,106,0.5)", borderRight: "1px solid rgba(233,196,106,0.5)", pointerEvents: "none", zIndex: 3 }} />;
                          })()}
                          {sunTimeIdx !== null && outdoorSensorsCanvasRef.current && (() => {
                            const n = allClusterProfiles.timestamps.length;
                            const x = 52 + (sunTimeIdx / Math.max(1, n - 1)) * (outdoorSensorsCanvasRef.current.clientWidth - 72);
                            return (
                              <div style={{ position: "absolute", left: x, top: 16, bottom: 44, width: 1, background: "rgba(233,196,106,0.55)", pointerEvents: "none", zIndex: 2 }}>
                                <div style={{ position: "absolute", top: -4, left: -4, width: 9, height: 9, borderRadius: "50%", background: "#E9C46A", boxShadow: "0 0 6px #E9C46A" }} />
                              </div>
                            );
                          })()}
                        </div>
                      </>
                    )}
                    {outdoorClimateVals && (() => {
                      const ML = 52, MR = 52, MT = 16, MB = 30;
                      const VW = 1000, VH = 120;
                      const pw = VW - ML - MR, ph = VH - MT - MB;
                      const n = outdoorClimateVals.length;
                      const lo = xZoom?.lo ?? 0, hi = xZoom?.hi ?? (n - 1);
                      const sliced = outdoorClimateVals.slice(lo, hi + 1);
                      const visN = sliced.length;
                      const sx = (i) => ML + (i / Math.max(1, visN - 1)) * pw;
                      // Temperature axis: auto-range with padding
                      const temps = sliced.map((d) => d.temp).filter((v) => v != null);
                      const rhs   = sliced.map((d) => d.rh).filter((v) => v != null);
                      const tMin = Math.floor(Math.min(...(temps.length ? temps : [0])) - 2), tMax = Math.ceil(Math.max(...(temps.length ? temps : [1])) + 2);
                      const syT = (v) => v == null ? null : MT + ph - ((v - tMin) / (tMax - tMin)) * ph;
                      // RH axis: 0–100%
                      const syRH = (v) => v == null ? null : MT + ph - (v / 100) * ph;
                      // Build polyline points, skipping nulls (split into segments)
                      const buildPath = (fn, data) => {
                        let d = ""; let inSeg = false;
                        data.forEach((item, i) => {
                          const y = fn(item); if (y == null) { inSeg = false; return; }
                          d += inSeg ? ` L ${sx(i).toFixed(1)},${y.toFixed(1)}` : ` M ${sx(i).toFixed(1)},${y.toFixed(1)}`;
                          inSeg = true;
                        });
                        return d.trim();
                      };
                      const tempPath = buildPath((d) => syT(d.temp), sliced);
                      const rhPath   = buildPath((d) => syRH(d.rh),  sliced);
                      const tTicks = [tMin, Math.round((tMin+tMax)/2), tMax];
                      const rhTicks = [25, 50, 75];
                      return (
                        <>
                          <p style={{ ...styles.mapInfo, marginBottom: 0, marginTop: 4 }}>Outdoor temperature &amp; relative humidity — SMHI station</p>
                          <div ref={outdoorChartRef} style={{ position: "relative", borderRadius: 8, border: "1px solid #2e3440", overflow: "hidden", cursor: "col-resize" }} onMouseDown={onChartMouseDown} onMouseMove={onChartMouseMove} onMouseUp={onChartMouseUp} onMouseLeave={() => { brushRef.current = null; setBrushOverlay(null); }}>
                            {brushOverlay && (() => { const l = Math.min(brushOverlay.startFrac, brushOverlay.curFrac)*100, w = Math.abs(brushOverlay.curFrac - brushOverlay.startFrac)*100; return <div style={{ position:"absolute", top:0, bottom:0, left:`${l}%`, width:`${w}%`, background:"rgba(233,196,106,0.12)", borderLeft:"1px solid rgba(233,196,106,0.5)", borderRight:"1px solid rgba(233,196,106,0.5)", pointerEvents:"none", zIndex:3 }} />; })()}
                            <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none"
                              style={{ width: "100%", height: tallPlots ? 220 : 120, display: "block", background: "#1a1f2e" }}>
                              {/* RH area (background) */}
                              {rhs.length > 0 && (() => {
                                const area = `M ${sx(0).toFixed(1)},${syRH(sliced[0].rh ?? 0).toFixed(1)} ` +
                                  sliced.map((d, i) => `L ${sx(i).toFixed(1)},${syRH(d.rh ?? 0).toFixed(1)}`).join(" ") +
                                  ` L ${sx(visN-1).toFixed(1)},${(MT+ph).toFixed(1)} L ${sx(0).toFixed(1)},${(MT+ph).toFixed(1)} Z`;
                                return (
                                  <>
                                    <defs>
                                      <linearGradient id="rh-grad" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#4fc3f7" stopOpacity="0.25" />
                                        <stop offset="100%" stopColor="#4fc3f7" stopOpacity="0.03" />
                                      </linearGradient>
                                    </defs>
                                    <path d={area} fill="url(#rh-grad)" />
                                  </>
                                );
                              })()}
                              {/* RH grid lines (right axis) */}
                              {rhTicks.map((v) => (
                                <g key={`rh${v}`}>
                                  <line x1={ML} y1={syRH(v)} x2={ML+pw} y2={syRH(v)} stroke="#1e2535" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                                  <line x1={ML+pw} y1={syRH(v)} x2={ML+pw+4} y2={syRH(v)} stroke="#4fc3f766" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                                  <text x={VW - MR + 9} y={syRH(v)+3.5} textAnchor="start" fontSize="10" fill="#4fc3f7aa" fontFamily="system-ui, sans-serif">{v}</text>
                                </g>
                              ))}
                              {/* RH line */}
                              {rhs.length > 0 && <path d={rhPath} fill="none" stroke="#4fc3f7" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeOpacity="0.6" />}
                              {/* Temperature grid lines + labels (left axis) */}
                              {tTicks.map((v) => (
                                <g key={`t${v}`}>
                                  <line x1={ML} y1={syT(v)} x2={ML+pw} y2={syT(v)} stroke="#252c3d" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                                  <line x1={ML-4} y1={syT(v)} x2={ML} y2={syT(v)} stroke="#ff8a6566" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                                  <text x={ML-8} y={syT(v)+3.5} textAnchor="end" fontSize="10" fill="#ff8a65aa" fontFamily="system-ui, sans-serif">{v}</text>
                                </g>
                              ))}
                              {/* Temperature line */}
                              {temps.length > 0 && <path d={tempPath} fill="none" stroke="#ff8a65" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
                              {/* Axis unit labels — top of each axis */}
                              <text x={ML-8} y={MT-3} textAnchor="end" fontSize="9" fill="#ff8a6588" fontFamily="system-ui, sans-serif">°C</text>
                              <text x={VW-MR+9} y={MT-3} textAnchor="start" fontSize="9" fill="#4fc3f788" fontFamily="system-ui, sans-serif">RH%</text>
                            </svg>
                            {/* playhead */}
                            {sunTimeIdx !== null && outdoorChartRef.current && sunTimeIdx >= lo && sunTimeIdx <= hi && (() => {
                              const cw = outdoorChartRef.current.clientWidth;
                              const x = ML + ((sunTimeIdx - lo) / Math.max(1, hi - lo)) * (cw - ML - MR / VW * cw);
                              return (
                                <div style={{ position: "absolute", left: x, top: MT, bottom: MB, width: 1, background: "rgba(233,196,106,0.55)", pointerEvents: "none", zIndex: 2 }}>
                                  <div style={{ position: "absolute", top: -4, left: -4, width: 9, height: 9, borderRadius: "50%", background: "#E9C46A", boxShadow: "0 0 6px #E9C46A" }} />
                                </div>
                              );
                            })()}
                          </div>
                        </>
                      );
                    })()}
                    {irradianceVals && (() => {
                      const ML = 52, MR = 20, MT = 16, MB = 30;
                      const VW = 1000, VH = 120;
                      const pw = VW - ML - MR, ph = VH - MT - MB;
                      const n = irradianceVals.length;
                      const lo = xZoom?.lo ?? 0, hi = xZoom?.hi ?? (n - 1);
                      const sliced = irradianceVals.slice(lo, hi + 1);
                      const visN = sliced.length;
                      const MAX = 900;
                      const sx = (i) => ML + (i / Math.max(1, visN - 1)) * pw;
                      const sy = (v) => MT + ph - Math.min(1, v / MAX) * ph;
                      const pts = sliced.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" ");
                      const area = `M ${sx(0).toFixed(1)},${sy(sliced[0]).toFixed(1)} ` +
                        sliced.map((v, i) => `L ${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" ") +
                        ` L ${sx(visN-1).toFixed(1)},${(MT+ph).toFixed(1)} L ${sx(0).toFixed(1)},${(MT+ph).toFixed(1)} Z`;
                      const ticks = [225, 450, 675];
                      return (
                        <>
                          <p style={{ ...styles.mapInfo, marginBottom: 0, marginTop: 4 }}>Solar irradiance — SMHI STRÅNG</p>
                          <div ref={irradianceChartRef} style={{ position: "relative", borderRadius: 8, border: "1px solid #2e3440", overflow: "hidden", cursor: "col-resize" }} onMouseDown={onChartMouseDown} onMouseMove={onChartMouseMove} onMouseUp={onChartMouseUp} onMouseLeave={() => { brushRef.current = null; setBrushOverlay(null); }}>
                            {brushOverlay && (() => { const l = Math.min(brushOverlay.startFrac, brushOverlay.curFrac)*100, w = Math.abs(brushOverlay.curFrac - brushOverlay.startFrac)*100; return <div style={{ position:"absolute", top:0, bottom:0, left:`${l}%`, width:`${w}%`, background:"rgba(233,196,106,0.12)", borderLeft:"1px solid rgba(233,196,106,0.5)", borderRight:"1px solid rgba(233,196,106,0.5)", pointerEvents:"none", zIndex:3 }} />; })()}
                            <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none"
                              style={{ width: "100%", height: tallPlots ? 220 : 120, display: "block", background: "#1a1f2e" }}>
                              <defs>
                                <linearGradient id="irr-grad" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor="#F0B828" stopOpacity="0.7" />
                                  <stop offset="100%" stopColor="#F07820" stopOpacity="0.05" />
                                </linearGradient>
                              </defs>
                              {/* grid lines + y-axis labels */}
                              {ticks.map((v) => (
                                <g key={v}>
                                  <line x1={ML} y1={sy(v)} x2={ML+pw} y2={sy(v)} stroke="#252c3d" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                                  <line x1={ML-4} y1={sy(v)} x2={ML} y2={sy(v)} stroke="#66779966" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                                  <text x={ML-8} y={sy(v)+3.5} textAnchor="end" fontSize="10" fill="#8899bb" fontFamily="system-ui, sans-serif">{v}</text>
                                </g>
                              ))}
                              {/* area */}
                              <path d={area} fill="url(#irr-grad)" />
                              {/* line */}
                              <polyline points={pts} fill="none" stroke="#F0B828" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                              {/* W/m² axis unit label — top of axis */}
                              <text x={ML-8} y={MT-3} textAnchor="end" fontSize="9" fill="#66779988" fontFamily="system-ui, sans-serif">W/m²</text>
                            </svg>
                            {/* playhead */}
                            {sunTimeIdx !== null && irradianceChartRef.current && sunTimeIdx >= lo && sunTimeIdx <= hi && (() => {
                              const cw = irradianceChartRef.current.clientWidth;
                              const x = ML + ((sunTimeIdx - lo) / Math.max(1, hi - lo)) * (cw - ML - MR / VW * cw);
                              return (
                                <div style={{ position: "absolute", left: x, top: MT, bottom: MB, width: 1, background: "rgba(233,196,106,0.55)", pointerEvents: "none", zIndex: 2 }}>
                                  <div style={{ position: "absolute", top: -4, left: -4, width: 9, height: 9, borderRadius: "50%", background: "#E9C46A", boxShadow: "0 0 6px #E9C46A" }} />
                                </div>
                              );
                            })()}
                          </div>
                        </>
                      );
                    })()}
                  </>
                )}
              </>
            )}

            {/* ── Stats tab ── */}
            {analysisTab === "stats" && (
              <>
                {!sensorProperties && <p style={styles.mapInfo}>Loading properties…</p>}
                {sensorProperties && (
                  <>
                    {selectedBuildings.size > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: "#1f6feb22", border: "1px solid #58a6ff55", borderRadius: 6 }}>
                        <span style={{ fontSize: 11, color: "#58a6ff", flex: 1 }}>⬡ {[...selectedBuildings].join(", ")}</span>
                        <button onClick={() => { setSelectedBuildings(new Set()); setBuildingTimeseries(null); setBuildingGeometry(null); setColorByMetric(null); }} style={{ ...styles.miniBtn, fontSize: 10, padding: "2px 8px", color: "#8b949e", borderColor: "#3d4555" }}>Clear</button>
                      </div>
                    )}
                    {/* Cluster legend */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
                      {[...viewClusterIds].sort().map((cid) => {
                        const ci = clusters.indexOf(Number(cid));
                        return (
                          <span key={cid} style={{ fontSize: 10, color: getEffectiveClusterColor(Number(cid), ci >= 0 ? ci : 0), display: "flex", alignItems: "center", gap: 3 }}>
                            <span style={{ width: 8, height: 8, background: getEffectiveClusterColor(Number(cid), ci >= 0 ? ci : 0), display: "inline-block", borderRadius: 1 }} />
                            {cid}
                          </span>
                        );
                      })}
                    </div>
                    {floorData?.labels.length > 0 && <canvas ref={floorCanvasRef} style={{ ...styles.canvas, height: 160 }} />}
                    {periodData?.labels.length > 0 && <canvas ref={periodCanvasRef} style={{ ...styles.canvas, height: 160 }} />}
                    {yearData && <canvas ref={yearCanvasRef} style={{ ...styles.canvas, height: 160 }} />}
                    {buildingTypeData?.labels.length > 0 && <canvas ref={typeCanvasRef} style={{ ...styles.canvas, height: 160 }} />}
                    {!floorData?.labels.length && !periodData?.labels.length && !yearData?.labels.length && !buildingTypeData?.labels.length && (
                      <p style={styles.mapInfo}>No matching property data for sensors in this view.</p>
                    )}
                  </>
                )}
              </>
            )}

            {/* ── Buildings tab ── */}
            {analysisTab === "buildings" && (
              <>
                {!sensorProperties && <p style={styles.mapInfo}>Loading properties…</p>}
                {sensorProperties && (
                  <>
                    <input
                      type="text"
                      placeholder="Search buildings…"
                      value={buildingSearch}
                      onChange={(e) => setBuildingSearch(e.target.value)}
                      style={{ ...styles.searchInput, marginBottom: 0 }}
                    />
                    <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                      {Object.entries(areaGroups)
                        .filter(([name]) => !buildingSearch || name.toLowerCase().includes(buildingSearch.toLowerCase()))
                        .sort(([, a], [, b]) => b.length - a.length)
                        .map(([name, sensors]) => {
                          const selected = selectedBuildings.has(name);
                          // cluster breakdown for this building
                          const clusterCounts = {};
                          sensors.forEach((s) => { const cid = String(s[selectedK]); clusterCounts[cid] = (clusterCounts[cid] || 0) + 1; });
                          return (
                            <div
                              key={name}
                              onClick={() => setSelectedBuildings((prev) => {
                                const next = new Set(prev);
                                if (next.has(name)) next.delete(name); else next.add(name);
                                setBuildingTimeseries(null);
                                return next;
                              })}
                              style={{
                                display: "flex", alignItems: "center", gap: 8, padding: "5px 8px",
                                borderRadius: 5, cursor: "pointer", fontSize: 11,
                                background: selected ? "#1f6feb22" : "transparent",
                                border: `1px solid ${selected ? "#58a6ff" : "#2e3440"}`,
                              }}
                            >
                              <span style={{ flex: 1, color: selected ? "#58a6ff" : "#c9d1d9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                              <span style={{ color: "#8b949e", flexShrink: 0 }}>{sensors.length}</span>
                              <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                                {Object.entries(clusterCounts).map(([cid, cnt]) => {
                                  const ci = clusters.indexOf(Number(cid));
                                  return <span key={cid} title={`Cluster ${cid}: ${cnt}`} style={{ width: 8, height: 8, borderRadius: "50%", background: getEffectiveClusterColor(Number(cid), ci >= 0 ? ci : 0) }} />;
                                })}
                              </div>
                            </div>
                          );
                        })}
                    </div>

                    {selectedBuildings.size > 0 && (
                      <>
                        <p style={{ ...styles.mapInfo, marginBottom: 0 }}>
                          {selectedBuildings.size} building{selectedBuildings.size > 1 ? "s" : ""} selected
                          {buildingTimeseries ? ` · ${Object.keys(buildingTimeseries.sensors).length} sensors` : " · Loading…"}
                        </p>
                        {activeSensorProperties?.length > 0 && (() => {
                          const METRICS = [
                            { key: "dh_2018",        label: "DH 2018"   },
                            { key: "dh_2024",        label: "DH 2024"   },
                            { key: "dh_2025",        label: "DH 2025"   },
                            { key: "Kh above 26°C", label: "h > 26 °C" },
                            { key: "Kh above 27°C", label: "h > 27 °C" },
                            { key: "Kh above 28°C", label: "h > 28 °C" },
                            { key: "tc_h",           label: "tc_h"      },
                          ];
                          return (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 0 2px" }}>
                              {colorByMetric && (
                                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "#8b949e" }}>
                                  <div style={{ flex: 1, height: 6, borderRadius: 3, background: "linear-gradient(to right, #4CC9F0, #FFD93D, #FF4444)" }} />
                                  <span>low → high</span>
                                </div>
                              )}
                              {METRICS.map(({ key, label }) => {
                                const vals = activeSensorProperties
                                  .map((s) => s[key])
                                  .filter((v) => v != null && !isNaN(Number(v)))
                                  .map(Number)
                                  .sort((a, b) => a - b);
                                if (!vals.length) return null;
                                const min = vals[0];
                                const max = vals[vals.length - 1];
                                const med = vals[Math.floor(vals.length / 2)];
                                const range = max - min || 1;
                                const active = colorByMetric === key;
                                return (
                                  <div key={key}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 1 }}>
                                      <span style={{ fontSize: 10, color: active ? "#c9d1d9" : "#8b949e", flex: 1 }}>{label}</span>
                                      <button
                                        onClick={() => setColorByMetric(active ? null : key)}
                                        title={active ? "Reset to cluster colors" : "Color spheres by this metric"}
                                        style={{
                                          background: active ? "#4CC9F055" : "transparent",
                                          border: `1px solid ${active ? "#4CC9F0" : "#3d4555"}`,
                                          borderRadius: 3, padding: "1px 5px", fontSize: 9,
                                          color: active ? "#4CC9F0" : "#6e7681", cursor: "pointer", fontFamily: "inherit",
                                        }}
                                      >
                                        {active ? "◉ on map" : "map"}
                                      </button>
                                    </div>
                                    <div style={{ position: "relative", height: 14 }}>
                                      <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "#2e3440" }} />
                                      {vals.map((v, i) => (
                                        <div key={i} style={{
                                          position: "absolute", top: "50%",
                                          left: `${((v - min) / range) * 100}%`,
                                          transform: "translate(-50%, -50%)",
                                          width: 6, height: 6, borderRadius: "50%",
                                          background: "#58a6ff", opacity: 0.75,
                                        }} />
                                      ))}
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#6e7681" }}>
                                      <span>{min.toFixed(0)}</span>
                                      <span>med {med.toFixed(0)}</span>
                                      <span>{max.toFixed(0)}</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                        <canvas ref={buildingCanvasRef} style={{ ...styles.canvas, height: 220 }} />
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
// ─── Styles ──────────────────────────────────────────────────────
const styles = {
  container: {
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
    backgroundColor: "#1a1f2e",
    color: "#e0e0e0",
    minHeight: "100vh",
    padding: 0,
  },
  header: {
    background: "linear-gradient(135deg, #1a1f2e 0%, #232936 100%)",
    borderBottom: "1px solid #2e3440",
    padding: "20px 24px",
  },
  headerInner: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    margin: 0,
    color: "#e6edf3",
    letterSpacing: "-0.5px",
  },
  subtitle: {
    fontSize: 12,
    color: "#8b949e",
    margin: "4px 0 0 0",
    letterSpacing: "0.5px",
    textTransform: "uppercase",
  },
  kSelector: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  kLabel: {
    fontSize: 12,
    color: "#8b949e",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  select: {
    background: "#232936",
    border: "1px solid #3d4555",
    color: "#e0e0e0",
    padding: "6px 12px",
    borderRadius: 6,
    fontFamily: "inherit",
    fontSize: 13,
  },
  kBadge: {
    background: "#1f6feb22",
    color: "#58a6ff",
    padding: "3px 10px",
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 600,
  },
  uploadSection: {
    padding: "48px 24px",
    textAlign: "center",
  },
  retryBtn: {
    marginTop: 12,
    padding: "8px 20px",
    background: "#2e3440",
    border: "1px solid #3d4555",
    borderRadius: 6,
    color: "#e6edf3",
    cursor: "pointer",
    fontSize: 13,
  },
  error: {
    marginTop: 16,
    color: "#f85149",
    fontSize: 13,
  },
  loading: {
    marginTop: 16,
    color: "#58a6ff",
    fontSize: 13,
  },
  tabBar: {
    display: "flex",
    borderBottom: "1px solid #2e3440",
    padding: "0 24px",
    gap: 0,
    overflowX: "auto",
  },
  tab: {
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#8b949e",
    padding: "12px 20px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    display: "flex",
    alignItems: "center",
    gap: 8,
    transition: "color 0.15s",
  },
  tabActive: {
    color: "#e6edf3",
    borderBottomColor: "#58a6ff",
  },
  tabIcon: {
    fontSize: 14,
  },
  clusterBar: {
    padding: "12px 24px",
    borderBottom: "1px solid #2e3440",
    background: "#23293688",
  },
  clusterBarHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
  },
  clusterBarTitle: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "1px",
    color: "#8b949e",
    fontWeight: 600,
  },
  miniBtn: {
    background: "none",
    border: "1px solid #3d4555",
    color: "#8b949e",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 10,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  clusterChips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    border: "1px solid",
    borderRadius: 16,
    padding: "3px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all 0.15s",
  },
  chipCount: {
    fontWeight: 400,
    fontSize: 10,
    opacity: 0.8,
  },
  main: {
    padding: 24,
  },
  toolRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
  },
  toolLabel: {
    fontSize: 12,
    color: "#8b949e",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  toolBtn: {
    background: "#232936",
    border: "1px solid #3d4555",
    color: "#8b949e",
    padding: "5px 14px",
    borderRadius: 6,
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all 0.15s",
  },
  toolBtnActive: {
    background: "#1f6feb33",
    borderColor: "#58a6ff",
    color: "#58a6ff",
  },
  canvas: {
    width: "100%",
    height: 420,
    borderRadius: 8,
    border: "1px solid #2e3440",
    display: "block",
  },
  emptyState: {
    textAlign: "center",
    padding: "80px 24px",
    color: "#8b949e",
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
    opacity: 0.3,
  },
  emptyHint: {
    fontSize: 12,
    marginTop: 8,
    opacity: 0.6,
  },
  toggleLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "#c9d1d9",
    cursor: "pointer",
  },
  checkbox: {
    accentColor: "#58a6ff",
  },
  sensorPicker: {
    marginTop: 16,
    padding: 16,
    border: "1px solid #2e3440",
    borderRadius: 8,
    background: "#232936",
  },
  searchInput: {
    width: "100%",
    padding: "8px 12px",
    background: "#1a1f2e",
    border: "1px solid #3d4555",
    borderRadius: 6,
    color: "#e0e0e0",
    fontFamily: "inherit",
    fontSize: 13,
    marginBottom: 10,
    boxSizing: "border-box",
  },
  sensorList: {
    display: "flex",
    flexWrap: "wrap",
    gap: 4,
    maxHeight: 160,
    overflowY: "auto",
  },
  sensorChip: {
    border: "1px solid #3d4555",
    borderRadius: 4,
    padding: "2px 8px",
    fontSize: 11,
    color: "#c9d1d9",
    cursor: "pointer",
    fontFamily: "inherit",
    background: "none",
    transition: "all 0.1s",
  },
  moreHint: {
    fontSize: 11,
    color: "#8b949e",
    fontStyle: "italic",
    padding: "4px 8px",
  },
  mapInfo: {
    fontSize: 12,
    color: "#8b949e",
    marginBottom: 8,
  },
  th: {
    padding: "4px 8px",
    textAlign: "left",
    fontSize: 10,
    color: "#8b949e",
    borderBottom: "1px solid #2e3440",
    textTransform: "uppercase",
    letterSpacing: "0.4px",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "3px 8px",
    fontSize: 11,
    color: "#c9d1d9",
    borderBottom: "1px solid #232936",
    whiteSpace: "nowrap",
  },
  tooltip: {
    position: "absolute",
    background: "#2a303d",
    border: "1px solid #3d4555",
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: 12,
    color: "#e0e0e0",
    pointerEvents: "none",
    zIndex: 10,
    lineHeight: 1.5,
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  },
  rfConfig: {
    padding: 20,
    border: "1px solid #2e3440",
    borderRadius: 8,
    background: "#232936",
    marginBottom: 20,
  },
  rfTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#e6edf3",
    marginBottom: 12,
    marginTop: 0,
  },
  rfConfigSection: {
    marginBottom: 16,
  },
  featureGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  featureLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#c9d1d9",
    cursor: "pointer",
    padding: "4px 10px",
    background: "#1a1f2e",
    borderRadius: 6,
    border: "1px solid #2e3440",
  },
  runBtn: {
    background: "linear-gradient(135deg, #238636 0%, #2ea043 100%)",
    border: "none",
    color: "#fff",
    padding: "10px 24px",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    letterSpacing: "0.3px",
  },
  rfNote: {
    fontSize: 11,
    color: "#8b949e",
    marginTop: 10,
    fontStyle: "italic",
  },
  rfResults: {
    border: "1px solid #2e3440",
    borderRadius: 8,
    padding: 20,
    background: "#232936",
  },
  rfStats: {
    display: "flex",
    gap: 24,
    marginBottom: 20,
    fontSize: 12,
    color: "#8b949e",
  },
  rfBars: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  rfBarRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  rfBarLabel: {
    width: 140,
    fontSize: 12,
    color: "#c9d1d9",
    textAlign: "right",
    flexShrink: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rfBarTrack: {
    flex: 1,
    height: 20,
    background: "#1a1f2e",
    borderRadius: 4,
    overflow: "hidden",
  },
  rfBarFill: {
    height: "100%",
    borderRadius: 4,
    transition: "width 0.4s ease-out",
  },
  rfBarValue: {
    width: 60,
    fontSize: 11,
    color: "#8b949e",
    textAlign: "right",
  },
};
