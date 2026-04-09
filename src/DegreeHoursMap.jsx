import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { ColumnLayer, GeoJsonLayer } from "@deck.gl/layers";
import { WebMercatorViewport, FlyToInterpolator } from "@deck.gl/core";
import Map from "react-map-gl/mapbox";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const API = "http://localhost:8000";

const MAP_STYLES = [
  { id: "dark",      name: "Dark",      url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" },
  { id: "light",     name: "Light",     url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" },
  { id: "voyager",   name: "Voyager",   url: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json" },
  { id: "satellite", name: "Satellite", url: "mapbox://styles/matspmapping/cmg9qmif500a801sa4f0b5p5o" },
];

const resolveStyle = (url) =>
  url.startsWith("mapbox://styles/")
    ? `https://api.mapbox.com/styles/v1/${url.slice(16)}?access_token=${MAPBOX_TOKEN}`
    : url;

// Blue → teal → yellow-green → orange → red
const DH_COLOR_STOPS = [
  [70,  130, 200],
  [50,  200, 160],
  [160, 220,  70],
  [255, 150,   0],
  [220,  20,  20],
];

function dhToColor(value, max) {
  if (max <= 0) return DH_COLOR_STOPS[0];
  const t = Math.max(0, Math.min(1, value / max));
  const scaled = t * (DH_COLOR_STOPS.length - 1);
  const lo = Math.floor(scaled);
  const hi = Math.min(lo + 1, DH_COLOR_STOPS.length - 1);
  const f = scaled - lo;
  return DH_COLOR_STOPS[lo].map((c, i) => Math.round(c + f * (DH_COLOR_STOPS[hi][i] - c)));
}

const FIELD_META = {
  "dh_2018":       { label: "2018",      group: "year",      unit: "°Ch" },
  "dh_2024":       { label: "2024",      group: "year",      unit: "°Ch" },
  "dh_2025":       { label: "2025",      group: "year",      unit: "°Ch" },
  "Kh above 26°C": { label: "Kh >26°C", group: "threshold", unit: "°Ch" },
  "Kh above 27°C": { label: "Kh >27°C", group: "threshold", unit: "°Ch" },
  "Kh above 28°C": { label: "Kh >28°C", group: "threshold", unit: "°Ch" },
  "tc_h":          { label: "tc_h",      group: "other",     unit: "h"   },
};

const FIELD_COLORS = ["#E9C46A", "#4CC9F0", "#FF6B9D", "#6BCB77", "#C8B6FF"];

// Compute a percentile value from a sorted array
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const fetchJson = (url) => fetch(url).then((r) => r.json());

// ─── DegreeHoursMap ──────────────────────────────────────────────
export default function DegreeHoursMap({ metadataData }) {
  // ── View state ──
  const [viewState, setViewState] = useState(() => {
    if (!metadataData?.length)
      return { longitude: 11.97, latitude: 57.71, zoom: 14, pitch: 55, bearing: -20 };
    const lats = metadataData.filter((r) => r.lat != null).map((r) => r.lat);
    const lons = metadataData.filter((r) => r.lon != null).map((r) => r.lon);
    if (!lats.length)
      return { longitude: 11.97, latitude: 57.71, zoom: 14, pitch: 55, bearing: -20 };
    try {
      const vp = new WebMercatorViewport({ width: 900, height: 600 });
      const { longitude, latitude, zoom } = vp.fitBounds(
        [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: 60 }
      );
      return { longitude, latitude, zoom: Math.min(zoom + 1, 15), pitch: 55, bearing: -20 };
    } catch {
      return { longitude: 11.97, latitude: 57.71, zoom: 14, pitch: 55, bearing: -20 };
    }
  });

  // ── Controls ──
  const [mapStyleId, setMapStyleId]           = useState("dark");
  const [availableFields, setAvailableFields] = useState([]);
  const [selectedFields, setSelectedFields]   = useState([]);
  const [heightScale, setHeightScale]         = useState(5);
  const [radius, setRadius]                   = useState(3);
  const [showBuildings, setShowBuildings]     = useState(true);

  // Parquet coordinates
  const [useParquetCoords, setUseParquetCoords] = useState(true);
  const [pointHeights, setPointHeights]         = useState({});

  // Exploded building view
  const [explodedView, setExplodedView]         = useState(false);
  const [leanScale, setLeanScale]               = useState(5);    // metres outward per floor
  const [spreadPositions, setSpreadPositions]   = useState({});
  const [spreadLoading, setSpreadLoading]       = useState(false);

  // Camera animation
  const [isRotating, setIsRotating]   = useState(false);
  const [rotateSpeed, setRotateSpeed] = useState(0.3);   // °/s
  const [isZooming, setIsZooming]     = useState(false);
  const [zoomAmp, setZoomAmp]         = useState(1.0);   // zoom-level amplitude
  const [isTilting, setIsTilting]     = useState(false);
  const [tiltAmp, setTiltAmp]         = useState(20);    // ± degrees pitch (oscillate)
  const [isSweeping, setIsSweeping]   = useState(false); // one-way tilt sweep
  const [sweepTarget, setSweepTarget] = useState(5);     // target pitch (°)
  const [sweepDuration, setSweepDuration] = useState(10000); // ms to reach target
  const [isFlyover, setIsFlyover]       = useState(false);
  const [flyoverSpeed, setFlyoverSpeed] = useState(30);   // m/s straight travel
  const [isZoomIn, setIsZoomIn]             = useState(false);
  const [zoomInFactor, setZoomInFactor]     = useState(3);
  const [zoomInDuration, setZoomInDuration] = useState(8000);
  const [isZoomOut, setIsZoomOut]           = useState(false);
  const [zoomOutFactor, setZoomOutFactor]   = useState(3);
  const [zoomOutDuration, setZoomOutDuration] = useState(8000);
  const animFrameRef   = useRef(null);
  const lastTimeRef    = useRef(null);
  const elapsedRef     = useRef(0);
  const zoomBaseRef    = useRef(null);
  const pitchBaseRef   = useRef(null);
  const sweepElapsed   = useRef(0);
  const zoomInStart    = useRef(null);
  const zoomInElapsed  = useRef(0);
  const zoomOutStart   = useRef(null);
  const zoomOutElapsed = useRef(0);

  // ── Sequencer ──
  const [cues, setCues]                   = useState([]);
  const [activeCueIdx, setActiveCueIdx]   = useState(-1);
  const [sequencerAuto, setSequencerAuto] = useState(false);
  const [sequencerLoop, setSequencerLoop] = useState(false);
  const [showSequencer, setShowSequencer] = useState(false);
  const [presentMode, setPresentMode]     = useState(false);
  const holdTimerRef                      = useRef(null);
  const transitionTimerRef                = useRef(null);

  // Outlier filter
  const [outlierActive, setOutlierActive]     = useState(true);
  const [outlierCutoff, setOutlierCutoff]     = useState(2000);
  const [outlierInput, setOutlierInput]       = useState("2000");

  // ── Data ──
  const [fieldCache, setFieldCache]   = useState({});
  const [loading, setLoading]         = useState(false);
  const [buildings3D, setBuildings3D] = useState(null);

  // ── One-time fetches ──
  useEffect(() => {
    fetchJson(`${API}/api/dh-fields`)
      .then((fields) => {
        setAvailableFields(fields);
        const preferred = fields.find((f) => f.field === "dh_2018");
        if (preferred) setSelectedFields([preferred.field]);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    fetchJson(`${API}/api/point-heights`).then(setPointHeights).catch(() => {});
  }, []);

  useEffect(() => {
    if (!explodedView || Object.keys(spreadPositions).length > 0 || spreadLoading) return;
    setSpreadLoading(true);
    fetchJson(`${API}/api/spread-positions`)
      .then((d) => { setSpreadPositions(d); setSpreadLoading(false); })
      .catch(() => setSpreadLoading(false));
  }, [explodedView]);

  useEffect(() => {
    fetchJson(`${API}/api/all-buildings`).then(setBuildings3D).catch(() => {});
  }, []);

  // ── Fetch field data on demand ──
  useEffect(() => {
    const missing = selectedFields.filter((f) => !fieldCache[f]);
    if (!missing.length) return;
    setLoading(true);
    Promise.all(
      missing.map((f) =>
        fetchJson(`${API}/api/dh-data?field=${encodeURIComponent(f)}`)
          .then((data) => ({ field: f, data }))
          .catch(() => ({ field: f, data: [] }))
      )
    ).then((results) => {
      setFieldCache((prev) => {
        const next = { ...prev };
        results.forEach(({ field, data }) => { next[field] = data; });
        return next;
      });
      setLoading(false);
    });
  }, [selectedFields]);

  // ── Auto-suggest outlier cutoff when data arrives (99th percentile) ──
  useEffect(() => {
    if (outlierCutoff !== null) return; // already set by user
    const all = [];
    selectedFields.forEach((f) => {
      const data = fieldCache[f];
      if (data) data.forEach((d) => { if (d.value > 0) all.push(d.value); });
    });
    if (!all.length) return;
    const sorted = [...all].sort((a, b) => a - b);
    const p99 = percentile(sorted, 99);
    const suggested = Math.ceil(p99);
    setOutlierCutoff(suggested);
    setOutlierInput(String(suggested));
  }, [fieldCache, selectedFields]);

  // Single animation loop — all animations run in parallel
  const isAnimating = isRotating || isZooming || isTilting || isSweeping || isFlyover || isZoomIn || isZoomOut;
  useEffect(() => {
    if (!isAnimating) {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      lastTimeRef.current = null;
      return;
    }
    const ZOOM_PERIOD_MS = 20000;
    const TILT_PERIOD_MS = 15000;
    // lon/lat metres → degrees at ~57.7°N
    const LON_PER_M = 1 / 59400;
    const LAT_PER_M = 1 / 111000;

    const step = (timestamp) => {
      if (lastTimeRef.current !== null) {
        const dt = timestamp - lastTimeRef.current;
        elapsedRef.current += dt;
        if (isSweeping) sweepElapsed.current  += dt;
        if (isZoomIn)   zoomInElapsed.current  += dt;
        if (isZoomOut)  zoomOutElapsed.current += dt;

        let sweepDone = false;
        let zoomInDone = false;
        let zoomOutDone = false;

        setViewState((vs) => {
          // ── Capture base values on first frame ──
          if (isZooming  && zoomBaseRef.current   === null) zoomBaseRef.current   = vs.zoom;
          if (isZoomIn   && zoomInStart.current   === null) zoomInStart.current   = vs.zoom;
          if (isZoomOut  && zoomOutStart.current  === null) zoomOutStart.current  = vs.zoom;
          if (isTilting  && pitchBaseRef.current === null) pitchBaseRef.current = vs.pitch;
          if (isSweeping && pitchBaseRef.current === null) pitchBaseRef.current = vs.pitch;

          // ── Rotation ──
          const bearing = isRotating
            ? (vs.bearing + rotateSpeed * (dt / 1000)) % 360
            : vs.bearing;

          // ── Zoom ──
          let zoom = vs.zoom;
          if (isZooming) {
            zoom = (zoomBaseRef.current ?? vs.zoom) +
              zoomAmp * Math.sin((2 * Math.PI * elapsedRef.current) / ZOOM_PERIOD_MS);
          } else if (isZoomIn) {
            const t = Math.min(1, zoomInElapsed.current / zoomInDuration);
            zoom = (zoomInStart.current ?? vs.zoom) + Math.log2(zoomInFactor) * t;
            if (t >= 1) zoomInDone = true;
          } else if (isZoomOut) {
            const t = Math.min(1, zoomOutElapsed.current / zoomOutDuration);
            zoom = (zoomOutStart.current ?? vs.zoom) - Math.log2(zoomOutFactor) * t;
            if (t >= 1) zoomOutDone = true;
          }

          // ── Tilt (oscillate) ──
          let pitch = vs.pitch;
          if (isTilting) {
            pitch = Math.max(0, Math.min(80,
              (pitchBaseRef.current ?? vs.pitch) +
              tiltAmp * Math.sin((2 * Math.PI * elapsedRef.current) / TILT_PERIOD_MS)
            ));
          } else if (isSweeping) {
            // One-way linear sweep from current pitch → sweepTarget
            const t = Math.min(1, sweepElapsed.current / sweepDuration);
            const start = pitchBaseRef.current ?? vs.pitch;
            pitch = start + (sweepTarget - start) * t;
            if (t >= 1) sweepDone = true;
          }

          // ── Flyover: straight-line travel in bearing direction ──
          let longitude = vs.longitude;
          let latitude  = vs.latitude;
          if (isFlyover) {
            const bearingRad = (vs.bearing * Math.PI) / 180;
            const distMetres = flyoverSpeed * (dt / 1000);
            longitude += distMetres * LON_PER_M * Math.sin(bearingRad);
            latitude  += distMetres * LAT_PER_M * Math.cos(bearingRad);
          }

          return { ...vs, bearing, zoom, pitch, longitude, latitude };
        });

        if (sweepDone) {
          setIsSweeping(false);
          pitchBaseRef.current = null;
          sweepElapsed.current = 0;
        }
        if (zoomInDone) {
          setIsZoomIn(false);
          zoomInStart.current   = null;
          zoomInElapsed.current = 0;
        }
        if (zoomOutDone) {
          setIsZoomOut(false);
          zoomOutStart.current   = null;
          zoomOutElapsed.current = 0;
        }
      }
      lastTimeRef.current = timestamp;
      animFrameRef.current = requestAnimationFrame(step);
    };
    animFrameRef.current = requestAnimationFrame(step);
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, [isAnimating, isRotating, isZooming, isTilting, isSweeping, isFlyover, isZoomIn, isZoomOut,
      rotateSpeed, zoomAmp, tiltAmp, sweepTarget, sweepDuration, flyoverSpeed,
      zoomInFactor, zoomInDuration, zoomOutFactor, zoomOutDuration]);

  const startZoom    = () => { elapsedRef.current = 0; zoomBaseRef.current = null; setIsZooming(true); };
  const startZoomIn  = () => { zoomInElapsed.current = 0; zoomInStart.current = null; setIsZoomIn(true); };
  const startZoomOut = () => { zoomOutElapsed.current = 0; zoomOutStart.current = null; setIsZoomOut(true); };
  const startTilt    = () => { elapsedRef.current = 0; pitchBaseRef.current = null; setIsTilting(true); };
  const startSweep   = () => { sweepElapsed.current = 0; pitchBaseRef.current = null; setIsSweeping(true); };

  // ── Sequencer helpers ──
  const captureState = useCallback(() => ({
    id: Date.now(),
    label: "",                          // filled by caller
    rotate: isRotating,   rotateSpeed,
    zoom: isZooming,      zoomAmp,
    zoomIn: isZoomIn,     zoomInFactor,   zoomInDuration,
    zoomOut: isZoomOut,   zoomOutFactor,  zoomOutDuration,
    tilt: isTilting,      tiltAmp,
    sweep: isSweeping,    sweepTarget,    sweepDuration,
    flyover: isFlyover,   flyoverSpeed,
    hold: 5,              // seconds to wait before auto-advance
    fade: 2,              // seconds for fly-to transition
    view: { ...viewState },             // camera position snapshot
  }), [isRotating, rotateSpeed, isZooming, zoomAmp,
       isZoomIn, zoomInFactor, zoomInDuration,
       isZoomOut, zoomOutFactor, zoomOutDuration,
       isTilting, tiltAmp, isSweeping, sweepTarget, sweepDuration,
       isFlyover, flyoverSpeed, viewState]);

  const applyCue = useCallback((cue) => {
    // Cancel any pending transition timer
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);

    // Reset one-way refs so they restart cleanly
    zoomInStart.current = null;   zoomInElapsed.current = 0;
    zoomOutStart.current = null;  zoomOutElapsed.current = 0;
    pitchBaseRef.current = null;  sweepElapsed.current = 0;

    // Stop all animations during the fly-to
    setIsRotating(false); setIsZooming(false); setIsZoomIn(false);
    setIsZoomOut(false);  setIsTilting(false);  setIsSweeping(false); setIsFlyover(false);

    const fadeMs = (cue.fade ?? 0) * 1000;

    // Fly camera to saved position
    if (cue.view) {
      setViewState({
        ...cue.view,
        ...(fadeMs > 0 ? {
          transitionDuration: fadeMs,
          transitionInterpolator: new FlyToInterpolator({ speed: 1.5 }),
        } : {}),
      });
    }

    // Start cue animations after the fly-to completes
    const startAnims = () => {
      setIsRotating(cue.rotate);      setRotateSpeed(cue.rotateSpeed);
      setIsZooming(cue.zoom);         setZoomAmp(cue.zoomAmp);
      setIsZoomIn(cue.zoomIn);        setZoomInFactor(cue.zoomInFactor);   setZoomInDuration(cue.zoomInDuration);
      setIsZoomOut(cue.zoomOut);      setZoomOutFactor(cue.zoomOutFactor); setZoomOutDuration(cue.zoomOutDuration);
      setIsTilting(cue.tilt);         setTiltAmp(cue.tiltAmp);
      setIsSweeping(cue.sweep);       setSweepTarget(cue.sweepTarget);     setSweepDuration(cue.sweepDuration);
      setIsFlyover(cue.flyover);      setFlyoverSpeed(cue.flyoverSpeed);
    };

    if (fadeMs > 0) {
      transitionTimerRef.current = setTimeout(startAnims, fadeMs);
    } else {
      startAnims();
    }
  }, []);

  const updateCue = useCallback(() => {
    if (activeCueIdx < 0) return;
    const snapshot = captureState();
    setCues((prev) => prev.map((c, i) => i === activeCueIdx
      ? { ...snapshot, id: c.id, label: c.label, hold: c.hold, fade: c.fade }
      : c
    ));
  }, [activeCueIdx, captureState]);

  const saveCues = useCallback(() => {
    try {
      localStorage.setItem("dh-cues", JSON.stringify(cues));
    } catch (e) { console.error("Save failed", e); }
  }, [cues]);

  const loadCues = useCallback(() => {
    try {
      const saved = localStorage.getItem("dh-cues");
      if (saved) { setCues(JSON.parse(saved)); setActiveCueIdx(-1); setShowSequencer(true); }
    } catch (e) { console.error("Load failed", e); }
  }, []);

  const addCue = useCallback(() => {
    setCues((prev) => {
      const n = prev.length + 1;
      return [...prev, { ...captureState(), label: `Cue ${n}` }];
    });
    setShowSequencer(true);
  }, [captureState]);

  const goTo = useCallback((idx) => {
    setCues((prev) => {
      if (idx < 0 || idx >= prev.length) return prev;
      applyCue(prev[idx]);
      setActiveCueIdx(idx);
      return prev;
    });
  }, [applyCue]);

  // Auto-advance hold timer
  useEffect(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (!sequencerAuto || activeCueIdx < 0) return;
    const cue = cues[activeCueIdx];
    if (!cue || !cue.hold) return;
    holdTimerRef.current = setTimeout(() => {
      const next = activeCueIdx + 1;
      if (next < cues.length) {
        goTo(next);
      } else if (sequencerLoop) {
        goTo(0);
      } else {
        setActiveCueIdx(-1);
        setSequencerAuto(false);
      }
    }, cue.hold * 1000);
    return () => clearTimeout(holdTimerRef.current);
  }, [activeCueIdx, sequencerAuto, sequencerLoop, cues, goTo]);

  // Stop animations on manual interaction
  const handleViewStateChange = useCallback(({ viewState: vs, interactionState }) => {
    if (interactionState?.isDragging || interactionState?.isRotating) setIsRotating(false);
    if (interactionState?.isZooming) {
      setIsZooming(false); zoomBaseRef.current = null;
      setIsZoomIn(false);  zoomInStart.current = null;   zoomInElapsed.current = 0;
      setIsZoomOut(false); zoomOutStart.current = null;  zoomOutElapsed.current = 0;
    }
    if (interactionState?.isDragging) {
      setIsTilting(false);
      setIsSweeping(false); pitchBaseRef.current = null; sweepElapsed.current = 0;
      setIsFlyover(false);
    }
    setViewState({ ...vs });
  }, []);

  // Also update suggestion when fields change (if user hasn't manually set it)
  const userSetCutoffRef = useRef(false);
  const applyOutlierInput = () => {
    const v = parseFloat(outlierInput);
    if (!isNaN(v) && v > 0) {
      userSetCutoffRef.current = true;
      setOutlierCutoff(v);
    }
  };

  // ── Effective cutoff (null = no filtering) ──
  const activeCutoff = outlierActive && outlierCutoff != null ? outlierCutoff : null;

  // ── Max value for color/height scale (respects outlier filter) ──
  const maxValue = useMemo(() => {
    let max = 0;
    selectedFields.forEach((f) => {
      const data = fieldCache[f];
      if (data) {
        data.forEach((d) => {
          const v = d.value;
          if (activeCutoff !== null && v > activeCutoff) return; // skip outlier
          if (v > max) max = v;
        });
      }
    });
    return max || 1;
  }, [fieldCache, selectedFields, activeCutoff]);

  // Count outliers across all selected fields
  const outlierCount = useMemo(() => {
    if (activeCutoff === null) return 0;
    let n = 0;
    selectedFields.forEach((f) => {
      const data = fieldCache[f];
      if (data) data.forEach((d) => { if (d.value > activeCutoff) n++; });
    });
    return n;
  }, [fieldCache, selectedFields, activeCutoff]);

  // Auto-scale: max column ≈ 40 m
  const baseH = maxValue > 0 ? 40 / maxValue : 1;

  // ── Layers ──
  const layers = useMemo(() => {
    const ls = [];

    if (showBuildings && buildings3D?.features?.length) {
      ls.push(
        new GeoJsonLayer({
          id: "dh-buildings",
          data: buildings3D,
          filled: true,
          stroked: false,
          extruded: true,
          getElevation: (f) => f.properties?.height ?? 10,
          getFillColor: [55, 75, 110, 130],
          material: { ambient: 0.4, diffuse: 0.6, shininess: 32, specularColor: [60, 60, 60] },
        })
      );
    }

    const LON_PER_M = 1 / 59400; // at ~57.7°N
    const LAT_PER_M = 1 / 111000;
    const gap = radius * 2.5 + 2;

    // Pre-compute building centroids for lean offset
    const buildingCentroids = {};
    if (explodedView) {
      Object.entries(pointHeights).forEach(([sid, h]) => {
        const bid = h.lm_building_id;
        if (!bid) return;
        if (!buildingCentroids[bid]) buildingCentroids[bid] = { sumLat: 0, sumLon: 0, n: 0 };
        const sp = spreadPositions[sid];
        const lat = (sp?.spread_lat != null) ? sp.spread_lat : h.lat;
        const lon = (sp?.spread_lon != null) ? sp.spread_lon : h.lon;
        if (lat != null && lon != null) {
          buildingCentroids[bid].sumLat += lat;
          buildingCentroids[bid].sumLon += lon;
          buildingCentroids[bid].n++;
        }
      });
      Object.values(buildingCentroids).forEach((c) => {
        c.lat = c.sumLat / c.n;
        c.lon = c.sumLon / c.n;
      });
    }

    selectedFields.forEach((field, idx) => {
      const data = fieldCache[field];
      if (!data?.length) return;

      const lonOffset = idx * gap * LON_PER_M;

      // Filter outliers
      const visible = data.filter((d) => activeCutoff === null || d.value <= activeCutoff);

      ls.push(
        new ColumnLayer({
          id: `dh-${field}`,
          data: visible,
          getPosition: (d) => {
            const h = pointHeights[d.sensor_id];
            const sp = spreadPositions[d.sensor_id];

            // Base position: spread → parquet → raw
            let lat, lon;
            if (explodedView && sp?.spread_lat != null) {
              lat = sp.spread_lat;
              lon = sp.spread_lon;
            } else {
              lat = (useParquetCoords && h?.lat != null) ? h.lat : d.lat;
              lon = (useParquetCoords && h?.lon != null) ? h.lon : d.lon;
            }

            // Lean outward from building centroid by floor × leanScale metres
            if (explodedView && leanScale > 0 && h?.lm_building_id) {
              const c = buildingCentroids[h.lm_building_id];
              const floor = h.floor ?? 0;
              if (c && floor > 0) {
                const dLat = lat - c.lat;
                const dLon = lon - c.lon;
                const dist = Math.sqrt(dLat * dLat + dLon * dLon);
                const offsetM = floor * leanScale;
                if (dist > 1e-9) {
                  lat += (dLat / dist) * offsetM * LAT_PER_M;
                  lon += (dLon / dist) * offsetM * LON_PER_M;
                } else {
                  lat += offsetM * LAT_PER_M; // centroid fallback: nudge north
                }
              }
            }

            return [lon + lonOffset, lat];
          },
          getElevation: (d) => Math.max(0.5, d.value * baseH * heightScale),
          getFillColor: (d) => [...dhToColor(d.value, maxValue), 230],
          getLineColor: (d) => [...dhToColor(d.value, maxValue), 80],
          radius,
          diskResolution: 18,
          extruded: true,
          stroked: false,
          pickable: true,
          updateTriggers: {
            getPosition:  [useParquetCoords, pointHeights, lonOffset, explodedView, spreadPositions, leanScale],
            getElevation: [baseH, heightScale],
            getFillColor: [maxValue],
          },
        })
      );
    });

    return ls;
  }, [
    showBuildings, buildings3D,
    selectedFields, fieldCache,
    heightScale, radius, maxValue, baseH,
    activeCutoff,
    useParquetCoords, pointHeights,
    explodedView, spreadPositions, leanScale,
  ]);

  // ── Tooltip ──
  const getTooltip = useCallback(({ object, layer }) => {
    if (!object) return null;
    const field = layer?.id?.replace("dh-", "");
    const meta = FIELD_META[field] ?? { label: field, unit: "" };
    return {
      html: `<strong style="color:#e0e0e0">${object.sensor_id}</strong><br/><span style="color:#8b949e">${meta.label}</span><br/><span style="color:#E9C46A;font-size:13px"><strong>${object.value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${meta.unit}</strong></span>`,
      style: {
        background: "#1a1f2e",
        border: "1px solid #3d4555",
        borderRadius: "6px",
        padding: "8px 12px",
        fontSize: "12px",
        fontFamily: "monospace",
        pointerEvents: "none",
      },
    };
  }, []);

  const toggleField = (f) => {
    setSelectedFields((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]
    );
  };

  const fieldGroups = useMemo(() => {
    const groups = { year: [], threshold: [], other: [] };
    availableFields.forEach(({ field }) => {
      const g = FIELD_META[field]?.group ?? "other";
      groups[g].push(field);
    });
    return groups;
  }, [availableFields]);

  const s = styles;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: presentMode ? "calc(100vh - 120px)" : "calc(100vh - 220px)", minHeight: 520 }}>
      {/* ── Controls row 1: field selection ── */}
      {!presentMode && <div style={s.controlBar}>
        {fieldGroups.year.length > 0 && (
          <div style={s.controlGroup}>
            <span style={s.label}>Year</span>
            {fieldGroups.year.map((f) => {
              const active = selectedFields.includes(f);
              const color = FIELD_COLORS[selectedFields.indexOf(f) % FIELD_COLORS.length] ?? FIELD_COLORS[0];
              return (
                <button key={f} onClick={() => toggleField(f)} style={{
                  ...s.btn,
                  borderColor: active ? color : "#3d4555",
                  color: active ? color : "#8b949e",
                  background: active ? `${color}22` : "none",
                  fontWeight: active ? 700 : 400,
                }}>
                  {FIELD_META[f]?.label ?? f}
                </button>
              );
            })}
          </div>
        )}

        {fieldGroups.year.length > 0 && <div style={s.sep} />}

        {fieldGroups.threshold.length > 0 && (
          <div style={s.controlGroup}>
            <span style={s.label}>Threshold</span>
            {fieldGroups.threshold.map((f) => {
              const active = selectedFields.includes(f);
              const color = FIELD_COLORS[selectedFields.indexOf(f) % FIELD_COLORS.length] ?? FIELD_COLORS[0];
              return (
                <button key={f} onClick={() => toggleField(f)} style={{
                  ...s.btn,
                  borderColor: active ? color : "#3d4555",
                  color: active ? color : "#8b949e",
                  background: active ? `${color}22` : "none",
                  fontWeight: active ? 700 : 400,
                }}>
                  {FIELD_META[f]?.label ?? f}
                </button>
              );
            })}
          </div>
        )}

        {fieldGroups.threshold.length > 0 && <div style={s.sep} />}

        {fieldGroups.other.map((f) => {
          const active = selectedFields.includes(f);
          const color = FIELD_COLORS[selectedFields.indexOf(f) % FIELD_COLORS.length] ?? FIELD_COLORS[0];
          return (
            <button key={f} onClick={() => toggleField(f)} style={{
              ...s.btn,
              borderColor: active ? color : "#3d4555",
              color: active ? color : "#8b949e",
              background: active ? `${color}22` : "none",
            }}>
              {FIELD_META[f]?.label ?? f}
            </button>
          );
        })}
      </div>}

      {/* ── Controls row 2: display options ── */}
      {!presentMode && <div style={s.controlBar}>
        {/* Outlier filter */}
        <div style={s.controlGroup}>
          <button
            onClick={() => setOutlierActive((v) => !v)}
            style={{
              ...s.btn,
              borderColor: outlierActive ? "#f85149" : "#3d4555",
              color: outlierActive ? "#f85149" : "#8b949e",
              background: outlierActive ? "#f8514922" : "none",
            }}
          >
            ⚠ Outlier filter
          </button>
          <span style={s.label}>cutoff</span>
          <input
            value={outlierInput}
            onChange={(e) => setOutlierInput(e.target.value)}
            onBlur={applyOutlierInput}
            onKeyDown={(e) => e.key === "Enter" && applyOutlierInput()}
            style={{ ...s.numInput, width: 60 }}
            placeholder="value"
            title="Sensors above this value are hidden. Color & height scale recalculated."
          />
          {outlierActive && outlierCount > 0 && (
            <span style={{ fontSize: 10, color: "#f85149" }}>
              {outlierCount} hidden
            </span>
          )}
        </div>

        <div style={s.sep} />

        {/* Height scale */}
        <div style={s.controlGroup}>
          <span style={s.label}>Height ×{heightScale.toFixed(1)}</span>
          <input type="range" min={0.1} max={25} step={0.1} value={heightScale}
            onChange={(e) => setHeightScale(Number(e.target.value))}
            style={{ width: 160, accentColor: "#E9C46A", cursor: "pointer" }} />
        </div>

        {/* Radius */}
        <div style={s.controlGroup}>
          <span style={s.label}>r {radius}m</span>
          <input type="range" min={2} max={20} step={1} value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            style={{ width: 60, accentColor: "#58a6ff", cursor: "pointer" }} />
        </div>

        <div style={s.sep} />

        {/* Parquet coords */}
        <button
          onClick={() => setUseParquetCoords((v) => !v)}
          style={{
            ...s.btn,
            borderColor: useParquetCoords ? "#4CC9F0" : "#3d4555",
            color: useParquetCoords ? "#4CC9F0" : "#8b949e",
            background: useParquetCoords ? "#4CC9F022" : "none",
          }}
          title="Use refined sensor coordinates from parquet file"
        >
          ⌖ Parquet coords
        </button>

        {/* Buildings */}
        <button
          onClick={() => setShowBuildings((v) => !v)}
          style={{
            ...s.btn,
            borderColor: showBuildings ? "#6BCB77" : "#3d4555",
            color: showBuildings ? "#6BCB77" : "#8b949e",
            background: showBuildings ? "#6BCB7722" : "none",
          }}
        >
          ▦ Bldgs
        </button>

        {/* Exploded building view */}
        <div style={s.controlGroup}>
          <button
            onClick={() => setExplodedView((v) => !v)}
            style={{
              ...s.btn,
              borderColor: explodedView ? "#FF6B9D" : "#3d4555",
              color: explodedView ? "#FF6B9D" : "#8b949e",
              background: explodedView ? "#FF6B9D22" : "none",
            }}
            title="Spread sensors evenly within building footprint and lean outward by floor">
            {spreadLoading ? "⟳ Loading…" : "⬡ Explode"}
          </button>
          <span style={s.label}>lean {leanScale}m/fl</span>
          <input type="range" min={0} max={20} step={0.5} value={leanScale}
            onChange={(e) => setLeanScale(Number(e.target.value))}
            style={{ width: 80, accentColor: "#FF6B9D", cursor: "pointer" }} />
        </div>

        <div style={s.sep} />

        {/* Camera rotation */}
        <div style={s.controlGroup}>
          <button onClick={() => setIsRotating((v) => !v)}
            style={{ ...s.btn, ...s.toggleBtn, borderColor: isRotating ? "#E9C46A" : "#3d4555", color: isRotating ? "#E9C46A" : "#8b949e", background: isRotating ? "#E9C46A22" : "none" }}
            title="Rotate camera continuously">
            {isRotating ? "⏸ Rotate" : "↻ Rotate"}
          </button>
          {[0.1, 0.3, 1, 3].map((spd) => (
            <button key={spd} onClick={() => setRotateSpeed(spd)} style={{ ...s.btn, padding: "2px 6px", fontSize: 10, borderColor: rotateSpeed === spd ? "#E9C46A" : "#3d4555", color: rotateSpeed === spd ? "#E9C46A" : "#8b949e", background: rotateSpeed === spd ? "#E9C46A22" : "none" }}>
              {spd}×
            </button>
          ))}
        </div>

        <div style={s.sep} />

        {/* Camera zoom */}
        <div style={s.controlGroup}>
          <button onClick={() => { isZooming ? setIsZooming(false) : startZoom(); }}
            style={{ ...s.btn, ...s.toggleBtn, borderColor: isZooming ? "#C8B6FF" : "#3d4555", color: isZooming ? "#C8B6FF" : "#8b949e", background: isZooming ? "#C8B6FF22" : "none" }}
            title="Oscillating zoom in/out (20 s cycle)">
            {isZooming ? "⏸ Zoom" : "⇱ Zoom"}
          </button>
          {[0.5, 1, 2].map((amp) => (
            <button key={amp} onClick={() => setZoomAmp(amp)} style={{ ...s.btn, padding: "2px 6px", fontSize: 10, borderColor: zoomAmp === amp ? "#C8B6FF" : "#3d4555", color: zoomAmp === amp ? "#C8B6FF" : "#8b949e", background: zoomAmp === amp ? "#C8B6FF22" : "none" }}>
              ±{amp}
            </button>
          ))}
        </div>

        {/* One-way zoom in */}
        <div style={s.controlGroup}>
          <button onClick={() => { isZoomIn ? setIsZoomIn(false) : startZoomIn(); }}
            style={{ ...s.btn, ...s.toggleBtn, borderColor: isZoomIn ? "#C8B6FF" : "#3d4555", color: isZoomIn ? "#C8B6FF" : "#8b949e", background: isZoomIn ? "#C8B6FF22" : "none" }}
            title="Zoom in one-way to a target magnification, then stops">
            {isZoomIn ? "⏸ Zoom in" : "⊕ Zoom in"}
          </button>
          {[2, 3, 5, 10].map((f) => (
            <button key={f} onClick={() => setZoomInFactor(f)} style={{ ...s.btn, padding: "2px 6px", fontSize: 10, borderColor: zoomInFactor === f ? "#C8B6FF" : "#3d4555", color: zoomInFactor === f ? "#C8B6FF" : "#8b949e", background: zoomInFactor === f ? "#C8B6FF22" : "none" }}>
              {f}×
            </button>
          ))}
          {[4000, 8000, 16000].map((d) => (
            <button key={d} onClick={() => setZoomInDuration(d)} style={{ ...s.btn, padding: "2px 6px", fontSize: 10, borderColor: zoomInDuration === d ? "#C8B6FF" : "#3d4555", color: zoomInDuration === d ? "#C8B6FF" : "#8b949e", background: zoomInDuration === d ? "#C8B6FF22" : "none" }}>
              {d / 1000}s
            </button>
          ))}
        </div>

        {/* One-way zoom out */}
        <div style={s.controlGroup}>
          <button onClick={() => { isZoomOut ? setIsZoomOut(false) : startZoomOut(); }}
            style={{ ...s.btn, ...s.toggleBtn, borderColor: isZoomOut ? "#C8B6FF" : "#3d4555", color: isZoomOut ? "#C8B6FF" : "#8b949e", background: isZoomOut ? "#C8B6FF22" : "none" }}
            title="Zoom out one-way, then stops">
            {isZoomOut ? "⏸ Zoom out" : "⊖ Zoom out"}
          </button>
          {[2, 3, 5, 10].map((f) => (
            <button key={f} onClick={() => setZoomOutFactor(f)} style={{ ...s.btn, padding: "2px 6px", fontSize: 10, borderColor: zoomOutFactor === f ? "#C8B6FF" : "#3d4555", color: zoomOutFactor === f ? "#C8B6FF" : "#8b949e", background: zoomOutFactor === f ? "#C8B6FF22" : "none" }}>
              {f}×
            </button>
          ))}
          {[4000, 8000, 16000].map((d) => (
            <button key={d} onClick={() => setZoomOutDuration(d)} style={{ ...s.btn, padding: "2px 6px", fontSize: 10, borderColor: zoomOutDuration === d ? "#C8B6FF" : "#3d4555", color: zoomOutDuration === d ? "#C8B6FF" : "#8b949e", background: zoomOutDuration === d ? "#C8B6FF22" : "none" }}>
              {d / 1000}s
            </button>
          ))}
        </div>

        <div style={s.sep} />

        {/* Tilt oscillate */}
        <div style={s.controlGroup}>
          <button onClick={() => { isTilting ? setIsTilting(false) : startTilt(); }}
            style={{ ...s.btn, ...s.toggleBtn, borderColor: isTilting ? "#FF6B9D" : "#3d4555", color: isTilting ? "#FF6B9D" : "#8b949e", background: isTilting ? "#FF6B9D22" : "none" }}
            title="Oscillate camera pitch (15 s cycle)">
            {isTilting ? "⏸ Tilt" : "⟂ Tilt"}
          </button>
          {[10, 20, 35].map((amp) => (
            <button key={amp} onClick={() => setTiltAmp(amp)} style={{ ...s.btn, padding: "2px 6px", fontSize: 10, borderColor: tiltAmp === amp ? "#FF6B9D" : "#3d4555", color: tiltAmp === amp ? "#FF6B9D" : "#8b949e", background: tiltAmp === amp ? "#FF6B9D22" : "none" }}>
              ±{amp}°
            </button>
          ))}
        </div>

        {/* Tilt one-way sweep */}
        <div style={s.controlGroup}>
          <button onClick={() => { isSweeping ? setIsSweeping(false) : startSweep(); }}
            style={{ ...s.btn, ...s.toggleBtn, borderColor: isSweeping ? "#FF6B9D" : "#3d4555", color: isSweeping ? "#FF6B9D" : "#8b949e", background: isSweeping ? "#FF6B9D22" : "none" }}
            title="One-way tilt to target pitch, then stops">
            {isSweeping ? "⏸ Sweep" : "↓ Sweep"}
          </button>
          <span style={s.label}>→</span>
          {[5, 30, 60, 75].map((t) => (
            <button key={t} onClick={() => setSweepTarget(t)} style={{ ...s.btn, padding: "2px 6px", fontSize: 10, borderColor: sweepTarget === t ? "#FF6B9D" : "#3d4555", color: sweepTarget === t ? "#FF6B9D" : "#8b949e", background: sweepTarget === t ? "#FF6B9D22" : "none" }}>
              {t}°
            </button>
          ))}
          {[5000, 10000, 20000].map((d) => (
            <button key={d} onClick={() => setSweepDuration(d)} style={{ ...s.btn, padding: "2px 6px", fontSize: 10, borderColor: sweepDuration === d ? "#FF6B9D" : "#3d4555", color: sweepDuration === d ? "#FF6B9D" : "#8b949e", background: sweepDuration === d ? "#FF6B9D22" : "none" }}>
              {d / 1000}s
            </button>
          ))}
        </div>

        <div style={s.sep} />

        {/* Flyover — straight travel in bearing direction */}
        <div style={s.controlGroup}>
          <button onClick={() => setIsFlyover((v) => !v)}
            style={{ ...s.btn, ...s.toggleBtn, borderColor: isFlyover ? "#6BCB77" : "#3d4555", color: isFlyover ? "#6BCB77" : "#8b949e", background: isFlyover ? "#6BCB7722" : "none" }}
            title="Fly straight in current bearing direction — combine with Rotate to steer">
            {isFlyover ? "⏸ Flyover" : "→ Flyover"}
          </button>
          {[10, 30, 100].map((spd) => (
            <button key={spd} onClick={() => setFlyoverSpeed(spd)} style={{ ...s.btn, padding: "2px 6px", fontSize: 10, borderColor: flyoverSpeed === spd ? "#6BCB77" : "#3d4555", color: flyoverSpeed === spd ? "#6BCB77" : "#8b949e", background: flyoverSpeed === spd ? "#6BCB7722" : "none" }}>
              {spd}m/s
            </button>
          ))}
        </div>

        <div style={s.sep} />

        {/* Map style */}
        <select value={mapStyleId} onChange={(e) => setMapStyleId(e.target.value)} style={s.select}>
          {MAP_STYLES.map((ms) => <option key={ms.id} value={ms.id}>{ms.name}</option>)}
        </select>

        <div style={s.sep} />

        {/* Sequencer toggle */}
        <button onClick={() => setShowSequencer((v) => !v)}
          style={{ ...s.btn, borderColor: showSequencer ? "#E9C46A" : "#3d4555", color: showSequencer ? "#E9C46A" : "#8b949e", background: showSequencer ? "#E9C46A22" : "none" }}>
          ⬡ Sequencer {cues.length > 0 && `(${cues.length})`}
        </button>
        <button onClick={addCue}
          style={{ ...s.btn, borderColor: "#6BCB77", color: "#6BCB77" }}
          title="Add current view and animation state as a new cue">
          ⊕ Add cue
        </button>
        <button onClick={updateCue}
          disabled={activeCueIdx < 0}
          style={{ ...s.btn, borderColor: activeCueIdx >= 0 ? "#4CC9F0" : "#3d4555", color: activeCueIdx >= 0 ? "#4CC9F0" : "#556677", opacity: activeCueIdx < 0 ? 0.5 : 1 }}
          title="Update the active cue with current view and animation state">
          ⟳ Update cue
        </button>

        <div style={s.sep} />

        <button onClick={() => setPresentMode(true)}
          style={{ ...s.btn, borderColor: "#C8B6FF", color: "#C8B6FF" }}
          title="Hide controls for screen recording">
          ⛶ Present
        </button>
      </div>}

      {/* ── Map ── */}
      <div style={{ position: "relative", flex: 1, minHeight: 300, borderRadius: 8, overflow: "hidden", border: "1px solid #2e3440" }}>
        <DeckGL
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          controller={true}
          layers={layers}
          getTooltip={getTooltip}
        >
          <Map
            key={mapStyleId}
            mapStyle={resolveStyle(MAP_STYLES.find((ms) => ms.id === mapStyleId).url)}
            mapboxAccessToken={MAPBOX_TOKEN}
          />
        </DeckGL>

        {loading && <div style={s.overlay}>Loading degree hours…</div>}

        {!loading && selectedFields.length === 0 && (
          <div style={s.overlay}>Select a field above to visualise.</div>
        )}

        {/* Legend */}
        {!loading && selectedFields.length > 0 && (
          <div style={s.legend}>
            <div style={{ fontSize: 13, color: "#8b949e", marginBottom: 6 }}>
              {selectedFields.map((f) => FIELD_META[f]?.label ?? f).join(" · ")}
              {activeCutoff !== null && (
                <span style={{ color: "#f85149" }}> · cutoff {activeCutoff}</span>
              )}
            </div>
            {/* Color bar */}
            <div style={{
              width: 210, height: 14, borderRadius: 4,
              background: `linear-gradient(to right, ${DH_COLOR_STOPS.map((c) => `rgb(${c.join(",")})`).join(",")})`,
            }} />
            <div style={{ display: "flex", justifyContent: "space-between", width: 210, marginTop: 3, fontSize: 13, color: "#8b949e" }}>
              <span>0</span>
              <span>{Math.round(maxValue / 2).toLocaleString()}</span>
              <span>{Math.round(maxValue).toLocaleString()}</span>
            </div>
            <div style={{ marginTop: 7, fontSize: 13, color: "#8b949e" }}>
              Max height: {Math.round(40 * heightScale)} m
            </div>
            {selectedFields.length > 1 && (
              <div style={{ marginTop: 7, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {selectedFields.map((f, i) => (
                  <span key={f} style={{ fontSize: 13, color: FIELD_COLORS[i % FIELD_COLORS.length], fontWeight: 700 }}>
                    ▪ {FIELD_META[f]?.label ?? f}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Present mode overlay controls */}
        {presentMode && (
          <div style={{ position: "absolute", top: 10, right: 10, zIndex: 20, display: "flex", gap: 5 }}>
            <button
              onClick={() => { const next = activeCueIdx + 1; if (next < cues.length) goTo(next); else if (cues.length > 0) goTo(0); }}
              disabled={cues.length === 0}
              style={{ ...s.presentBtn, borderColor: "#E9C46A", color: "#E9C46A", opacity: cues.length === 0 ? 0.4 : 1 }}>
              Go ▶
            </button>
            <button
              onClick={() => setSequencerAuto((v) => !v)}
              style={{ ...s.presentBtn, borderColor: sequencerAuto ? "#6BCB77" : "#556677", color: sequencerAuto ? "#6BCB77" : "#8b949e" }}>
              {sequencerAuto ? "⏸ Auto" : "▷ Auto"}
            </button>
            <button
              onClick={() => setPresentMode(false)}
              style={{ ...s.presentBtn, borderColor: "#C8B6FF", color: "#C8B6FF" }}>
              ✕ Exit
            </button>
          </div>
        )}
      </div>

      {/* ── Sequencer Panel ── */}
      {!presentMode && showSequencer && (
        <div style={s.sequencerPanel}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, borderBottom: "1px solid #2e3440", paddingBottom: 8 }}>
            <span style={{ fontSize: 12, color: "#E9C46A", fontWeight: 700 }}>⬡ Cue List</span>
            <div style={{ flex: 1 }} />
            <button onClick={saveCues}
              style={{ ...s.btn, borderColor: "#6BCB77", color: "#6BCB77" }}
              title="Save cue list to browser storage">
              💾 Save
            </button>
            <button onClick={loadCues}
              style={{ ...s.btn, borderColor: "#6BCB77", color: "#6BCB77" }}
              title="Load previously saved cue list">
              📂 Load
            </button>
            <button
              onClick={() => { const prev = activeCueIdx - 1; if (prev >= 0) goTo(prev); }}
              disabled={activeCueIdx <= 0}
              style={{ ...s.btn, opacity: activeCueIdx <= 0 ? 0.4 : 1 }}>
              ◀ Back
            </button>
            <button
              onClick={() => { const next = activeCueIdx + 1; if (next < cues.length) goTo(next); else if (cues.length > 0) goTo(0); }}
              disabled={cues.length === 0}
              style={{ ...s.btn, borderColor: "#E9C46A", color: "#E9C46A", opacity: cues.length === 0 ? 0.4 : 1 }}>
              Go ▶
            </button>
            <button
              onClick={() => setSequencerAuto((v) => !v)}
              style={{ ...s.btn, borderColor: sequencerAuto ? "#6BCB77" : "#3d4555", color: sequencerAuto ? "#6BCB77" : "#8b949e", background: sequencerAuto ? "#6BCB7722" : "none" }}>
              {sequencerAuto ? "⏸ Auto" : "▷ Auto"}
            </button>
            <button
              onClick={() => setSequencerLoop((v) => !v)}
              style={{ ...s.btn, borderColor: sequencerLoop ? "#6BCB77" : "#3d4555", color: sequencerLoop ? "#6BCB77" : "#8b949e", background: sequencerLoop ? "#6BCB7722" : "none" }}
              title="Loop back to cue 1 after the last cue">
              ↺ Loop
            </button>
          </div>

          {/* Empty state */}
          {cues.length === 0 && (
            <div style={{ color: "#556677", fontSize: 11, textAlign: "center", padding: "8px 0" }}>
              No cues — click ⊕ Add cue to capture the current animation state
            </div>
          )}

          {/* Cue rows */}
          {cues.map((cue, idx) => {
            const isActive = idx === activeCueIdx;
            const anims = [];
            if (cue.rotate)  anims.push(`↻ ${cue.rotateSpeed}°/s`);
            if (cue.zoom)    anims.push(`⇱ ±${cue.zoomAmp}`);
            if (cue.zoomIn)  anims.push(`⊕ ${cue.zoomInFactor}× ${cue.zoomInDuration/1000}s`);
            if (cue.zoomOut) anims.push(`⊖ ${cue.zoomOutFactor}× ${cue.zoomOutDuration/1000}s`);
            if (cue.tilt)    anims.push(`⟂ ±${cue.tiltAmp}°`);
            if (cue.sweep)   anims.push(`↓ ${cue.sweepTarget}° ${cue.sweepDuration/1000}s`);
            if (cue.flyover) anims.push(`→ ${cue.flyoverSpeed}m/s`);
            if (!anims.length) anims.push("—");
            return (
              <div key={cue.id} onClick={() => goTo(idx)} style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "4px 8px", borderRadius: 5, cursor: "pointer",
                background: isActive ? "#E9C46A18" : "transparent",
                border: `1px solid ${isActive ? "#E9C46A55" : "transparent"}`,
                marginBottom: 3,
              }}>
                {/* Cue number */}
                <span style={{ fontSize: 11, color: isActive ? "#E9C46A" : "#556677", minWidth: 18, textAlign: "right" }}>
                  {idx + 1}
                </span>
                {/* Label — editable */}
                <input
                  value={cue.label}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, label: e.target.value } : c))}
                  style={{ ...s.numInput, width: 76, background: "transparent", border: "1px solid transparent" }}
                  onFocus={(e) => { e.target.style.borderColor = "#3d4555"; }}
                  onBlur={(e) => { e.target.style.borderColor = "transparent"; }}
                />
                {/* Animation summary */}
                <span style={{ flex: 1, fontSize: 10, color: "#8b949e", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  {anims.join("  ")}
                </span>
                {/* Fade time */}
                <span style={{ fontSize: 10, color: "#556677" }}>fade</span>
                <input
                  type="number" min={0} step={0.5}
                  value={cue.fade ?? 0}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, fade: Math.max(0, Number(e.target.value)) } : c))}
                  style={{ ...s.numInput, width: 38 }}
                />
                <span style={{ fontSize: 10, color: "#556677" }}>s</span>
                {/* Hold time */}
                <span style={{ fontSize: 10, color: "#556677", marginLeft: 3 }}>hold</span>
                <input
                  type="number" min={0}
                  value={cue.hold}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, hold: Math.max(0, Number(e.target.value)) } : c))}
                  style={{ ...s.numInput, width: 38 }}
                />
                <span style={{ fontSize: 10, color: "#556677" }}>s</span>
                {/* Reorder */}
                <button
                  disabled={idx === 0}
                  onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = [...prev]; [a[idx-1], a[idx]] = [a[idx], a[idx-1]]; if (activeCueIdx === idx) setActiveCueIdx(idx-1); else if (activeCueIdx === idx-1) setActiveCueIdx(idx); return a; }); }}
                  style={{ ...s.btn, padding: "1px 5px", opacity: idx === 0 ? 0.3 : 1 }}>↑</button>
                <button
                  disabled={idx === cues.length - 1}
                  onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = [...prev]; [a[idx], a[idx+1]] = [a[idx+1], a[idx]]; if (activeCueIdx === idx) setActiveCueIdx(idx+1); else if (activeCueIdx === idx+1) setActiveCueIdx(idx); return a; }); }}
                  style={{ ...s.btn, padding: "1px 5px", opacity: idx === cues.length-1 ? 0.3 : 1 }}>↓</button>
                {/* Delete */}
                <button
                  onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = prev.filter((_, i) => i !== idx); if (activeCueIdx >= a.length) setActiveCueIdx(a.length - 1); return a; }); }}
                  style={{ ...s.btn, padding: "1px 6px", borderColor: "#f85149", color: "#f85149" }}>✕</button>
              </div>
            );
          })}
        </div>
      )}

      {!presentMode && <div style={{ fontSize: 11, color: "#556677" }}>
        Pre-calculated summer degree-hours per sensor.
        {activeCutoff !== null && ` Outlier filter active: hiding sensors above ${activeCutoff} — color scale recalculated from remaining data.`}
        {selectedFields.length > 1 && " Multiple fields shown side-by-side (offset East)."}
      </div>}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────
const styles = {
  controlBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    padding: "8px 12px",
    background: "#161b22",
    border: "1px solid #2e3440",
    borderRadius: 8,
  },
  controlGroup: {
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  label: {
    fontSize: 10,
    color: "#8b949e",
    whiteSpace: "nowrap",
  },
  sep: {
    width: 1,
    height: 20,
    background: "#2e3440",
    flexShrink: 0,
  },
  btn: {
    background: "none",
    border: "1px solid #3d4555",
    borderRadius: 5,
    color: "#8b949e",
    cursor: "pointer",
    fontSize: 11,
    padding: "3px 9px",
    fontFamily: "monospace",
    lineHeight: 1.4,
  },
  toggleBtn: {
    transition: "color 1s ease, border-color 1s ease, background 1s ease",
  },
  select: {
    background: "#161b22",
    border: "1px solid #3d4555",
    borderRadius: 5,
    color: "#c9d1d9",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 11,
    padding: "3px 8px",
    outline: "none",
  },
  numInput: {
    background: "#1a1f2e",
    border: "1px solid #3d4555",
    borderRadius: 4,
    color: "#c9d1d9",
    fontFamily: "monospace",
    fontSize: 11,
    padding: "2px 6px",
    outline: "none",
    width: 60,
  },
  overlay: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%,-50%)",
    background: "rgba(22,27,34,0.88)",
    backdropFilter: "blur(6px)",
    border: "1px solid #3d4555",
    borderRadius: 8,
    padding: "12px 24px",
    fontFamily: "monospace",
    fontSize: 13,
    color: "#c9d1d9",
    zIndex: 10,
    pointerEvents: "none",
  },
  presentBtn: {
    background: "rgba(22,27,34,0.85)",
    backdropFilter: "blur(4px)",
    border: "1px solid #556677",
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 11,
    padding: "4px 10px",
  },
  sequencerPanel: {
    background: "#161b22",
    border: "1px solid #2e3440",
    borderRadius: 8,
    padding: "10px 12px",
    fontFamily: "monospace",
    maxHeight: 280,
    overflowY: "auto",
  },
  legend: {
    position: "absolute",
    bottom: 28,
    left: 12,
    zIndex: 5,
    background: "rgba(22,27,34,0.88)",
    backdropFilter: "blur(4px)",
    border: "1px solid #2e3440",
    borderRadius: 10,
    padding: "12px 18px",
    fontFamily: "monospace",
    pointerEvents: "none",
    fontSize: 15,
  },
};
