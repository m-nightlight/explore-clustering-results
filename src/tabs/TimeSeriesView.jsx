import { useState, useEffect, useMemo, useRef } from "react";
import * as d3 from "d3";
import { API, getClusterColor } from "../constants.js";
import { styles } from "../styles.js";

export function TimeSeriesView({ selectedK, clusters, selectedClusters, sensorClusterMap, sensorList, customColMapping = null }) {
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
      .catch((e) => console.error("sensor-timeseries fetch failed:", e));
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
      .catch((e) => { if (e.name !== "AbortError") console.error("drill cluster-profiles fetch failed:", e); });
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
        .catch((e) => { if (e.name !== "AbortError") console.error("drill sensor-timeseries fetch failed:", e); });
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
