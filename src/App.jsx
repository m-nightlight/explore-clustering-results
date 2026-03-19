import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as d3 from "d3";
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";

const API = "http://localhost:8000";

// ─── Theme & Constants ───────────────────────────────────────────
const COLORS = [
  "#E63946","#457B9D","#2A9D8F","#E9C46A","#F4A261",
  "#264653","#A8DADC","#6A0572","#AB83A1","#1D3557",
  "#F77F00","#D62828","#023E8A","#0077B6","#00B4D8",
  "#90BE6D","#F94144","#277DA1","#577590","#4D908E",
  "#43AA8B","#F3722C","#F8961E","#F9844A","#F9C74F",
];

const getClusterColor = (i) => COLORS[i % COLORS.length];

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
  { id: "profiles", label: "Cluster Profiles", icon: "◈" },
  { id: "timeseries", label: "Time Series", icon: "◆" },
  { id: "map", label: "Sensor Map", icon: "◉" },
  { id: "rf", label: "RF Importance", icon: "◊" },
];

// ─── Main App ────────────────────────────────────────────────────
export default function App() {
  const [timeSeriesData, setTimeSeriesData] = useState(null);
  const [metadataData, setMetadataData] = useState(null);
  const [activeTab, setActiveTab] = useState("profiles");
  const [selectedK, setSelectedK] = useState(null);
  const [clusterColumns, setClusterColumns] = useState([]);
  const [selectedClusters, setSelectedClusters] = useState(new Set());
  const [selectedSensors, setSelectedSensors] = useState(new Set());
  const [sensorSearch, setSensorSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Derive cluster columns from metadata
  useEffect(() => {
    if (!metadataData || metadataData.length === 0) return;
    const cols = Object.keys(metadataData[0]).filter(
      (c) => c.toLowerCase().startsWith("cluster") || c.toLowerCase().startsWith("k_") || c.toLowerCase().match(/^k\d+/)
    );
    if (cols.length === 0) {
      // Try to find columns with small unique value counts that could be clusters
      const potentialClusters = Object.keys(metadataData[0]).filter((c) => {
        const unique = new Set(metadataData.map((r) => r[c]));
        return unique.size >= 2 && unique.size <= 50 && c !== "lat" && c !== "lon" && c !== "latitude" && c !== "longitude";
      });
      // Show all columns as options if no cluster prefix found
      setClusterColumns(potentialClusters);
    } else {
      setClusterColumns(cols);
    }
  }, [metadataData]);

  useEffect(() => {
    if (clusterColumns.length > 0 && !selectedK) {
      setSelectedK(clusterColumns[0]);
    }
  }, [clusterColumns]);

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

  // Metadata feature columns (non-cluster, non-id, non-location)
  const featureColumns = useMemo(() => {
    if (!metadataData || metadataData.length === 0) return [];
    const exclude = new Set([
      sensorIdCol, "lat", "lon", "latitude", "longitude", "lng",
      ...clusterColumns,
    ].filter(Boolean).map(s => s.toLowerCase()));
    return Object.keys(metadataData[0]).filter(
      (c) => !exclude.has(c.toLowerCase())
    );
  }, [metadataData, sensorIdCol, clusterColumns]);

  const loadData = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [timeseries, metadata] = await Promise.all([
        fetchData("/data/timeseries"),
        fetchData("/data/metadata"),
      ]);
      if (!timeseries.length) throw new Error("temperatures.parquet is empty");
      if (!metadata.length) throw new Error("metadata_clusters.parquet is empty");
      setTimeSeriesData(timeseries);
      setMetadataData(metadata);
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
                {clusterColumns.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <span style={styles.kBadge}>{clusters.length} clusters</span>
            </div>
          )}
        </div>
      </header>

      {/* Loading / Error State */}
      {(!timeSeriesData || !metadataData) && (
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
            </div>
            <div style={styles.clusterChips}>
              {clusters.map((c, i) => {
                const count = metadataData.filter((r) => r[selectedK] === c).length;
                return (
                  <button
                    key={c}
                    onClick={() => toggleCluster(c)}
                    style={{
                      ...styles.chip,
                      backgroundColor: selectedClusters.has(c) ? getClusterColor(i) : "transparent",
                      color: selectedClusters.has(c) ? "#fff" : "#999",
                      borderColor: getClusterColor(i),
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
                timeSeriesData={timeSeriesData}
                metadataData={metadataData}
                selectedK={selectedK}
                clusters={clusters}
                selectedClusters={selectedClusters}
                sensorClusterMap={sensorClusterMap}
                sensorIdCol={sensorIdCol}
              />
            )}
            {activeTab === "timeseries" && (
              <TimeSeriesView
                timeSeriesData={timeSeriesData}
                metadataData={metadataData}
                selectedK={selectedK}
                clusters={clusters}
                selectedClusters={selectedClusters}
                sensorClusterMap={sensorClusterMap}
                sensorIdCol={sensorIdCol}
                selectedSensors={selectedSensors}
                setSelectedSensors={setSelectedSensors}
                sensorSearch={sensorSearch}
                setSensorSearch={setSensorSearch}
              />
            )}
            {activeTab === "map" && (
              <MapView
                metadataData={metadataData}
                selectedK={selectedK}
                clusters={clusters}
                selectedClusters={selectedClusters}
                sensorIdCol={sensorIdCol}
                timeSeriesData={timeSeriesData}
                sensorClusterMap={sensorClusterMap}
              />
            )}
            {activeTab === "rf" && (
              <RFImportance
                metadataData={metadataData}
                selectedK={selectedK}
                sensorIdCol={sensorIdCol}
                featureColumns={featureColumns}
                clusterColumns={clusterColumns}
              />
            )}
          </main>
        </>
      )}
    </div>
  );
}


// ─── Cluster Profiles ────────────────────────────────────────────
function ClusterProfiles({ timeSeriesData, metadataData, selectedK, clusters, selectedClusters, sensorClusterMap, sensorIdCol }) {
  const [profileType, setProfileType] = useState("mean");
  const canvasRef = useRef();

  // Compute cluster profiles from time series
  const profiles = useMemo(() => {
    if (!timeSeriesData || timeSeriesData.length === 0) return null;
    const dateCol = Object.keys(timeSeriesData[0]).find(
      (c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("time") || c.toLowerCase() === "index"
    ) || Object.keys(timeSeriesData[0])[0];

    const sensorCols = Object.keys(timeSeriesData[0]).filter((c) => c !== dateCol);
    const timestamps = timeSeriesData.map((r) => r[dateCol]);
    const result = {};

    clusters.forEach((clusterId) => {
      const sensorsInCluster = sensorCols.filter((s) => sensorClusterMap[s] === clusterId);
      if (sensorsInCluster.length === 0) return;

      const values = timestamps.map((_, ti) => {
        const row = timeSeriesData[ti];
        const vals = sensorsInCluster.map((s) => row[s]).filter((v) => v !== null && v !== undefined && !isNaN(v));
        if (vals.length === 0) return null;
        if (profileType === "mean") return d3.mean(vals);
        if (profileType === "median") return d3.median(vals);
        return d3.mean(vals);
      });

      // Also compute spread
      const q25 = timestamps.map((_, ti) => {
        const row = timeSeriesData[ti];
        const vals = sensorsInCluster.map((s) => row[s]).filter((v) => v !== null && v !== undefined && !isNaN(v));
        return vals.length > 0 ? d3.quantile(vals.sort(d3.ascending), 0.25) : null;
      });
      const q75 = timestamps.map((_, ti) => {
        const row = timeSeriesData[ti];
        const vals = sensorsInCluster.map((s) => row[s]).filter((v) => v !== null && v !== undefined && !isNaN(v));
        return vals.length > 0 ? d3.quantile(vals.sort(d3.ascending), 0.75) : null;
      });

      result[clusterId] = { values, q25, q75, count: sensorsInCluster.length };
    });

    return { profiles: result, timestamps };
  }, [timeSeriesData, clusters, sensorClusterMap, profileType]);

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
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, w, h);

    // Gather all values for y scale
    let allVals = [];
    clusters.forEach((c, i) => {
      if (!selectedClusters.has(c) || !profiles.profiles[c]) return;
      allVals.push(...profiles.profiles[c].values.filter((v) => v !== null));
      allVals.push(...profiles.profiles[c].q25.filter((v) => v !== null));
      allVals.push(...profiles.profiles[c].q75.filter((v) => v !== null));
    });
    if (allVals.length === 0) return;

    const yExtent = d3.extent(allVals);
    const yPad = (yExtent[1] - yExtent[0]) * 0.05;
    const xScale = d3.scaleLinear().domain([0, profiles.timestamps.length - 1]).range([margin.left, margin.left + pw]);
    const yScale = d3.scaleLinear().domain([yExtent[0] - yPad, yExtent[1] + yPad]).range([margin.top + ph, margin.top]);

    // Grid lines
    ctx.strokeStyle = "#1a2030";
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
      if (!selectedClusters.has(c) || !profiles.profiles[c]) return;
      const p = profiles.profiles[c];
      const color = getClusterColor(ci);

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

    // Legend
    let lx = margin.left + 10;
    let ly = margin.top + 10;
    clusters.forEach((c, ci) => {
      if (!selectedClusters.has(c) || !profiles.profiles[c]) return;
      ctx.fillStyle = getClusterColor(ci);
      ctx.fillRect(lx, ly, 12, 12);
      ctx.fillStyle = "#ccc";
      ctx.font = "11px monospace";
      ctx.textAlign = "left";
      const label = `Cluster ${c} (n=${profiles.profiles[c].count})`;
      ctx.fillText(label, lx + 16, ly + 10);
      lx += ctx.measureText(label).width + 36;
      if (lx > w - 150) { lx = margin.left + 10; ly += 18; }
    });
  }, [profiles, selectedClusters, clusters]);

  if (!timeSeriesData) {
    return (
      <div style={styles.emptyState}>
        <p style={styles.emptyIcon}>◈</p>
        <p>Upload time series data to view cluster profiles</p>
        <p style={styles.emptyHint}>Profiles show the mean/median temperature pattern for each cluster with IQR bands</p>
      </div>
    );
  }

  return (
    <div>
      <div style={styles.toolRow}>
        <span style={styles.toolLabel}>Profile Type:</span>
        {["mean", "median"].map((t) => (
          <button
            key={t}
            onClick={() => setProfileType(t)}
            style={{
              ...styles.toolBtn,
              ...(profileType === t ? styles.toolBtnActive : {}),
            }}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <canvas ref={canvasRef} style={styles.canvas} width={900} height={420} />
    </div>
  );
}

// ─── Time Series View ────────────────────────────────────────────
function TimeSeriesView({ timeSeriesData, metadataData, selectedK, clusters, selectedClusters, sensorClusterMap, sensorIdCol, selectedSensors, setSelectedSensors, sensorSearch, setSensorSearch }) {
  const canvasRef = useRef();
  const drillCanvasRef = useRef();
  const [showIndividual, setShowIndividual] = useState(false);
  const [drillClusters, setDrillClusters] = useState(new Set());

  const sensorList = useMemo(() => {
    if (!timeSeriesData || timeSeriesData.length === 0) return [];
    const dateCol = Object.keys(timeSeriesData[0]).find(
      (c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("time") || c.toLowerCase() === "index"
    ) || Object.keys(timeSeriesData[0])[0];
    return Object.keys(timeSeriesData[0]).filter((c) => c !== dateCol);
  }, [timeSeriesData]);

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
    if (!timeSeriesData || !canvasRef.current) return;
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
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, w, h);

    const dateCol = Object.keys(timeSeriesData[0]).find(
      (c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("time") || c.toLowerCase() === "index"
    ) || Object.keys(timeSeriesData[0])[0];

    const timestamps = timeSeriesData.map((r) => r[dateCol]);
    const xScale = d3.scaleLinear().domain([0, timestamps.length - 1]).range([margin.left, margin.left + pw]);

    // Collect all visible values for y scale
    let allVals = [];
    const visibleSensors = showIndividual ? [...selectedSensors] : [];

    // Cluster aggregates
    const clusterAggs = {};
    clusters.forEach((clusterId) => {
      if (!selectedClusters.has(clusterId)) return;
      const sensorCols = sensorList.filter((s) => sensorClusterMap[s] === clusterId);
      if (sensorCols.length === 0) return;
      clusterAggs[clusterId] = timestamps.map((_, ti) => {
        const row = timeSeriesData[ti];
        const vals = sensorCols.map((s) => row[s]).filter((v) => v != null && !isNaN(v));
        return vals.length > 0 ? d3.mean(vals) : null;
      });
      allVals.push(...clusterAggs[clusterId].filter((v) => v !== null));
    });

    // Individual sensor values
    const sensorLines = {};
    visibleSensors.forEach((s) => {
      sensorLines[s] = timestamps.map((_, ti) => timeSeriesData[ti][s]).filter((v) => v != null);
      allVals.push(...sensorLines[s]);
    });

    if (allVals.length === 0) return;

    const yExtent = d3.extent(allVals);
    const yPad = (yExtent[1] - yExtent[0]) * 0.05 || 1;
    const yScale = d3.scaleLinear().domain([yExtent[0] - yPad, yExtent[1] + yPad]).range([margin.top + ph, margin.top]);

    // Grid
    ctx.strokeStyle = "#1a2030";
    ctx.lineWidth = 1;
    yScale.ticks(6).forEach((t) => {
      ctx.beginPath();
      ctx.moveTo(margin.left, yScale(t));
      ctx.lineTo(margin.left + pw, yScale(t));
      ctx.stroke();
    });

    // Y labels
    ctx.fillStyle = "#667";
    ctx.font = "11px monospace";
    ctx.textAlign = "right";
    yScale.ticks(6).forEach((t) => ctx.fillText(t.toFixed(1), margin.left - 8, yScale(t) + 4));

    // X labels
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(timestamps.length / 8));
    for (let i = 0; i < timestamps.length; i += step) {
      ctx.fillText(String(timestamps[i]).slice(0, 16), xScale(i), margin.top + ph + 20);
    }

    // Draw cluster aggregates
    clusters.forEach((c, ci) => {
      if (!clusterAggs[c]) return;
      ctx.strokeStyle = getClusterColor(ci);
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      clusterAggs[c].forEach((v, i) => {
        if (v === null) return;
        if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
        else ctx.lineTo(xScale(i), yScale(v));
      });
      ctx.stroke();
    });

    // Draw individual sensors
    visibleSensors.forEach((s) => {
      const clusterId = sensorClusterMap[s];
      const ci = clusters.indexOf(clusterId);
      ctx.strokeStyle = (ci >= 0 ? getClusterColor(ci) : "#888") + "88";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      let started = false;
      timestamps.forEach((_, i) => {
        const v = timeSeriesData[i][s];
        if (v == null || isNaN(v)) return;
        if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
        else ctx.lineTo(xScale(i), yScale(v));
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }, [timeSeriesData, selectedClusters, clusters, sensorClusterMap, selectedSensors, showIndividual, sensorList]);

  // Drill-down chart: all individual sensors for selected drill clusters
  useEffect(() => {
    if (!timeSeriesData || !drillCanvasRef.current || drillClusters.size === 0) return;
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
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, w, h);

    const dateCol = Object.keys(timeSeriesData[0]).find(
      (c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("time") || c.toLowerCase() === "index"
    ) || Object.keys(timeSeriesData[0])[0];
    const timestamps = timeSeriesData.map((r) => r[dateCol]);
    const xScale = d3.scaleLinear().domain([0, timestamps.length - 1]).range([margin.left, margin.left + pw]);

    const drillSensors = sensorList.filter((s) => drillClusters.has(sensorClusterMap[s]));
    const allVals = drillSensors.flatMap((s) =>
      timeSeriesData.map((r) => r[s]).filter((v) => v != null && !isNaN(v))
    );
    if (allVals.length === 0) return;

    const yExtent = d3.extent(allVals);
    const yPad = (yExtent[1] - yExtent[0]) * 0.05 || 1;
    const yScale = d3.scaleLinear().domain([yExtent[0] - yPad, yExtent[1] + yPad]).range([margin.top + ph, margin.top]);

    // Grid
    ctx.strokeStyle = "#1a2030";
    ctx.lineWidth = 1;
    yScale.ticks(6).forEach((t) => {
      ctx.beginPath();
      ctx.moveTo(margin.left, yScale(t));
      ctx.lineTo(margin.left + pw, yScale(t));
      ctx.stroke();
    });

    // Y labels
    ctx.fillStyle = "#667";
    ctx.font = "11px monospace";
    ctx.textAlign = "right";
    yScale.ticks(6).forEach((t) => ctx.fillText(t.toFixed(1), margin.left - 8, yScale(t) + 4));

    // X labels
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(timestamps.length / 8));
    for (let i = 0; i < timestamps.length; i += step) {
      ctx.fillText(String(timestamps[i]).slice(0, 16), xScale(i), margin.top + ph + 20);
    }

    // Draw each sensor line
    drillSensors.forEach((s) => {
      const ci = clusters.indexOf(sensorClusterMap[s]);
      ctx.strokeStyle = (ci >= 0 ? getClusterColor(ci) : "#888") + "40";
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      timestamps.forEach((_, i) => {
        const v = timeSeriesData[i][s];
        if (v == null || isNaN(v)) return;
        if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
        else ctx.lineTo(xScale(i), yScale(v));
      });
      ctx.stroke();
    });

    // Draw cluster mean lines on top (dashed, full color)
    [...drillClusters].forEach((clusterId) => {
      const ci = clusters.indexOf(clusterId);
      const clusterSensors = drillSensors.filter((s) => sensorClusterMap[s] === clusterId);
      if (clusterSensors.length === 0) return;
      const meanLine = timestamps.map((_, ti) => {
        const vals = clusterSensors.map((s) => timeSeriesData[ti][s]).filter((v) => v != null && !isNaN(v));
        return vals.length > 0 ? d3.mean(vals) : null;
      });
      ctx.strokeStyle = getClusterColor(ci);
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      let started = false;
      meanLine.forEach((v, i) => {
        if (v === null) return;
        if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
        else ctx.lineTo(xScale(i), yScale(v));
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }, [timeSeriesData, drillClusters, clusters, sensorClusterMap, sensorList]);

  if (!timeSeriesData) {
    return (
      <div style={styles.emptyState}>
        <p style={styles.emptyIcon}>◆</p>
        <p>Upload time series data to explore sensor readings</p>
      </div>
    );
  }

  return (
    <div>
      {/* ── Chart 1: Cluster averages ── */}
      <div style={styles.toolRow}>
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
      <div style={{ marginTop: 32, borderTop: "1px solid #21262d", paddingTop: 20 }}>
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
              {sensorList.filter((s) => drillClusters.has(sensorClusterMap[s])).length} sensors — individual lines colored by cluster
            </p>
            <canvas ref={drillCanvasRef} style={styles.canvas} width={900} height={420} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Map View ────────────────────────────────────────────────────
function BoundsTracker({ onChange }) {
  useMapEvents({
    moveend: (e) => onChange(e.target.getBounds()),
    zoomend: (e) => onChange(e.target.getBounds()),
  });
  return null;
}

function MapView({ metadataData, selectedK, clusters, selectedClusters, sensorIdCol, timeSeriesData, sensorClusterMap }) {
  const [visibleBounds, setVisibleBounds] = useState(null);
  const [analysedSensors, setAnalysedSensors] = useState(null);
  const canvasRef = useRef();

  const sensorLocations = useMemo(() => {
    if (!metadataData) return [];
    const latCol = Object.keys(metadataData[0]).find((c) => c.toLowerCase().includes("lat"));
    const lonCol = Object.keys(metadataData[0]).find((c) => c.toLowerCase().includes("lon") || c.toLowerCase().includes("lng"));
    if (!latCol || !lonCol) return [];
    return metadataData
      .filter((r) => r[latCol] != null && r[lonCol] != null && selectedClusters.has(r[selectedK]))
      .map((r) => ({
        id: r[sensorIdCol],
        lat: +r[latCol],
        lon: +r[lonCol],
        cluster: r[selectedK],
      }));
  }, [metadataData, selectedK, selectedClusters, sensorIdCol]);

  const center = useMemo(() => {
    if (!sensorLocations.length) return [0, 0];
    const avgLat = sensorLocations.reduce((s, d) => s + d.lat, 0) / sensorLocations.length;
    const avgLon = sensorLocations.reduce((s, d) => s + d.lon, 0) / sensorLocations.length;
    return [avgLat, avgLon];
  }, [sensorLocations]);

  const visibleSensors = useMemo(() => {
    if (!visibleBounds) return sensorLocations;
    return sensorLocations.filter((d) =>
      d.lat >= visibleBounds._southWest.lat &&
      d.lat <= visibleBounds._northEast.lat &&
      d.lon >= visibleBounds._southWest.lng &&
      d.lon <= visibleBounds._northEast.lng
    );
  }, [sensorLocations, visibleBounds]);

  const analyseView = () => setAnalysedSensors(visibleSensors);

  // Cluster breakdown for analysed (or visible) sensors
  const displaySensors = analysedSensors ?? [];
  const byCluster = useMemo(() => {
    const counts = {};
    displaySensors.forEach((d) => { counts[d.cluster] = (counts[d.cluster] || 0) + 1; });
    return counts;
  }, [displaySensors]);

  const presentClusters = useMemo(() =>
    clusters.filter((c) => byCluster[c] > 0),
    [clusters, byCluster]
  );

  // Draw cluster mean time series for analysed sensors
  useEffect(() => {
    if (!analysedSensors || !canvasRef.current || !timeSeriesData) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const margin = { top: 16, right: 20, bottom: 44, left: 52 };
    const pw = w - margin.left - margin.right;
    const ph = h - margin.top - margin.bottom;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, w, h);

    const dateCol = Object.keys(timeSeriesData[0]).find(
      (c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("time") || c.toLowerCase() === "index"
    ) || Object.keys(timeSeriesData[0])[0];
    const timestamps = timeSeriesData.map((r) => r[dateCol]);
    const xScale = d3.scaleLinear().domain([0, timestamps.length - 1]).range([margin.left, margin.left + pw]);

    const sensorIds = new Set(analysedSensors.map((d) => d.id));
    const clusterAggs = {};
    presentClusters.forEach((clusterId) => {
      const sensorCols = [...sensorIds].filter((s) => sensorClusterMap[s] === clusterId);
      if (!sensorCols.length) return;
      clusterAggs[clusterId] = timestamps.map((_, ti) => {
        const row = timeSeriesData[ti];
        const vals = sensorCols.map((s) => row[s]).filter((v) => v != null && !isNaN(v));
        return vals.length > 0 ? d3.mean(vals) : null;
      });
    });

    const allVals = Object.values(clusterAggs).flat().filter((v) => v !== null);
    if (!allVals.length) return;

    const yExtent = d3.extent(allVals);
    const yPad = (yExtent[1] - yExtent[0]) * 0.05 || 1;
    const yScale = d3.scaleLinear().domain([yExtent[0] - yPad, yExtent[1] + yPad]).range([margin.top + ph, margin.top]);

    // Grid + labels
    ctx.strokeStyle = "#1a2030";
    ctx.lineWidth = 1;
    yScale.ticks(5).forEach((t) => {
      ctx.beginPath();
      ctx.moveTo(margin.left, yScale(t));
      ctx.lineTo(margin.left + pw, yScale(t));
      ctx.stroke();
    });
    ctx.fillStyle = "#667";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    yScale.ticks(5).forEach((t) => ctx.fillText(t.toFixed(1), margin.left - 6, yScale(t) + 3));
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(timestamps.length / 6));
    for (let i = 0; i < timestamps.length; i += step) {
      ctx.fillText(String(timestamps[i]).slice(0, 10), xScale(i), margin.top + ph + 16);
    }

    // Cluster mean lines
    presentClusters.forEach((clusterId) => {
      if (!clusterAggs[clusterId]) return;
      const ci = clusters.indexOf(clusterId);
      ctx.strokeStyle = getClusterColor(ci);
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      clusterAggs[clusterId].forEach((v, i) => {
        if (v === null) return;
        if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; }
        else ctx.lineTo(xScale(i), yScale(v));
      });
      ctx.stroke();
    });
  }, [analysedSensors, timeSeriesData, clusters, presentClusters, sensorClusterMap]);

  if (!metadataData) {
    return (
      <div style={styles.emptyState}>
        <p style={styles.emptyIcon}>◉</p>
        <p>No metadata with lat/lon available</p>
      </div>
    );
  }

  const radius = sensorLocations.length > 2000 ? 3 : 6;

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      {/* Map */}
      <div style={{ flex: "0 0 50%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <p style={{ ...styles.mapInfo, margin: 0 }}>{sensorLocations.length.toLocaleString()} sensors • {visibleSensors.length.toLocaleString()} in view</p>
          <button
            onClick={analyseView}
            style={{ ...styles.miniBtn, padding: "4px 12px", fontSize: 11, borderColor: "#457B9D", color: "#457B9D" }}
          >
            Analyse view
          </button>
        </div>
        <div style={{ height: 560, borderRadius: 8, overflow: "hidden", border: "1px solid #21262d" }}>
          <MapContainer center={center} zoom={7} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <BoundsTracker onChange={setVisibleBounds} />
            {sensorLocations.map((d) => (
              <CircleMarker
                key={d.id}
                center={[d.lat, d.lon]}
                radius={radius}
                pathOptions={{
                  color: "transparent",
                  fillColor: getClusterColor(clusters.indexOf(d.cluster)),
                  fillOpacity: 0.8,
                }}
              >
                <Tooltip>
                  <strong>{d.id}</strong><br />
                  Cluster: {d.cluster}
                </Tooltip>
              </CircleMarker>
            ))}
          </MapContainer>
        </div>
      </div>

      {/* Side panel */}
      <div style={{ flex: "0 0 calc(50% - 16px)", display: "flex", flexDirection: "column", gap: 12 }}>
        {!analysedSensors ? (
          <p style={styles.mapInfo}>Set your view and click "Analyse view" to inspect the area.</p>
        ) : (
          <>
            <p style={styles.mapInfo}>{displaySensors.length.toLocaleString()} sensors analysed</p>

            {/* Cluster breakdown */}
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {clusters.map((c, i) => {
                const count = byCluster[c] || 0;
                const pct = displaySensors.length > 0 ? count / displaySensors.length : 0;
                return (
                  <div key={c} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: count > 0 ? getClusterColor(i) : "#444", fontSize: 11, fontWeight: 600, width: 70, flexShrink: 0 }}>
                      Cluster {c}
                    </span>
                    <div style={{ flex: 1, background: "#161b22", borderRadius: 4, height: 12, overflow: "hidden" }}>
                      <div style={{ width: `${pct * 100}%`, height: "100%", background: getClusterColor(i), borderRadius: 4 }} />
                    </div>
                    <span style={{ fontSize: 11, color: "#8b949e", width: 36, textAlign: "right", flexShrink: 0 }}>{count}</span>
                  </div>
                );
              })}
            </div>

            {/* Time series chart */}
            {presentClusters.length > 0 && (
              <>
                <p style={{ ...styles.mapInfo, marginBottom: 0 }}>Cluster mean temperatures — {presentClusters.length} cluster{presentClusters.length > 1 ? "s" : ""} in view</p>
                <canvas ref={canvasRef} style={{ ...styles.canvas, height: 280 }} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── RF Feature Importance ───────────────────────────────────────
function RFImportance({ metadataData, selectedK, sensorIdCol, featureColumns, clusterColumns }) {
  const [rfResult, setRfResult] = useState(null);
  const [rfLoading, setRfLoading] = useState(false);
  const [selectedFeatures, setSelectedFeatures] = useState(new Set());
  const [nEstimators, setNEstimators] = useState(100);

  useEffect(() => {
    if (featureColumns.length > 0 && selectedFeatures.size === 0) {
      setSelectedFeatures(new Set(featureColumns));
    }
  }, [featureColumns]);

  const toggleFeature = (f) => {
    setSelectedFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const runRF = useCallback(async () => {
    if (!metadataData || selectedFeatures.size === 0) return;
    setRfLoading(true);

    // Simple RF using the Anthropic API to compute feature importance
    // We'll do a client-side Gini importance approximation using decision stumps
    // For a proper RF, the user should use Python — here we compute a JS-based proxy

    try {
      const features = [...selectedFeatures];
      const rows = metadataData.filter((r) => r[selectedK] != null);
      const labels = rows.map((r) => r[selectedK]);
      const uniqueLabels = [...new Set(labels)];

      // Encode categorical features
      const encodedData = rows.map((r) => {
        const encoded = {};
        features.forEach((f) => {
          const val = r[f];
          if (typeof val === "number" && !isNaN(val)) {
            encoded[f] = val;
          } else {
            encoded[f] = String(val);
          }
        });
        return encoded;
      });

      // Compute mutual information / association for each feature
      const importances = features.map((f) => {
        const values = encodedData.map((r) => r[f]);
        const isNumeric = typeof values[0] === "number";

        if (isNumeric) {
          // For numeric: compute variance reduction (like a decision tree split)
          const sorted = values.map((v, i) => ({ v, label: labels[i] })).sort((a, b) => a.v - b.v);
          let bestGain = 0;
          const totalEntropy = computeEntropy(labels, uniqueLabels);

          const step = Math.max(1, Math.floor(sorted.length / 20));
          for (let i = step; i < sorted.length - step; i += step) {
            const leftLabels = sorted.slice(0, i).map((s) => s.label);
            const rightLabels = sorted.slice(i).map((s) => s.label);
            const leftEntropy = computeEntropy(leftLabels, uniqueLabels);
            const rightEntropy = computeEntropy(rightLabels, uniqueLabels);
            const weightedEntropy = (leftLabels.length * leftEntropy + rightLabels.length * rightEntropy) / sorted.length;
            const gain = totalEntropy - weightedEntropy;
            if (gain > bestGain) bestGain = gain;
          }
          return { feature: f, importance: bestGain, type: "numeric" };
        } else {
          // Categorical: compute information gain
          const totalEntropy = computeEntropy(labels, uniqueLabels);
          const groups = {};
          values.forEach((v, i) => {
            if (!groups[v]) groups[v] = [];
            groups[v].push(labels[i]);
          });
          let weightedEntropy = 0;
          Object.values(groups).forEach((g) => {
            weightedEntropy += (g.length / values.length) * computeEntropy(g, uniqueLabels);
          });
          return { feature: f, importance: totalEntropy - weightedEntropy, type: "categorical" };
        }
      });

      importances.sort((a, b) => b.importance - a.importance);

      // Normalize
      const maxImp = importances[0]?.importance || 1;
      importances.forEach((imp) => (imp.normalized = imp.importance / maxImp));

      // Compute balanced accuracy proxy
      const totalEntropy = computeEntropy(labels, uniqueLabels);
      const avgGain = d3.mean(importances.map((imp) => imp.importance));

      setRfResult({
        importances,
        nSamples: rows.length,
        nFeatures: features.length,
        nClusters: uniqueLabels.length,
        baselineEntropy: totalEntropy,
      });
    } catch (e) {
      console.error(e);
    }
    setRfLoading(false);
  }, [metadataData, selectedK, selectedFeatures, sensorIdCol, nEstimators]);

  if (!metadataData) {
    return (
      <div style={styles.emptyState}>
        <p style={styles.emptyIcon}>◊</p>
        <p>Upload metadata to analyse feature importance</p>
      </div>
    );
  }

  return (
    <div>
      <div style={styles.rfConfig}>
        <div style={styles.rfConfigSection}>
          <h3 style={styles.rfTitle}>Select Features</h3>
          <div style={styles.featureGrid}>
            {featureColumns.map((f) => (
              <label key={f} style={styles.featureLabel}>
                <input
                  type="checkbox"
                  checked={selectedFeatures.has(f)}
                  onChange={() => toggleFeature(f)}
                  style={styles.checkbox}
                />
                {f}
              </label>
            ))}
          </div>
        </div>
        <button
          onClick={runRF}
          disabled={rfLoading || selectedFeatures.size === 0}
          style={{
            ...styles.runBtn,
            opacity: rfLoading || selectedFeatures.size === 0 ? 0.5 : 1,
          }}
        >
          {rfLoading ? "Computing..." : "Compute Feature Importance"}
        </button>
        <p style={styles.rfNote}>
          Uses information gain to estimate feature-cluster association. For full Random Forest with cross-validation, use the Python code from earlier.
        </p>
      </div>

      {rfResult && (
        <div style={styles.rfResults}>
          <div style={styles.rfStats}>
            <span>Samples: {rfResult.nSamples.toLocaleString()}</span>
            <span>Features: {rfResult.nFeatures}</span>
            <span>Clusters: {rfResult.nClusters}</span>
          </div>
          <div style={styles.rfBars}>
            {rfResult.importances.map((imp, i) => (
              <div key={imp.feature} style={styles.rfBarRow}>
                <span style={styles.rfBarLabel}>{imp.feature}</span>
                <div style={styles.rfBarTrack}>
                  <div
                    style={{
                      ...styles.rfBarFill,
                      width: `${imp.normalized * 100}%`,
                      backgroundColor: getClusterColor(i),
                    }}
                  />
                </div>
                <span style={styles.rfBarValue}>{imp.importance.toFixed(4)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────
function computeEntropy(labels, uniqueLabels) {
  const counts = {};
  labels.forEach((l) => (counts[l] = (counts[l] || 0) + 1));
  let entropy = 0;
  uniqueLabels.forEach((l) => {
    const p = (counts[l] || 0) / labels.length;
    if (p > 0) entropy -= p * Math.log2(p);
  });
  return entropy;
}

// ─── Styles ──────────────────────────────────────────────────────
const styles = {
  container: {
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
    backgroundColor: "#0d1117",
    color: "#e0e0e0",
    minHeight: "100vh",
    padding: 0,
  },
  header: {
    background: "linear-gradient(135deg, #0d1117 0%, #161b22 100%)",
    borderBottom: "1px solid #21262d",
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
    background: "#161b22",
    border: "1px solid #30363d",
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
    background: "#21262d",
    border: "1px solid #30363d",
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
    borderBottom: "1px solid #21262d",
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
    borderBottom: "1px solid #21262d",
    background: "#161b2288",
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
    border: "1px solid #30363d",
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
    background: "#161b22",
    border: "1px solid #30363d",
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
    border: "1px solid #21262d",
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
    border: "1px solid #21262d",
    borderRadius: 8,
    background: "#161b22",
  },
  searchInput: {
    width: "100%",
    padding: "8px 12px",
    background: "#0d1117",
    border: "1px solid #30363d",
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
    border: "1px solid #30363d",
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
  tooltip: {
    position: "absolute",
    background: "#1c2128",
    border: "1px solid #30363d",
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
    border: "1px solid #21262d",
    borderRadius: 8,
    background: "#161b22",
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
    background: "#0d1117",
    borderRadius: 6,
    border: "1px solid #21262d",
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
    border: "1px solid #21262d",
    borderRadius: 8,
    padding: 20,
    background: "#161b22",
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
    background: "#0d1117",
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
