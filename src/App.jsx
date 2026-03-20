import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as d3 from "d3";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, GeoJsonLayer } from "@deck.gl/layers";
import { WebMercatorViewport, FlyToInterpolator } from "@deck.gl/core";
import Map from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
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
  const [metadataData, setMetadataData] = useState(null);
  const [activeTab, setActiveTab] = useState("profiles");
  const [selectedK, setSelectedK] = useState(null);
  const [clusterColumns, setClusterColumns] = useState([]);
  const [selectedClusters, setSelectedClusters] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Derive cluster columns from metadata
  useEffect(() => {
    if (!metadataData || metadataData.length === 0) return;
    const cols = Object.keys(metadataData[0]).filter(
      (c) => c.toLowerCase().includes("cluster") || c.toLowerCase().startsWith("k_") || c.toLowerCase().match(/^k\d+/)
    );
    if (cols.length === 0) {
      const potentialClusters = Object.keys(metadataData[0]).filter((c) => {
        const unique = new Set(metadataData.map((r) => r[c]));
        return unique.size >= 2 && unique.size <= 50 && c !== "lat" && c !== "lon";
      });
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

  const sensorList = useMemo(() => {
    if (!metadataData || !sensorIdCol) return [];
    return metadataData.map((r) => r[sensorIdCol]).filter(Boolean);
  }, [metadataData, sensorIdCol]);

  const loadData = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const metadata = await fetchData("/api/metadata");
      if (!metadata.length) throw new Error("No sensor metadata returned");
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
                selectedK={selectedK}
                clusters={clusters}
                selectedClusters={selectedClusters}
              />
            )}
            {activeTab === "timeseries" && (
              <TimeSeriesView
                selectedK={selectedK}
                clusters={clusters}
                selectedClusters={selectedClusters}
                sensorClusterMap={sensorClusterMap}
                sensorList={sensorList}
              />
            )}
            {activeTab === "map" && (
              <MapView
                metadataData={metadataData}
                selectedK={selectedK}
                clusters={clusters}
                selectedClusters={selectedClusters}
                sensorIdCol={sensorIdCol}
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
function ClusterProfiles({ selectedK, clusters, selectedClusters }) {
  const [profileType, setProfileType] = useState("mean");
  const [profiles, setProfiles] = useState(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const canvasRef = useRef();

  useEffect(() => {
    if (!selectedK) return;
    const controller = new AbortController();
    setProfilesLoading(true);
    const params = new URLSearchParams({ cluster_col: selectedK, agg: profileType });
    fetch(`${API}/api/cluster-profiles?${params}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => { setProfiles(data); setProfilesLoading(false); })
      .catch((e) => { if (e.name !== "AbortError") setProfilesLoading(false); });
    return () => controller.abort();
  }, [selectedK, profileType]);

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
      const p = profiles.profiles[String(c)];
      if (!selectedClusters.has(c) || !p) return;
      ctx.fillStyle = getClusterColor(ci);
      ctx.fillRect(lx, ly, 12, 12);
      ctx.fillStyle = "#ccc";
      ctx.font = "11px monospace";
      ctx.textAlign = "left";
      const label = `Cluster ${c} (n=${p.count})`;
      ctx.fillText(label, lx + 16, ly + 10);
      lx += ctx.measureText(label).width + 36;
      if (lx > w - 150) { lx = margin.left + 10; ly += 18; }
    });
  }, [profiles, selectedClusters, clusters]);

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
function TimeSeriesView({ selectedK, clusters, selectedClusters, sensorClusterMap, sensorList }) {
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
    const params = new URLSearchParams({ cluster_col: selectedK });
    fetch(`${API}/api/timeseries-overview?${params}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => { setOverviewData(data); setOverviewLoading(false); })
      .catch((e) => { if (e.name !== "AbortError") setOverviewLoading(false); });
    return () => controller.abort();
  }, [selectedK]);

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
    const params = new URLSearchParams({ cluster_col: selectedK });
    fetch(`${API}/api/cluster-profiles?${params}`, { signal: controller.signal })
      .then((r) => r.json())
      .then(setAllDrillProfiles)
      .catch(() => {});
    return () => controller.abort();
  }, [selectedK]);

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
function renderStackedBars(canvas, { labels, counts }, title, clusters, viewClusterIds, rotateLabels = false) {
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
      ctx.fillStyle = getClusterColor(ci >= 0 ? ci : 0);
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
function renderYearDensity(canvas, yearByCluster, clusters, viewClusterIds) {
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
    const color = getClusterColor(ci >= 0 ? ci : 0);
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
    const color = getClusterColor(ci >= 0 ? ci : 0);
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
function MapView({ metadataData, selectedK, clusters, selectedClusters, sensorIdCol }) {
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
      return { longitude, latitude, zoom: Math.min(zoom, 15), pitch: 0, bearing: 0 };
    } catch { return { longitude: 0, latitude: 0, zoom: 4, pitch: 0, bearing: 0 }; }
  });

  const [mapStyleId, setMapStyleId] = useState("dark");
  const [boxZoomActive, setBoxZoomActive] = useState(false);
  const [boxRect, setBoxRect] = useState(null);

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
  const floorCanvasRef = useRef();
  const yearCanvasRef = useRef();
  const periodCanvasRef = useRef();
  const typeCanvasRef = useRef();
  const buildingCanvasRef = useRef();

  // Fetch full cluster profiles (for stable, representative means)
  useEffect(() => {
    if (!selectedK) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ cluster_col: selectedK });
    fetch(`${API}/api/cluster-profiles?${params}`, { signal: controller.signal })
      .then((r) => r.json())
      .then(setAllClusterProfiles)
      .catch(() => {});
    return () => controller.abort();
  }, [selectedK]);

  // ── Filters ──
  const [filterOptions, setFilterOptions] = useState(null);
  const [activeFilters, setActiveFilters] = useState({});
  const [filteredIds, setFilteredIds] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    fetchData("/api/filter-options").then(setFilterOptions).catch(() => {});
  }, []);

  useEffect(() => {
    const active = Object.entries(activeFilters).filter(([, s]) => s.size > 0);
    if (active.length === 0) { setFilteredIds(null); return; }
    const params = new URLSearchParams();
    active.forEach(([field, vals]) => params.set(field, [...vals].join(",")));
    fetchData(`/api/filtered-sensor-ids?${params}`)
      .then((d) => setFilteredIds(d.sensor_ids ? new Set(d.sensor_ids) : null))
      .catch(() => {});
  }, [activeFilters]);

  const toggleFilterValue = (field, value) => {
    setActiveFilters((prev) => {
      const next = { ...prev };
      const s = new Set(next[field] || []);
      if (s.has(value)) s.delete(value); else s.add(value);
      next[field] = s;
      return next;
    });
  };
  const clearFilters = () => { setActiveFilters({}); setFilteredIds(null); };
  const activeFilterCount = Object.values(activeFilters).reduce((n, s) => n + s.size, 0);

  // ── Sensor data ──
  const sensorLocations = useMemo(() => {
    if (!metadataData) return [];
    return metadataData
      .filter((r) =>
        r.lat != null && r.lon != null &&
        selectedClusters.has(r[selectedK]) &&
        (filteredIds === null || filteredIds.has(r[sensorIdCol]))
      )
      .map((r) => ({ id: r[sensorIdCol], lat: r.lat, lon: r.lon, cluster: r[selectedK] }));
  }, [metadataData, selectedK, selectedClusters, sensorIdCol, filteredIds]);

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

  // ── deck.gl layers ──
  const layers = useMemo(() => {
    const ls = [
      new ScatterplotLayer({
        id: "sensors",
        data: sensorLocations,
        getPosition: (d) => [d.lon, d.lat],
        getFillColor: (d) => {
          const ci = clusters.indexOf(d.cluster);
          const color = hexToRgb(getClusterColor(ci >= 0 ? ci : 0));
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
        updateTriggers: { getFillColor: [clusters, buildingHighlightIds], getRadius: [buildingHighlightIds] },
      }),
    ];
    if (buildingGeometry?.features?.length) {
      ls.push(new GeoJsonLayer({
        id: "buildings",
        data: buildingGeometry,
        filled: true,
        stroked: true,
        getFillColor: [88, 166, 255, 25],
        getLineColor: [88, 166, 255, 220],
        lineWidthMinPixels: 2,
        lineWidthMaxPixels: 3,
      }));
    }
    return ls;
  }, [sensorLocations, clusters, buildingHighlightIds, buildingGeometry]);

  const handleViewStateChange = useCallback(({ viewState: vs }) => setViewState({ ...vs }), []);

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
    fetch(`${API}/api/sensors-properties`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensor_ids: allIds.slice(0, 500) }),
    })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setSensorProperties(data); else console.error("sensors-properties:", data); })
      .catch((e) => console.error("sensors-properties fetch failed:", e));
  };

  const displaySensors = analysedSensors ?? [];
  const byCluster = useMemo(() => {
    const counts = {};
    displaySensors.forEach((d) => { counts[d.cluster] = (counts[d.cluster] || 0) + 1; });
    return counts;
  }, [displaySensors]);

  // ── Charts ──
  const drawChart = useCallback((canvas, timestamps, yVals, drawFn) => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);
    const margin = { top: 16, right: 20, bottom: 44, left: 52 };
    const pw = w - margin.left - margin.right, ph = h - margin.top - margin.bottom;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#1a1f2e"; ctx.fillRect(0, 0, w, h);
    const xScale = d3.scaleLinear().domain([0, timestamps.length - 1]).range([margin.left, margin.left + pw]);
    const yExtent = d3.extent(yVals);
    const yPad = (yExtent[1] - yExtent[0]) * 0.05 || 1;
    const yScale = d3.scaleLinear().domain([yExtent[0] - yPad, yExtent[1] + yPad]).range([margin.top + ph, margin.top]);
    ctx.strokeStyle = "#252c3d"; ctx.lineWidth = 1;
    yScale.ticks(5).forEach((t) => { ctx.beginPath(); ctx.moveTo(margin.left, yScale(t)); ctx.lineTo(margin.left + pw, yScale(t)); ctx.stroke(); });
    ctx.fillStyle = "#667"; ctx.font = "10px monospace"; ctx.textAlign = "right";
    yScale.ticks(5).forEach((t) => ctx.fillText(t.toFixed(1), margin.left - 6, yScale(t) + 3));
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(timestamps.length / 6));
    for (let i = 0; i < timestamps.length; i += step) ctx.fillText(String(timestamps[i]).slice(0, 10), xScale(i), margin.top + ph + 16);
    drawFn(ctx, xScale, yScale);
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

  useEffect(() => {
    if (!allClusterProfiles || !analysedSensors || !canvasRef.current) return;
    const ts = allClusterProfiles.timestamps; if (!ts.length) return;
    const viewProfiles = Object.fromEntries(
      Object.entries(allClusterProfiles.profiles).filter(([cid]) => viewClusterIds.has(cid))
    );
    const yVals = Object.values(viewProfiles).flatMap((p) => p.values).filter((v) => v != null);
    if (!yVals.length) return;
    drawChart(canvasRef.current, ts, yVals, (ctx, xScale, yScale) => {
      Object.entries(viewProfiles).forEach(([cidStr, p]) => {
        const ci = clusters.indexOf(Number(cidStr));
        ctx.strokeStyle = getClusterColor(ci >= 0 ? ci : 0); ctx.lineWidth = 2; ctx.beginPath();
        let started = false;
        p.values.forEach((v, i) => { if (v === null) return; if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; } else ctx.lineTo(xScale(i), yScale(v)); });
        ctx.stroke();
      });
    });
  }, [allClusterProfiles, analysedSensors, viewClusterIds, clusters, drawChart]);

  useEffect(() => {
    const activeSensorData = buildingTimeseries || mapSensorData;
    if (!allClusterProfiles || !activeSensorData || !sensorCanvasRef.current) return;
    const ts = allClusterProfiles.timestamps; if (!ts.length) return;
    const viewProfiles = Object.fromEntries(
      Object.entries(allClusterProfiles.profiles).filter(([cid]) => viewClusterIds.has(cid))
    );
    const yVals = [...Object.values(viewProfiles).flatMap((p) => p.values), ...Object.values(activeSensorData.sensors).flat()].filter((v) => v != null && !isNaN(v));
    if (!yVals.length) return;
    drawChart(sensorCanvasRef.current, ts, yVals, (ctx, xScale, yScale) => {
      Object.entries(activeSensorData.sensors).forEach(([sid, vals]) => {
        const sensor = analysedSensors?.find((d) => d.id === sid);
        const ci = sensor ? clusters.indexOf(sensor.cluster) : -1;
        ctx.strokeStyle = (ci >= 0 ? getClusterColor(ci) : "#888") + "40"; ctx.lineWidth = 1; ctx.beginPath();
        let started = false;
        vals.forEach((v, i) => { if (v == null || isNaN(v)) return; if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; } else ctx.lineTo(xScale(i), yScale(v)); });
        ctx.stroke();
      });
      Object.entries(viewProfiles).forEach(([cidStr, p]) => {
        const ci = clusters.indexOf(Number(cidStr));
        ctx.strokeStyle = getClusterColor(ci >= 0 ? ci : 0); ctx.lineWidth = 2; ctx.beginPath();
        let started = false;
        p.values.forEach((v, i) => { if (v === null) return; if (!started) { ctx.moveTo(xScale(i), yScale(v)); started = true; } else ctx.lineTo(xScale(i), yScale(v)); });
        ctx.stroke();
      });
    });
  }, [allClusterProfiles, mapSensorData, buildingTimeseries, viewClusterIds, clusters, analysedSensors, drawChart]);

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
  useEffect(() => { if (floorData && floorCanvasRef.current && analysisTab === "stats") renderStackedBars(floorCanvasRef.current, floorData, "Floor level (floor_df1)", clusters, viewClusterIds); }, [floorData, clusters, viewClusterIds, analysisTab]);
  useEffect(() => { if (yearData && yearCanvasRef.current && analysisTab === "stats") renderStackedBars(yearCanvasRef.current, yearData, "Construction year (Nybyggnadsår)", clusters, viewClusterIds, true); }, [yearData, clusters, viewClusterIds, analysisTab]);
  useEffect(() => { if (periodData && periodCanvasRef.current && analysisTab === "stats") renderStackedBars(periodCanvasRef.current, periodData, "Construction period", clusters, viewClusterIds, true); }, [periodData, clusters, viewClusterIds, analysisTab]);
  useEffect(() => { if (buildingTypeData && typeCanvasRef.current && analysisTab === "stats") renderStackedBars(typeCanvasRef.current, buildingTypeData, "Building type (andamal_typ)", clusters, viewClusterIds, true); }, [buildingTypeData, clusters, viewClusterIds, analysisTab]);

  // ── Building timeseries chart (Buildings tab) ──
  useEffect(() => {
    if (!buildingTimeseries || !allClusterProfiles || !buildingCanvasRef.current || analysisTab !== "buildings") return;
    const ts = allClusterProfiles.timestamps;
    if (!ts.length) return;
    const viewProfiles = Object.fromEntries(
      Object.entries(allClusterProfiles.profiles).filter(([cid]) => viewClusterIds.has(cid))
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
      Object.entries(byCid).forEach(([, { ci, lines }]) => {
        const color = getClusterColor(ci >= 0 ? ci : 0);
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
        ctx.strokeStyle = getClusterColor(ci >= 0 ? ci : 0);
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
        const color = getClusterColor(ci >= 0 ? ci : 0);
        ctx.fillStyle = color; ctx.fillRect(lx, ly, 10, 10);
        ctx.fillStyle = "#ccc"; ctx.font = "10px monospace"; ctx.textAlign = "left";
        ctx.fillText(`Cluster ${cid}`, lx + 14, ly + 9);
        lx += ctx.measureText(`Cluster ${cid}`).width + 28;
      });
    });
  }, [buildingTimeseries, allClusterProfiles, viewClusterIds, clusters, sensorProperties, selectedK, analysisTab, drawChart]);

  if (!metadataData) return <div style={styles.emptyState}><p style={styles.emptyIcon}>◉</p><p>No metadata available</p></div>;

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      {/* Map column */}
      <div style={{ flex: "0 0 50%" }}>
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
          <select
            value={mapStyleId}
            onChange={(e) => setMapStyleId(e.target.value)}
            style={{ ...styles.select, padding: "3px 8px", fontSize: 11 }}
          >
            {MAP_STYLES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {/* Filter panel */}
        {filtersOpen && filterOptions && (
          <div style={{ marginBottom: 8, padding: "10px 12px", background: "#232936", border: "1px solid #2e3440", borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.5px" }}>Filter sensors</span>
              {activeFilterCount > 0 && <button onClick={clearFilters} style={{ ...styles.miniBtn, fontSize: 10, color: "#f85149", borderColor: "#f85149" }}>Clear all</button>}
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

        {/* DeckGL map */}
        <div ref={deckContainerRef} style={{ height: 560, borderRadius: 8, overflow: "hidden", border: "1px solid #2e3440", position: "relative" }}>
          <DeckGL
            viewState={viewState}
            controller={!boxZoomActive}
            layers={layers}
            onViewStateChange={handleViewStateChange}
            glOptions={{ webgl2: true }}
            getTooltip={({ object }) => object && {
              html: `<strong style="color:#e0e0e0">${object.id}</strong><br/><span style="color:#8b949e">Cluster: ${object.cluster}</span>`,
              style: { background: "#2a303d", border: "1px solid #3d4555", borderRadius: "6px", padding: "8px 12px", fontSize: "12px", fontFamily: "monospace" },
            }}
          >
            <Map key={mapStyleId} ref={mapRef} mapStyle={resolveStyle(MAP_STYLES.find(s => s.id === mapStyleId).url)} mapboxAccessToken={MAPBOX_TOKEN} />
          </DeckGL>

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
      </div>

      {/* Side panel */}
      <div style={{ flex: "0 0 calc(50% - 16px)", display: "flex", flexDirection: "column", gap: 10 }}>
        {!analysedSensors ? (
          <p style={styles.mapInfo}>Set your view and click "Analyse view" to inspect the area.</p>
        ) : (
          <>
            {/* Summary */}
            <p style={{ ...styles.mapInfo, margin: 0 }}>
              {displaySensors.length.toLocaleString()} sensors
              {sensorProperties && ` · ${Object.keys(areaGroups).length} buildings`}
              {` · ${viewClusterIds.size} clusters`}
            </p>

            {/* Cluster breakdown bars */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {clusters.map((c, i) => {
                const count = byCluster[c] || 0;
                if (!count) return null;
                const pct = displaySensors.length > 0 ? count / displaySensors.length : 0;
                return (
                  <div key={c} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: getClusterColor(i), fontSize: 11, fontWeight: 600, width: 70, flexShrink: 0 }}>Cluster {c}</span>
                    <div style={{ flex: 1, background: "#232936", borderRadius: 4, height: 10, overflow: "hidden" }}>
                      <div style={{ width: `${pct * 100}%`, height: "100%", background: getClusterColor(i), borderRadius: 4 }} />
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
                    <button onClick={() => { setSelectedBuildings(new Set()); setBuildingTimeseries(null); setBuildingGeometry(null); }} style={{ ...styles.miniBtn, fontSize: 10, padding: "2px 8px", color: "#8b949e", borderColor: "#3d4555" }}>
                      Clear
                    </button>
                  </div>
                )}
                {mapProfilesLoading && <p style={styles.mapInfo}>Loading sensors…</p>}
                {allClusterProfiles && viewClusterIds.size > 0 && (
                  <>
                    <p style={{ ...styles.mapInfo, marginBottom: 0 }}>Full cluster means — {viewClusterIds.size} cluster{viewClusterIds.size > 1 ? "s" : ""} in view</p>
                    <canvas ref={canvasRef} style={{ ...styles.canvas, height: 200 }} />
                    <p style={{ ...styles.mapInfo, marginBottom: 0, marginTop: 4 }}>
                      {buildingTimeseries
                        ? `${Object.keys(buildingTimeseries.sensors).length} sensors (building)`
                        : mapSensorData ? `${Object.keys(mapSensorData.sensors).length} sensors` : "Loading…"
                      } + cluster means
                    </p>
                    <canvas ref={sensorCanvasRef} style={{ ...styles.canvas, height: 200 }} />
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
                        <button onClick={() => { setSelectedBuildings(new Set()); setBuildingTimeseries(null); setBuildingGeometry(null); }} style={{ ...styles.miniBtn, fontSize: 10, padding: "2px 8px", color: "#8b949e", borderColor: "#3d4555" }}>Clear</button>
                      </div>
                    )}
                    {/* Cluster legend */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
                      {[...viewClusterIds].sort().map((cid) => {
                        const ci = clusters.indexOf(Number(cid));
                        return (
                          <span key={cid} style={{ fontSize: 10, color: getClusterColor(ci >= 0 ? ci : 0), display: "flex", alignItems: "center", gap: 3 }}>
                            <span style={{ width: 8, height: 8, background: getClusterColor(ci >= 0 ? ci : 0), display: "inline-block", borderRadius: 1 }} />
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
                                  return <span key={cid} title={`Cluster ${cid}: ${cnt}`} style={{ width: 8, height: 8, borderRadius: "50%", background: getClusterColor(ci >= 0 ? ci : 0) }} />;
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
