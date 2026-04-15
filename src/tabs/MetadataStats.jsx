import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as d3 from "d3";
import { API } from "../constants.js";
import { hexToRgb, getClusterColor } from "../constants.js";

// ─── Column classification helpers ───────────────────────────────

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

// ─── Canvas renderers ─────────────────────────────────────────────

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
    let y = MT + ph;
    clusters.forEach((c) => {
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

// ─── MetaCard ─────────────────────────────────────────────────────

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

// ─── MetadataStats ────────────────────────────────────────────────

const SKIP_COLS = new Set(["sensor_id", "lat", "lon", "lm_building_id", "geom", "building_geom"]);

export function MetadataStats({ metadataData, selectedK, clusters, selectedClusters, getEffectiveClusterColor, customClusterCols, onNavigateToBuilding }) {
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
