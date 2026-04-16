import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { API } from "../constants.js";

// ─── Compute homogeneity stats per building ───────────────────────

function computeBuildingHomogeneity(metadataData, selectedK) {
  if (!metadataData?.length || !selectedK) return [];

  const groups = {};
  metadataData.forEach((r) => {
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
    const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    if (total === 0) return null;
    const [majorityCluster, majorityCount] = entries[0];
    const homogeneity = majorityCount / total;
    const avgLat = lats.length ? lats.reduce((s, v) => s + v, 0) / lats.length : null;
    const avgLon = lons.length ? lons.reduce((s, v) => s + v, 0) / lons.length : null;
    return { bid, n_apartments: total, majority_cluster: majorityCluster, homogeneity, avgLat, avgLon, counts, entries };
  }).filter(Boolean);
}

// ─── Histogram canvas ─────────────────────────────────────────────

function HomogeneityHistogram({ buildings }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buildings?.length) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const ML = 44, MR = 16, MT = 16, MB = 36;
    const pw = w - ML - MR, ph = h - MT - MB;

    ctx.fillStyle = "#1a1f2e";
    ctx.fillRect(0, 0, w, h);

    // Bin into 20 buckets of width 0.05
    const N_BINS = 20;
    const bins = Array(N_BINS).fill(0);
    buildings.forEach(({ homogeneity }) => {
      const idx = Math.min(N_BINS - 1, Math.floor(homogeneity * N_BINS));
      bins[idx]++;
    });
    const maxBin = Math.max(...bins, 1);
    const barW = pw / N_BINS;

    // Grid lines
    ctx.strokeStyle = "#252c3d";
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1].forEach((pct) => {
      const y = MT + ph * (1 - pct);
      ctx.beginPath();
      ctx.moveTo(ML, y);
      ctx.lineTo(ML + pw, y);
      ctx.stroke();
      ctx.fillStyle = "#8899bb";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(Math.round(pct * maxBin), ML - 4, y + 3);
    });

    // Colour each bar by position (low = red, high = green)
    bins.forEach((count, i) => {
      if (count === 0) return;
      const x = ML + i * barW;
      const barH = (count / maxBin) * ph;
      const y = MT + ph - barH;
      const t = i / (N_BINS - 1);
      // interpolate #f85149 → #e9c46a → #2a9d8f
      let r, g, b;
      if (t < 0.5) {
        const u = t * 2;
        r = Math.round(248 + u * (233 - 248));
        g = Math.round(81 + u * (196 - 81));
        b = Math.round(73 + u * (74 - 73));
      } else {
        const u = (t - 0.5) * 2;
        r = Math.round(233 + u * (42 - 233));
        g = Math.round(196 + u * (157 - 196));
        b = Math.round(74 + u * (143 - 74));
      }
      ctx.fillStyle = `rgba(${r},${g},${b},0.8)`;
      ctx.fillRect(x + 1, y, barW - 2, barH);
    });

    // X-axis labels
    ctx.fillStyle = "#8899bb";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    [0, 0.2, 0.4, 0.6, 0.8, 1.0].forEach((v) => {
      const x = ML + v * pw;
      ctx.fillText(v.toFixed(1), x, MT + ph + 16);
    });

    // Axis label
    ctx.fillStyle = "#556677";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Homogeneity score", ML + pw / 2, MT + ph + 30);

    // Vertical lines at 0.8 and 1.0 thresholds
    [0.8, 1.0].forEach((v) => {
      const x = ML + v * pw;
      ctx.strokeStyle = v === 1.0 ? "#2a9d8f55" : "#e9c46a55";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, MT);
      ctx.lineTo(x, MT + ph);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }, [buildings]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: 180, display: "block", borderRadius: 6 }}
    />
  );
}

// ─── Cluster majority bar chart ────────────────────────────────────

function ClusterMajorityChart({ buildings, clusters, colorFn }) {
  const canvasRef = useRef(null);

  const clusterMajorityCounts = useMemo(() => {
    const counts = {};
    clusters.forEach((c) => { counts[String(c)] = 0; });
    buildings.forEach(({ majority_cluster }) => {
      counts[majority_cluster] = (counts[majority_cluster] || 0) + 1;
    });
    return counts;
  }, [buildings, clusters]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const ML = 44, MR = 16, MT = 12, MB = 32;
    const pw = w - ML - MR, ph = h - MT - MB;

    ctx.fillStyle = "#1a1f2e";
    ctx.fillRect(0, 0, w, h);

    const maxCount = Math.max(...Object.values(clusterMajorityCounts), 1);
    const barW = Math.max(4, pw / clusters.length - 4);
    const step = pw / clusters.length;

    // Grid
    ctx.strokeStyle = "#252c3d";
    ctx.lineWidth = 1;
    [0.5, 1].forEach((pct) => {
      const y = MT + ph * (1 - pct);
      ctx.beginPath();
      ctx.moveTo(ML, y);
      ctx.lineTo(ML + pw, y);
      ctx.stroke();
      ctx.fillStyle = "#8899bb";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(Math.round(pct * maxCount), ML - 4, y + 3);
    });

    clusters.forEach((c, i) => {
      const count = clusterMajorityCounts[String(c)] || 0;
      const x = ML + i * step + (step - barW) / 2;
      const barH = count > 0 ? Math.max(2, (count / maxCount) * ph) : 0;
      const y = MT + ph - barH;
      const color = colorFn(c, i);
      ctx.fillStyle = color + "cc";
      ctx.fillRect(x, y, barW, barH);
      ctx.fillStyle = "#8899bb";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`C${c}`, ML + i * step + step / 2, MT + ph + 16);
    });

    ctx.fillStyle = "#556677";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Buildings where cluster is majority", ML + pw / 2, MT + ph + 29);
  }, [clusters, clusterMajorityCounts, colorFn]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: 150, display: "block", borderRadius: 6 }}
    />
  );
}

// ─── Summary stat card ────────────────────────────────────────────

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: "#1d2232",
      border: `1px solid ${accent}44`,
      borderRadius: 8,
      padding: "14px 18px",
      minWidth: 140,
      flex: 1,
    }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: "#8b949e", marginTop: 2, textTransform: "uppercase", letterSpacing: "0.5px" }}>
        {label}
      </div>
      {sub && <div style={{ fontSize: 10, color: "#556677", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ─── Combo drill-down detail ──────────────────────────────────────

function ComboDetail({ comboKey, comboBuildings, clusters, colorFn, onNavigateToBuilding, onClose }) {
  const [sortCol, setSortCol] = useState("homogeneity");
  const [sortDir, setSortDir] = useState("desc");

  const handleSort = (col) => {
    if (sortCol === col) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
  };
  const arrow = (col) => sortCol === col ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const sorted = useMemo(() => {
    return [...comboBuildings].sort((a, b) => {
      const va = sortCol === "bid" ? a.bid : a[sortCol];
      const vb = sortCol === "bid" ? b.bid : b[sortCol];
      if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === "asc" ? va - vb : vb - va;
    });
  }, [comboBuildings, sortCol, sortDir]);

  const avgHomogeneity = comboBuildings.reduce((s, b) => s + b.homogeneity, 0) / comboBuildings.length;
  const totalSensors = comboBuildings.reduce((s, b) => s + b.n_apartments, 0);

  // Cluster labels for the header
  const clusterNums = comboKey.split(",").map(Number);

  const thStyle = {
    padding: "5px 10px", fontSize: 10, color: "#8b949e",
    borderBottom: "1px solid #2e3440", textTransform: "uppercase",
    letterSpacing: "0.4px", whiteSpace: "nowrap", cursor: "pointer",
    userSelect: "none", textAlign: "left", background: "#141820",
    position: "sticky", top: 0,
  };

  return (
    <div style={{ marginTop: 10, border: "1px solid #457B9D44", borderRadius: 8, background: "#141c28", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid #252c3d", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#c9d1d9" }}>
          Buildings with combination:
        </span>
        <div style={{ display: "flex", gap: 5 }}>
          {clusterNums.map((c) => (
            <span key={c} style={{
              padding: "1px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700,
              background: colorFn(c, clusters.indexOf(c)) + "33",
              color: colorFn(c, clusters.indexOf(c)),
              border: `1px solid ${colorFn(c, clusters.indexOf(c))}66`,
            }}>
              C{c}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 16, marginLeft: "auto", fontSize: 10, color: "#8b949e" }}>
          <span>{comboBuildings.length} buildings</span>
          <span>{totalSensors} sensors</span>
          <span>avg homogeneity: <span style={{ color: "#4CC9F0", fontWeight: 600 }}>{avgHomogeneity.toFixed(3)}</span></span>
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "1px solid #3d4555", borderRadius: 4, color: "#8b949e", fontSize: 11, padding: "2px 8px", cursor: "pointer" }}
        >
          ✕
        </button>
      </div>

      {/* Table */}
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr>
              <th style={thStyle} onClick={() => handleSort("bid")}>Building{arrow("bid")}</th>
              <th style={{ ...thStyle, textAlign: "right" }} onClick={() => handleSort("n_apartments")}>Sensors{arrow("n_apartments")}</th>
              <th style={thStyle} onClick={() => handleSort("homogeneity")}>Homogeneity{arrow("homogeneity")}</th>
              <th style={{ ...thStyle, minWidth: 100 }}>Cluster breakdown</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ bid, n_apartments, homogeneity, entries, avgLat, avgLon }) => {
              const barColor = homogeneity >= 1.0 ? "#2a9d8f" : homogeneity >= 0.8 ? "#57cc99" : homogeneity >= 0.5 ? "#e9c46a" : "#f85149";
              return (
                <tr
                  key={bid}
                  onClick={() => onNavigateToBuilding?.(bid, avgLat, avgLon)}
                  title="Click to view on map"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "#1d2a3a"}
                  onMouseLeave={(e) => e.currentTarget.style.background = ""}
                >
                  <td style={{ padding: "4px 10px", color: "#c9d1d9", borderBottom: "1px solid #1a1f2e", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={bid}>
                    {bid}
                  </td>
                  <td style={{ padding: "4px 10px", color: "#8b949e", borderBottom: "1px solid #1a1f2e", textAlign: "right" }}>
                    {n_apartments}
                  </td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid #1a1f2e" }}>
                    <span style={{ color: barColor, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                      {homogeneity.toFixed(3)}
                    </span>
                  </td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid #1a1f2e" }}>
                    <div style={{ display: "flex", height: 8, borderRadius: 3, overflow: "hidden", minWidth: 80 }}>
                      {entries.map(([cidStr, cnt]) => {
                        const c = Number(cidStr);
                        return (
                          <div
                            key={cidStr}
                            title={`C${cidStr}: ${Math.round(cnt / n_apartments * 100)}%`}
                            style={{ width: `${cnt / n_apartments * 100}%`, background: isNaN(c) ? "#8b949e" : colorFn(c, clusters.indexOf(c)), height: "100%" }}
                          />
                        );
                      })}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Cluster combinations (UpSet-style) ──────────────────────────

function ClusterCombinationsPanel({ buildings, clusters, colorFn, onNavigateToBuilding }) {
  const [minSensors, setMinSensors] = useState(1);
  const [topN, setTopN] = useState(15);
  const [selectedKey, setSelectedKey] = useState(null);

  // Compute combination frequencies, also store which buildings belong to each combo
  const combos = useMemo(() => {
    const freq = {};
    buildings.forEach((b) => {
      if (b.n_apartments < minSensors) return;
      const present = Object.keys(b.counts).map(Number).sort((a, b) => a - b);
      const key = present.join(",");
      if (!freq[key]) freq[key] = { clusters: present, count: 0, key };
      freq[key].count++;
    });
    return Object.values(freq).sort((a, b) => b.count - a.count);
  }, [buildings, minSensors]);

  // Buildings for the selected combo
  const selectedBuildings = useMemo(() => {
    if (!selectedKey) return [];
    return buildings.filter((b) => {
      if (b.n_apartments < minSensors) return false;
      const present = Object.keys(b.counts).map(Number).sort((a, b) => a - b).join(",");
      return present === selectedKey;
    });
  }, [selectedKey, buildings, minSensors]);

  const maxCount = combos[0]?.count || 1;
  const shown = combos.slice(0, topN);

  const DOT = 10;
  const DOT_GAP = 6;
  const clusterColWidth = clusters.length * (DOT + DOT_GAP);

  return (
    <div>
      {/* Controls */}
      <div style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#8b949e" }}>Min sensors/building:</span>
          <input
            type="number" min={1} value={minSensors}
            onChange={(e) => { setMinSensors(Math.max(1, Number(e.target.value))); setSelectedKey(null); }}
            style={{ width: 48, fontSize: 11, padding: "3px 6px", borderRadius: 4, border: "1px solid #3d4555", background: "#141820", color: "#c9d1d9" }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#8b949e" }}>Show top:</span>
          <input
            type="number" min={5} max={50} value={topN}
            onChange={(e) => setTopN(Math.max(5, Math.min(50, Number(e.target.value))))}
            style={{ width: 48, fontSize: 11, padding: "3px 6px", borderRadius: 4, border: "1px solid #3d4555", background: "#141820", color: "#c9d1d9" }}
          />
        </div>
        <span style={{ fontSize: 10, color: "#556677", marginLeft: "auto" }}>
          {combos.length} unique combinations
        </span>
      </div>

      {/* Column headers */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 2, paddingLeft: 8 }}>
        <div style={{ width: clusterColWidth, display: "flex", gap: DOT_GAP, flexShrink: 0 }}>
          {clusters.map((c) => (
            <div key={c} style={{ width: DOT, textAlign: "center", fontSize: 8, color: colorFn(c, clusters.indexOf(c)), fontWeight: 700, overflow: "hidden" }}>
              {c}
            </div>
          ))}
        </div>
        <div style={{ marginLeft: 14, fontSize: 9, color: "#556677", textTransform: "uppercase", letterSpacing: "0.4px" }}>
          Count
        </div>
      </div>

      {/* Rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {shown.map(({ clusters: present, count, key }) => {
          const presentSet = new Set(present.map(String));
          const pct = count / maxCount;
          const firstC = present[0];
          const barColor = firstC != null ? colorFn(firstC, clusters.indexOf(firstC)) : "#457B9D";
          const isSelected = selectedKey === key;

          return (
            <div key={key}>
              <div
                onClick={() => setSelectedKey(isSelected ? null : key)}
                title="Click to see individual buildings"
                style={{
                  display: "flex", alignItems: "center", padding: "3px 8px",
                  borderRadius: isSelected ? "5px 5px 0 0" : 5,
                  background: isSelected ? "#1a2535" : "#1a1f2e",
                  border: `1px solid ${isSelected ? "#457B9D" : "#252c3d"}`,
                  cursor: "pointer", transition: "border-color 0.15s, background 0.15s",
                }}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.borderColor = "#3d5570"; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.borderColor = "#252c3d"; }}
              >
                {/* Dot matrix */}
                <div style={{ display: "flex", gap: DOT_GAP, flexShrink: 0, alignItems: "center", width: clusterColWidth }}>
                  {clusters.map((c, ci) => {
                    const active = presentSet.has(String(c));
                    const color = colorFn(c, ci);
                    return (
                      <div
                        key={c}
                        title={`C${c}`}
                        style={{
                          width: DOT, height: DOT, borderRadius: "50%", flexShrink: 0,
                          background: active ? color : "transparent",
                          border: `1.5px solid ${active ? color : "#3d4555"}`,
                          boxShadow: active ? `0 0 4px ${color}66` : "none",
                        }}
                      />
                    );
                  })}
                </div>
                {/* Bar + count */}
                <div style={{ flex: 1, marginLeft: 14, display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, height: 8, background: "#252c3d", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${pct * 100}%`, height: "100%", background: barColor + "cc", borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: 11, color: "#c9d1d9", fontVariantNumeric: "tabular-nums", minWidth: 28, textAlign: "right" }}>
                    {count}
                  </span>
                  <span style={{ fontSize: 9, color: "#445566", minWidth: 36, textAlign: "right" }}>
                    {Math.round(count / buildings.length * 100)}%
                  </span>
                  <span style={{ fontSize: 9, color: isSelected ? "#457B9D" : "#3d4555", flexShrink: 0 }}>
                    {isSelected ? "▲" : "▼"}
                  </span>
                </div>
              </div>

              {/* Inline drill-down */}
              {isSelected && (
                <ComboDetail
                  comboKey={key}
                  comboBuildings={selectedBuildings}
                  clusters={clusters}
                  colorFn={colorFn}
                  onNavigateToBuilding={onNavigateToBuilding}
                  onClose={() => setSelectedKey(null)}
                />
              )}
            </div>
          );
        })}
      </div>

      {combos.length > topN && (
        <p style={{ fontSize: 9, color: "#445566", textAlign: "center", marginTop: 6 }}>
          Showing top {topN} of {combos.length} combinations.
        </p>
      )}
    </div>
  );
}

// ─── Building table ───────────────────────────────────────────────

function BuildingTable({ buildings, colorFn, onNavigateToBuilding }) {
  const [sortCol, setSortCol] = useState("homogeneity");
  const [sortDir, setSortDir] = useState("desc");
  const [search, setSearch] = useState("");
  const [minSensors, setMinSensors] = useState(1);

  const handleSort = (col) => {
    if (sortCol === col) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const sorted = useMemo(() => {
    let rows = buildings.filter((b) => b.n_apartments >= minSensors);
    if (search) rows = rows.filter((b) => b.bid.toLowerCase().includes(search.toLowerCase()));
    rows = [...rows].sort((a, b) => {
      const va = sortCol === "bid" ? a.bid : a[sortCol];
      const vb = sortCol === "bid" ? b.bid : b[sortCol];
      if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return rows;
  }, [buildings, sortCol, sortDir, search, minSensors]);

  const thStyle = {
    padding: "5px 10px",
    fontSize: 10,
    color: "#8b949e",
    borderBottom: "1px solid #2e3440",
    textTransform: "uppercase",
    letterSpacing: "0.4px",
    whiteSpace: "nowrap",
    cursor: "pointer",
    userSelect: "none",
    textAlign: "left",
    background: "#1d2232",
    position: "sticky",
    top: 0,
  };

  const arrow = (col) => sortCol === col ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter buildings…"
          style={{
            fontSize: 11, padding: "4px 10px", borderRadius: 5,
            border: "1px solid #3d4555", background: "#141820", color: "#c9d1d9", width: 180,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#8b949e" }}>Min sensors:</span>
          <input
            type="number" min={1} value={minSensors}
            onChange={(e) => setMinSensors(Math.max(1, Number(e.target.value)))}
            style={{
              width: 48, fontSize: 11, padding: "3px 6px", borderRadius: 4,
              border: "1px solid #3d4555", background: "#141820", color: "#c9d1d9",
            }}
          />
        </div>
        <span style={{ fontSize: 10, color: "#556677", marginLeft: "auto" }}>
          {sorted.length} buildings shown
        </span>
      </div>

      <div style={{ maxHeight: 420, overflowY: "auto", borderRadius: 8, border: "1px solid #2e3440" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr>
              <th style={thStyle} onClick={() => handleSort("bid")}>Building{arrow("bid")}</th>
              <th style={{ ...thStyle, textAlign: "right" }} onClick={() => handleSort("n_apartments")}>Sensors{arrow("n_apartments")}</th>
              <th style={thStyle}>Majority cluster</th>
              <th style={thStyle} onClick={() => handleSort("homogeneity")}>Homogeneity{arrow("homogeneity")}</th>
              <th style={{ ...thStyle, minWidth: 120 }}>Distribution</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 200).map(({ bid, n_apartments, majority_cluster, homogeneity, entries, avgLat, avgLon }) => {
              const majorityClusterNum = Number(majority_cluster);
              const color = isNaN(majorityClusterNum) ? "#8b949e" : colorFn(majorityClusterNum);
              const pct = Math.round(homogeneity * 100);
              const barColor = homogeneity >= 1.0 ? "#2a9d8f" : homogeneity >= 0.8 ? "#57cc99" : homogeneity >= 0.5 ? "#e9c46a" : "#f85149";

              return (
                <tr
                  key={bid}
                  onClick={() => onNavigateToBuilding?.(bid, avgLat, avgLon)}
                  title="Click to view on map"
                  style={{ cursor: "pointer", transition: "background 0.1s" }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "#232936"}
                  onMouseLeave={(e) => e.currentTarget.style.background = ""}
                >
                  <td style={{ padding: "4px 10px", color: "#c9d1d9", borderBottom: "1px solid #1d2232", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={bid}>
                    {bid}
                  </td>
                  <td style={{ padding: "4px 10px", color: "#8b949e", borderBottom: "1px solid #1d2232", textAlign: "right" }}>
                    {n_apartments}
                  </td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid #1d2232" }}>
                    <span style={{
                      padding: "1px 7px", borderRadius: 10, fontSize: 10, fontWeight: 600,
                      background: color + "33", color, border: `1px solid ${color}66`,
                    }}>
                      C{majority_cluster}
                    </span>
                  </td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid #1d2232" }}>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: barColor, fontWeight: 600 }}>
                      {(homogeneity).toFixed(3)}
                    </span>
                  </td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid #1d2232" }}>
                    <div style={{ display: "flex", height: 8, borderRadius: 3, overflow: "hidden", minWidth: 100 }}>
                      {entries.map(([cidStr, cnt]) => {
                        const c = Number(cidStr);
                        return (
                          <div
                            key={cidStr}
                            title={`C${cidStr}: ${Math.round(cnt / n_apartments * 100)}%`}
                            style={{ width: `${cnt / n_apartments * 100}%`, background: isNaN(c) ? "#8b949e" : colorFn(c), height: "100%" }}
                          />
                        );
                      })}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length > 200 && (
          <p style={{ fontSize: 9, color: "#445566", textAlign: "center", margin: "6px 0", padding: "0 0 6px" }}>
            Showing 200 of {sorted.length}. Use filter to narrow results.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────

export function BuildingHomogeneity({ metadataData, selectedK, clusters, getEffectiveClusterColor, onNavigateToBuilding }) {
  const [fullData, setFullData] = useState(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const hasFetched = useRef(false);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    setLoadingFull(true);
    fetch(`${API}/api/metadata-full`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => { setFullData(data); setLoadingFull(false); })
      .catch((e) => { setFetchError(e.message); setLoadingFull(false); });
  }, []);

  // Merge full properties (incl. lm_building_id) with slim metadata cluster assignments
  const enrichedRows = useMemo(() => {
    if (!Array.isArray(fullData) || !metadataData) return null;
    const metaMap = Object.fromEntries(metadataData.map((r) => [r.sensor_id, r]));
    return fullData.map((r) => ({ ...r, ...(metaMap[r.sensor_id] || {}) }));
  }, [fullData, metadataData]);

  const buildings = useMemo(
    () => computeBuildingHomogeneity(enrichedRows, selectedK),
    [enrichedRows, selectedK]
  );

  const colorFn = useCallback(
    (c, i) => getEffectiveClusterColor(c, i != null ? i : clusters.indexOf(c)),
    [getEffectiveClusterColor, clusters]
  );

  const { weightedAvg, perfectCount, highCount } = useMemo(() => {
    if (!buildings.length) return { weightedAvg: 0, perfectCount: 0, highCount: 0 };
    const totalSensors = buildings.reduce((s, b) => s + b.n_apartments, 0);
    const weightedAvg = buildings.reduce((s, b) => s + b.homogeneity * b.n_apartments, 0) / totalSensors;
    const perfectCount = buildings.filter((b) => b.homogeneity === 1.0).length;
    const highCount = buildings.filter((b) => b.homogeneity > 0.8).length;
    return { weightedAvg, perfectCount, highCount };
  }, [buildings]);

  if (!metadataData) return null;

  return (
    <div style={{ padding: "16px 20px", overflowY: "auto", height: "100%" }}>
      {loadingFull && (
        <div style={{ color: "#58a6ff", fontSize: 12, marginBottom: 14 }}>Loading full metadata…</div>
      )}
      {fetchError && (
        <div style={{ color: "#f85149", fontSize: 12, marginBottom: 14 }}>Error: {fetchError}</div>
      )}
      {/* Summary stats */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <StatCard
          label="Weighted avg homogeneity"
          value={weightedAvg.toFixed(3)}
          sub={`across ${buildings.length} buildings`}
          accent="#4CC9F0"
        />
        <StatCard
          label="Perfect homogeneity (1.0)"
          value={`${perfectCount} / ${buildings.length}`}
          sub={`${Math.round(perfectCount / buildings.length * 100)}% of buildings`}
          accent="#2a9d8f"
        />
        <StatCard
          label="High homogeneity (> 0.8)"
          value={`${highCount} / ${buildings.length}`}
          sub={`${Math.round(highCount / buildings.length * 100)}% of buildings`}
          accent="#57cc99"
        />
        <StatCard
          label="Total sensors"
          value={buildings.reduce((s, b) => s + b.n_apartments, 0).toLocaleString()}
          sub={`across ${buildings.length} buildings`}
          accent="#E9C46A"
        />
      </div>

      {/* Charts row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <div style={{ background: "#1d2232", border: "1px solid #2e3440", borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#8b949e", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>
            Homogeneity distribution
          </div>
          <HomogeneityHistogram buildings={buildings} />
          <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 9, color: "#556677" }}>
            <span style={{ color: "#f85149" }}>■ low (&lt;0.5)</span>
            <span style={{ color: "#e9c46a" }}>■ mid</span>
            <span style={{ color: "#2a9d8f" }}>■ high (≥0.8)</span>
            <span style={{ marginLeft: "auto" }}>dashed = 0.8 and 1.0 thresholds</span>
          </div>
        </div>

        <div style={{ background: "#1d2232", border: "1px solid #2e3440", borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#8b949e", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>
            Buildings per majority cluster
          </div>
          <ClusterMajorityChart buildings={buildings} clusters={clusters} colorFn={colorFn} />
        </div>
      </div>

      {/* Cluster combinations */}
      <div style={{ background: "#1d2232", border: "1px solid #2e3440", borderRadius: 8, padding: "12px 14px", marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "#8b949e", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.5px" }}>
          Most common cluster combinations
          <span style={{ fontSize: 9, color: "#3d4555", marginLeft: 8, fontWeight: 400, textTransform: "none" }}>
            filled dot = cluster present in building
          </span>
        </div>
        <ClusterCombinationsPanel buildings={buildings} clusters={clusters} colorFn={colorFn} onNavigateToBuilding={onNavigateToBuilding} />
      </div>

      {/* Building table */}
      <div style={{ background: "#1d2232", border: "1px solid #2e3440", borderRadius: 8, padding: "12px 14px" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "#8b949e", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.5px" }}>
          Per-building breakdown
          <span style={{ fontSize: 9, color: "#3d4555", marginLeft: 8, fontWeight: 400, textTransform: "none" }}>
            click row to navigate to map
          </span>
        </div>
        <BuildingTable
          buildings={buildings}
          colorFn={colorFn}
          onNavigateToBuilding={onNavigateToBuilding}
        />
      </div>
    </div>
  );
}
