import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";
import { API, getClusterColor, GROUP_COLORS, TABS } from "./constants.js";
import { fetchData } from "./api.js";
import { styles } from "./styles.js";
import DegreeHoursMap from "./DegreeHoursMap";
import { MetadataStats } from "./tabs/MetadataStats";
import { ClusterProfiles } from "./tabs/ClusterProfiles";
import { TimeSeriesView } from "./tabs/TimeSeriesView";
import MapView from "./tabs/MapView";

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
    const { data, errors, meta } = Papa.parse(text.trim(), {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });
    if (errors.length > 0 && data.length === 0)
      throw new Error(`CSV parse error: ${errors[0].message}`);

    const headers = meta.fields ?? [];
    const nameField = headers.find((h) => h.toLowerCase() === "combined_name");
    if (!nameField) throw new Error('CSV must have a "combined_name" column');

    const clusterField = headers.find((h) => h !== nameField);
    if (!clusterField) throw new Error("CSV must have at least two columns");

    const mapping = {};
    for (const row of data) {
      const sensorId = row[nameField]?.trim();
      const raw = row[clusterField]?.trim();
      if (sensorId && raw !== "" && raw != null) {
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n)) mapping[sensorId] = n;
      }
    }
    if (Object.keys(mapping).length === 0) throw new Error("No valid rows found in CSV");
    return { colName: clusterField, mapping };
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
