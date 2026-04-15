import { useState, useEffect, useRef } from "react";
import * as d3 from "d3";
import { API, getClusterColor, GROUP_COLORS } from "../constants.js";
import { styles } from "../styles.js";

export function ClusterProfiles({ selectedK, clusters, selectedClusters, clusterGroups = [], getEffectiveClusterColor = getClusterColor, customColMapping = null }) {
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
