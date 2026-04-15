import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { ColumnLayer, GeoJsonLayer } from "@deck.gl/layers";
import { WebMercatorViewport } from "@deck.gl/core";
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
  "Kh above 26°C": { label: "Gradtimmar över 26°C", group: "threshold", unit: "°h" },
  "Kh above 27°C": { label: "Gradtimmar över 27°C", group: "threshold", unit: "°h" },
  "Kh above 28°C": { label: "Gradtimmar över 28°C", group: "threshold", unit: "°h" },
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
  const [buildingWireframe, setBuildingWireframe] = useState(false);

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
  const [isTransitioning, setIsTransitioning] = useState(false);
  // Live refs so applyCue can read current values without being in the dep array
  const isRotatingRef  = useRef(isRotating);
  const isTiltingRef   = useRef(isTilting);
  const isSweepingRef  = useRef(isSweeping);
  const isFlyoverRef   = useRef(isFlyover);
  const viewStateRef   = useRef(viewState);
  isRotatingRef.current = isRotating;
  isTiltingRef.current  = isTilting;
  isSweepingRef.current = isSweeping;
  isFlyoverRef.current  = isFlyover;
  viewStateRef.current  = viewState;

  const animFrameRef      = useRef(null);
  const lastTimeRef       = useRef(null);
  const elapsedRef        = useRef(0);
  const zoomBaseRef       = useRef(null);
  const pitchBaseRef      = useRef(null);
  const sweepElapsed      = useRef(0);
  const zoomInStart       = useRef(null);
  const zoomInElapsed     = useRef(0);
  const zoomOutStart      = useRef(null);
  const zoomOutElapsed    = useRef(0);
  // Manual RAF-based cue transition (replaces deck.gl transitionInterpolator)
  // { from:{lon,lat,zoom,pitch,bearing}, to:{…}, durMs, elapsed }
  const cueTransitionRef  = useRef(null);

  // ── Sequencer ──
  const [cues, setCues]                   = useState([]);
  const [activeCueIdx, setActiveCueIdx]   = useState(-1);
  const [sequencerAuto, setSequencerAuto] = useState(false);
  const [sequencerLoop, setSequencerLoop] = useState(false);
  const [showSequencer, setShowSequencer] = useState(false);
  const [presentMode, setPresentMode]     = useState(false);
  const [widescreen, setWidescreen]       = useState(false);
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
  const isAnimating = isRotating || isZooming || isTilting || isSweeping || isFlyover || isZoomIn || isZoomOut || isTransitioning;
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

    // Smoothstep easing for cue transitions
    const ease = (t) => t * t * (3 - 2 * t);
    // Shortest-path bearing lerp
    const lerpBear = (a, b, t) => a + (((b - a + 540) % 360) - 180) * t;

    const step = (timestamp) => {
      if (lastTimeRef.current !== null) {
        const dt = timestamp - lastTimeRef.current;
        elapsedRef.current += dt;
        if (isSweeping) sweepElapsed.current  += dt;
        if (isZoomIn)   zoomInElapsed.current  += dt;
        if (isZoomOut)  zoomOutElapsed.current += dt;

        // Advance cue transition outside the functional update (side-effect is fine for a ref)
        const tr = cueTransitionRef.current;
        let trT = 1;
        if (tr) {
          tr.elapsed += dt;
          trT = Math.min(1, tr.elapsed / tr.durMs);
        }
        const trDone = tr && trT >= 1;

        let sweepDone = false;
        let zoomInDone = false;
        let zoomOutDone = false;

        setViewState((vs) => {
          // ── Cue transition: lerp axes that aren't animation-controlled ──
          let base = vs;
          if (tr) {
            const e = ease(trT);
            base = {
              ...vs,
              // Position always transitions (even with flyover, inherited target = current pos)
              longitude: tr.from.longitude + (tr.to.longitude - tr.from.longitude) * e,
              latitude:  tr.from.latitude  + (tr.to.latitude  - tr.from.latitude)  * e,
              // Only lerp zoom/pitch/bearing when no animation owns that axis
              ...(!isZooming && !isZoomIn && !isZoomOut
                ? { zoom: tr.from.zoom + (tr.to.zoom - tr.from.zoom) * e } : {}),
              ...(!isTilting && !isSweeping
                ? { pitch: tr.from.pitch + (tr.to.pitch - tr.from.pitch) * e } : {}),
              ...(!isRotating
                ? { bearing: lerpBear(tr.from.bearing, tr.to.bearing, e) } : {}),
            };
          }

          // ── Capture base values on first frame of each animation ──
          if (isZooming  && zoomBaseRef.current  === null) zoomBaseRef.current  = base.zoom;
          if (isZoomIn   && zoomInStart.current  === null) zoomInStart.current  = base.zoom;
          if (isZoomOut  && zoomOutStart.current === null) zoomOutStart.current = base.zoom;
          if (isTilting  && pitchBaseRef.current === null) pitchBaseRef.current = base.pitch;
          if (isSweeping && pitchBaseRef.current === null) pitchBaseRef.current = base.pitch;

          // ── Rotation ──
          const bearing = isRotating
            ? (base.bearing + rotateSpeed * (dt / 1000)) % 360
            : base.bearing;

          // ── Zoom ──
          let zoom = base.zoom;
          if (isZooming) {
            zoom = (zoomBaseRef.current ?? base.zoom) +
              zoomAmp * Math.sin((2 * Math.PI * elapsedRef.current) / ZOOM_PERIOD_MS);
          } else if (isZoomIn) {
            const t = Math.min(1, zoomInElapsed.current / zoomInDuration);
            zoom = (zoomInStart.current ?? base.zoom) + Math.log2(zoomInFactor) * t;
            if (t >= 1) zoomInDone = true;
          } else if (isZoomOut) {
            const t = Math.min(1, zoomOutElapsed.current / zoomOutDuration);
            zoom = (zoomOutStart.current ?? base.zoom) - Math.log2(zoomOutFactor) * t;
            if (t >= 1) zoomOutDone = true;
          }

          // ── Tilt / Sweep ──
          let pitch = base.pitch;
          if (isTilting) {
            pitch = Math.max(0, Math.min(80,
              (pitchBaseRef.current ?? base.pitch) +
              tiltAmp * Math.sin((2 * Math.PI * elapsedRef.current) / TILT_PERIOD_MS)
            ));
          } else if (isSweeping) {
            const t = Math.min(1, sweepElapsed.current / sweepDuration);
            const start = pitchBaseRef.current ?? base.pitch;
            pitch = start + (sweepTarget - start) * t;
            if (t >= 1) sweepDone = true;
          }

          // ── Flyover ──
          let longitude = base.longitude;
          let latitude  = base.latitude;
          if (isFlyover) {
            const bearingRad = (base.bearing * Math.PI) / 180;
            const distMetres = flyoverSpeed * (dt / 1000);
            longitude += distMetres * LON_PER_M * Math.sin(bearingRad);
            latitude  += distMetres * LAT_PER_M * Math.cos(bearingRad);
          }

          return { ...base, bearing, zoom, pitch, longitude, latitude };
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
        if (trDone) {
          cueTransitionRef.current = null;
          setIsTransitioning(false);
        }
      }
      lastTimeRef.current = timestamp;
      animFrameRef.current = requestAnimationFrame(step);
    };
    animFrameRef.current = requestAnimationFrame(step);
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, [isAnimating, isRotating, isZooming, isTilting, isSweeping, isFlyover, isZoomIn, isZoomOut, isTransitioning,
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
    view: { longitude: viewState.longitude, latitude: viewState.latitude,
             zoom: viewState.zoom, pitch: viewState.pitch, bearing: viewState.bearing },
  }), [isRotating, rotateSpeed, isZooming, zoomAmp,
       isZoomIn, zoomInFactor, zoomInDuration,
       isZoomOut, zoomOutFactor, zoomOutDuration,
       isTilting, tiltAmp, isSweeping, sweepTarget, sweepDuration,
       isFlyover, flyoverSpeed, viewState]);

  const applyCue = useCallback((cue) => {
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);

    // Reset one-way animation refs so they capture a fresh start value
    zoomInStart.current = null;   zoomInElapsed.current = 0;
    zoomOutStart.current = null;  zoomOutElapsed.current = 0;
    pitchBaseRef.current = null;  sweepElapsed.current = 0;

    // Read live values from refs (keeps applyCue stable — no viewState in dep array)
    const vs       = viewStateRef.current;
    const rotating = isRotatingRef.current;
    const tilting  = isTiltingRef.current;
    const sweeping = isSweepingRef.current;
    const flyover  = isFlyoverRef.current;

    const fadeMs = (cue.fade ?? 0) * 1000;

    if (cue.view && fadeMs > 0) {
      const to = {
        ...cue.view,
        ...(rotating           ? { bearing:   vs.bearing   } : {}),
        ...(tilting || sweeping ? { pitch:    vs.pitch     } : {}),
        ...(flyover            ? { longitude: vs.longitude,
                                   latitude:  vs.latitude  } : {}),
      };
      cueTransitionRef.current = {
        from: {
          longitude: vs.longitude, latitude: vs.latitude,
          zoom: vs.zoom, pitch: vs.pitch, bearing: vs.bearing,
        },
        to,
        durMs: fadeMs,
        elapsed: 0,
      };
      setIsTransitioning(true);
    } else if (cue.view) {
      setViewState((s) => ({ ...s, ...cue.view }));
    }

    // Start animations immediately (run concurrently with the transition)
    setIsRotating(cue.rotate);      setRotateSpeed(cue.rotateSpeed);
    setIsZooming(cue.zoom);         setZoomAmp(cue.zoomAmp);
    setIsZoomIn(cue.zoomIn);        setZoomInFactor(cue.zoomInFactor);   setZoomInDuration(cue.zoomInDuration);
    setIsZoomOut(cue.zoomOut);      setZoomOutFactor(cue.zoomOutFactor); setZoomOutDuration(cue.zoomOutDuration);
    setIsTilting(cue.tilt);         setTiltAmp(cue.tiltAmp);
    setIsSweeping(cue.sweep);       setSweepTarget(cue.sweepTarget);     setSweepDuration(cue.sweepDuration);
    setIsFlyover(cue.flyover);      setFlyoverSpeed(cue.flyoverSpeed);
  }, []); // stable — reads live state from refs, not closure

  const updateCue = useCallback(() => {
    if (activeCueIdx < 0) return;
    const snapshot = captureState();
    setCues((prev) => prev.map((c, i) => i === activeCueIdx
      ? { ...snapshot, id: c.id, label: c.label, hold: c.hold, fade: c.fade }
      : c
    ));
  }, [activeCueIdx, captureState]);

  const mergeView = useCallback(() => {
    if (activeCueIdx < 0) return;
    const vs = viewStateRef.current;
    setCues((prev) => prev.map((c, i) => i === activeCueIdx
      ? { ...c, view: { longitude: vs.longitude, latitude: vs.latitude, zoom: vs.zoom, pitch: vs.pitch, bearing: vs.bearing } }
      : c
    ));
  }, [activeCueIdx]);

  const [cueMsg, setCueMsg] = useState('');
  const _flashMsg = (msg) => { setCueMsg(msg); setTimeout(() => setCueMsg(''), 2500); };

  const saveCues = useCallback(() => {
    try {
      const toSave = cues.map((c) => ({
        ...c,
        view: c.view ? {
          longitude: c.view.longitude, latitude: c.view.latitude,
          zoom: c.view.zoom, pitch: c.view.pitch, bearing: c.view.bearing,
        } : undefined,
      }));
      const blob = new Blob([JSON.stringify(toSave, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dh-cues-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      _flashMsg(`✓ Saved ${cues.length} cue${cues.length !== 1 ? 's' : ''}`);
    } catch (e) { console.error("Save failed", e); _flashMsg('✗ Save failed'); }
  }, [cues]);

  const loadCues = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = JSON.parse(ev.target.result);
          setCues(parsed);
          setActiveCueIdx(-1);
          setShowSequencer(true);
          _flashMsg(`✓ Loaded ${parsed.length} cue${parsed.length !== 1 ? 's' : ''} from ${file.name}`);
        } catch (err) {
          console.error("Load failed", err);
          _flashMsg('✗ Invalid file');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  const addCue = useCallback(() => {
    setCues((prev) => {
      const n = prev.length + 1;
      return [...prev, { ...captureState(), label: `Cue ${n}` }];
    });
    setShowSequencer(true);
  }, [captureState]);

  const cuesRef = useRef(cues);
  cuesRef.current = cues;

  const goTo = useCallback((idx) => {
    const current = cuesRef.current;
    if (idx < 0 || idx >= current.length) return;
    applyCue(current[idx]);
    setActiveCueIdx(idx);
  }, [applyCue]);

  // Auto-advance hold timer
  useEffect(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (!sequencerAuto || activeCueIdx < 0) return;
    const cue = cues[activeCueIdx];
    if (!cue || cue.hold == null) return;
    const totalMs = ((cue.fade ?? 0) + cue.hold) * 1000;
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
    }, totalMs);
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
          filled: !buildingWireframe,
          stroked: buildingWireframe,
          extruded: true,
          wireframe: buildingWireframe,
          getElevation: (f) => f.properties?.height ?? 10,
          getFillColor: buildingWireframe ? [80, 110, 160, 0] : [55, 75, 110, 130],
          getLineColor: [100, 140, 220, 180],
          lineWidthMinPixels: buildingWireframe ? 1 : 0,
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

            let lat, lon;
            if (explodedView && sp?.spread_lat != null) {
              lat = sp.spread_lat;
              lon = sp.spread_lon;
            } else {
              lat = (useParquetCoords && h?.lat != null) ? h.lat : d.lat;
              lon = (useParquetCoords && h?.lon != null) ? h.lon : d.lon;
            }

            // Lean outward from building centroid by floor × leanScale, clamped to boundary
            if (explodedView && leanScale > 0 && h?.lm_building_id) {
              const cent = buildingCentroids[h.lm_building_id];
              const floor = h.floor ?? 0;
              if (cent && floor > 0) {
                const dLat = lat - cent.lat;
                const dLon = lon - cent.lon;
                const dist = Math.sqrt(dLat * dLat + dLon * dLon);
                const maxM = sp?.lean_max_m ?? 0;
                if (maxM <= 0) return [lon + lonOffset, lat]; // no polygon data — skip lean
                const offsetM = Math.min(floor * leanScale, maxM);
                if (dist > 1e-9) {
                  lat += (dLat / dist) * offsetM * LAT_PER_M;
                  lon += (dLon / dist) * offsetM * LON_PER_M;
                } else {
                  lat += offsetM * LAT_PER_M;
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
            getPosition:  [useParquetCoords, pointHeights, lonOffset, explodedView, spreadPositions, leanScale, buildingCentroids],
            getElevation: [baseH, heightScale],
            getFillColor: [maxValue],
          },
        })
      );
    });

    return ls;
  }, [
    showBuildings, buildingWireframe, buildings3D,
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
    <div style={{ display: "flex", flexDirection: "column", gap: 10, ...(presentMode ? { paddingBottom: 40 } : { height: "calc(100vh - 220px)", minHeight: 520 }) }}>
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
        {showBuildings && (
          <button
            onClick={() => setBuildingWireframe((v) => !v)}
            title="Toggle building wireframe / solid"
            style={{
              ...s.btn,
              borderColor: buildingWireframe ? "#88AADD" : "#3d4555",
              color: buildingWireframe ? "#88AADD" : "#8b949e",
              background: buildingWireframe ? "#88AADD22" : "none",
            }}
          >
            ⬡ Wire
          </button>
        )}

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
        <button onClick={mergeView}
          disabled={activeCueIdx < 0}
          style={{ ...s.btn, borderColor: activeCueIdx >= 0 ? "#4CC9F0" : "#3d4555", color: activeCueIdx >= 0 ? "#4CC9F0" : "#556677", opacity: activeCueIdx < 0 ? 0.5 : 1 }}
          title="Merge current viewport into the active cue, keeping all animation settings">
          ⤵ Merge view
        </button>

        <div style={s.sep} />

        <button onClick={() => setWidescreen((w) => !w)}
          style={{ ...s.btn, borderColor: widescreen ? "#C8B6FF" : "#3d4555", color: widescreen ? "#C8B6FF" : "#8b949e", background: widescreen ? "#C8B6FF22" : "none" }}
          title="Toggle 16:9 map aspect ratio">
          ▬ 16:9
        </button>
        <button onClick={() => setPresentMode(true)}
          style={{ ...s.btn, borderColor: "#C8B6FF", color: "#C8B6FF" }}
          title="Hide controls for screen recording">
          ⛶ Present
        </button>
      </div>}

      {/* ── Present mode controls bar ── */}
      {presentMode && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            onClick={() => { const prev = activeCueIdx - 1; if (prev >= 0) goTo(prev); }}
            disabled={activeCueIdx <= 0}
            style={{ ...s.presentBtn, opacity: activeCueIdx <= 0 ? 0.4 : 1 }}>
            ◀ Back
          </button>
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
            onClick={() => { setIsRotating(false); setIsZooming(false); setIsZoomIn(false); setIsZoomOut(false); setIsTilting(false); setIsSweeping(false); setIsFlyover(false); cueTransitionRef.current = null; setIsTransitioning(false); }}
            style={{ ...s.presentBtn, borderColor: "#f85149", color: "#f85149" }}>
            ⏹ Pause
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => goTo(0)}
            disabled={cues.length === 0}
            style={{ ...s.presentBtn, borderColor: "#8b949e", color: "#8b949e", opacity: cues.length === 0 ? 0.4 : 1 }}>
            ⏮ Reset
          </button>
          <button
            onClick={() => { goTo(0); setSequencerAuto(true); }}
            disabled={cues.length === 0}
            style={{ ...s.presentBtn, borderColor: "#4CC9F0", color: "#4CC9F0", opacity: cues.length === 0 ? 0.4 : 1 }}>
            ↺ Replay
          </button>
          <button
            onClick={() => setPresentMode(false)}
            style={{ ...s.presentBtn, borderColor: "#C8B6FF", color: "#C8B6FF" }}>
            ✕ Exit
          </button>
        </div>
      )}

      {/* ── Map (+ side sequencer in 16:9 mode) ── */}
      <div style={widescreen && !presentMode && showSequencer
        ? { display: "flex", flexDirection: "row", gap: 10, alignItems: "flex-start" }
        : {}}>
      <div style={widescreen
        ? { position: "relative", flexShrink: 0, width: presentMode ? "calc(85vh * 16 / 9)" : "calc(55vh * 16 / 9)", aspectRatio: "16/9", borderRadius: 8, overflow: "hidden", border: "1px solid #2e3440" }
        : { position: "relative", flex: 1, minHeight: 300, borderRadius: 8, overflow: "hidden", border: "1px solid #2e3440" }}>
        <DeckGL
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          controller={{ maxPitch: 85 }}
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
            {selectedFields.length === 1 && (
              <div style={{ fontSize: 13, color: "#8b949e", marginBottom: 6 }}>
                {FIELD_META[selectedFields[0]]?.label ?? selectedFields[0]}
              </div>
            )}
            {/* Color bar */}
            <div style={{
              width: 210, height: 14, borderRadius: 4,
              background: `linear-gradient(to right, ${DH_COLOR_STOPS.map((c) => `rgb(${c.join(",")})`).join(",")})`,
            }} />
            <div style={{ display: "flex", justifyContent: "space-between", width: 210, marginTop: 3, fontSize: 13, color: "#8b949e" }}>
              <span>0 °h</span>
              <span>{Math.round(maxValue / 2).toLocaleString()} °h</span>
              <span>{Math.round(maxValue).toLocaleString()} °h</span>
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

      </div>{/* ── end map container ── */}

      {/* ── Sequencer Panel — right of map in 16:9 mode ── */}
      {!presentMode && showSequencer && widescreen && (
        <div style={{ ...s.sequencerPanel, flex: 1, minWidth: 280, maxWidth: 420, alignSelf: "stretch", overflowY: "auto", maxHeight: "55vh" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5, marginBottom: 8, borderBottom: "1px solid #2e3440", paddingBottom: 8 }}>
            <span style={{ fontSize: 12, color: "#E9C46A", fontWeight: 700, marginRight: "auto" }}>⬡ Cue List</span>
            {cueMsg && <span style={{ fontSize: 10, color: "#6BCB77", fontFamily: "monospace", width: "100%" }}>{cueMsg}</span>}
            <button onClick={saveCues} style={{ ...s.btn, borderColor: "#6BCB77", color: "#6BCB77" }}>💾</button>
            <button onClick={loadCues} style={{ ...s.btn, borderColor: "#6BCB77", color: "#6BCB77" }}>📂</button>
            <button onClick={() => { const prev = activeCueIdx - 1; if (prev >= 0) goTo(prev); }} disabled={activeCueIdx <= 0} style={{ ...s.btn, opacity: activeCueIdx <= 0 ? 0.4 : 1 }}>◀</button>
            <button onClick={() => { const next = activeCueIdx + 1; if (next < cues.length) goTo(next); else if (cues.length > 0) goTo(0); }} disabled={cues.length === 0} style={{ ...s.btn, borderColor: "#E9C46A", color: "#E9C46A", opacity: cues.length === 0 ? 0.4 : 1 }}>Go ▶</button>
            <button onClick={() => setSequencerAuto((v) => !v)} style={{ ...s.btn, borderColor: sequencerAuto ? "#6BCB77" : "#3d4555", color: sequencerAuto ? "#6BCB77" : "#8b949e", background: sequencerAuto ? "#6BCB7722" : "none" }}>{sequencerAuto ? "⏸" : "▷"}</button>
            <button onClick={() => setSequencerLoop((v) => !v)} style={{ ...s.btn, borderColor: sequencerLoop ? "#6BCB77" : "#3d4555", color: sequencerLoop ? "#6BCB77" : "#8b949e", background: sequencerLoop ? "#6BCB7722" : "none" }}>↺</button>
          </div>
          {cues.length === 0 && <div style={{ color: "#556677", fontSize: 11, textAlign: "center", padding: "8px 0" }}>No cues yet</div>}
          {cues.map((cue, idx) => {
            const isActive = idx === activeCueIdx;
            const anims = [];
            if (cue.rotate)  anims.push(`↻ ${cue.rotateSpeed}°/s`);
            if (cue.zoom)    anims.push(`⇱ ±${cue.zoomAmp}`);
            if (cue.zoomIn)  anims.push(`⊕ ${cue.zoomInFactor}×`);
            if (cue.zoomOut) anims.push(`⊖ ${cue.zoomOutFactor}×`);
            if (cue.tilt)    anims.push(`⟂ ±${cue.tiltAmp}°`);
            if (cue.sweep)   anims.push(`↓ ${cue.sweepTarget}°`);
            if (cue.flyover) anims.push(`→ ${cue.flyoverSpeed}m/s`);
            if (!anims.length) anims.push("—");
            return (
              <div key={cue.id} onClick={() => goTo(idx)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 6px", borderRadius: 5, cursor: "pointer", background: isActive ? "#E9C46A18" : "transparent", border: `1px solid ${isActive ? "#E9C46A55" : "transparent"}`, marginBottom: 3 }}>
                <span style={{ fontSize: 11, color: isActive ? "#E9C46A" : "#556677", minWidth: 16, textAlign: "right" }}>{idx + 1}</span>
                <input value={cue.label} onClick={(e) => e.stopPropagation()} onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, label: e.target.value } : c))} style={{ ...s.numInput, flex: 1, background: "transparent", border: "1px solid transparent" }} onFocus={(e) => { e.target.style.borderColor = "#3d4555"; }} onBlur={(e) => { e.target.style.borderColor = "transparent"; }} />
                <span style={{ fontSize: 10, color: "#8b949e", whiteSpace: "nowrap" }}>{anims.join(" ")}</span>
                <span style={{ fontSize: 10, color: "#556677" }}>f</span>
                <input type="number" min={0} step={0.5} value={cue.fade ?? 0} onClick={(e) => e.stopPropagation()} onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, fade: Math.max(0, Number(e.target.value)) } : c))} style={{ ...s.numInput, width: 32 }} />
                <span style={{ fontSize: 10, color: "#556677" }}>h</span>
                <input type="number" min={0} value={cue.hold} onClick={(e) => e.stopPropagation()} onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, hold: Math.max(0, Number(e.target.value)) } : c))} style={{ ...s.numInput, width: 32 }} />
                <button disabled={idx === 0} onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = [...prev]; [a[idx-1], a[idx]] = [a[idx], a[idx-1]]; if (activeCueIdx === idx) setActiveCueIdx(idx-1); else if (activeCueIdx === idx-1) setActiveCueIdx(idx); return a; }); }} style={{ ...s.btn, padding: "1px 4px", opacity: idx === 0 ? 0.3 : 1 }}>↑</button>
                <button disabled={idx === cues.length - 1} onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = [...prev]; [a[idx], a[idx+1]] = [a[idx+1], a[idx]]; if (activeCueIdx === idx) setActiveCueIdx(idx+1); else if (activeCueIdx === idx+1) setActiveCueIdx(idx); return a; }); }} style={{ ...s.btn, padding: "1px 4px", opacity: idx === cues.length-1 ? 0.3 : 1 }}>↓</button>
                <button onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = prev.filter((_, i) => i !== idx); if (activeCueIdx >= a.length) setActiveCueIdx(a.length - 1); return a; }); }} style={{ ...s.btn, padding: "1px 5px", borderColor: "#f85149", color: "#f85149" }}>✕</button>
              </div>
            );
          })}
        </div>
      )}
      </div>{/* ── end row wrapper ── */}

      {/* ── Sequencer Panel (normal flow, non-16:9) ── */}
      {!presentMode && showSequencer && !widescreen && (
        <div style={s.sequencerPanel}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, borderBottom: "1px solid #2e3440", paddingBottom: 8 }}>
            <span style={{ fontSize: 12, color: "#E9C46A", fontWeight: 700 }}>⬡ Cue List</span>
            <div style={{ flex: 1 }} />
            {cueMsg && <span style={{ fontSize: 10, color: "#6BCB77", fontFamily: "monospace" }}>{cueMsg}</span>}
            <button onClick={saveCues} style={{ ...s.btn, borderColor: "#6BCB77", color: "#6BCB77" }} title="Save cue list">💾 Save</button>
            <button onClick={loadCues} style={{ ...s.btn, borderColor: "#6BCB77", color: "#6BCB77" }} title="Load cue list">📂 Load</button>
            <button onClick={() => { const prev = activeCueIdx - 1; if (prev >= 0) goTo(prev); }} disabled={activeCueIdx <= 0} style={{ ...s.btn, opacity: activeCueIdx <= 0 ? 0.4 : 1 }}>◀ Back</button>
            <button onClick={() => { const next = activeCueIdx + 1; if (next < cues.length) goTo(next); else if (cues.length > 0) goTo(0); }} disabled={cues.length === 0} style={{ ...s.btn, borderColor: "#E9C46A", color: "#E9C46A", opacity: cues.length === 0 ? 0.4 : 1 }}>Go ▶</button>
            <button onClick={() => setSequencerAuto((v) => !v)} style={{ ...s.btn, borderColor: sequencerAuto ? "#6BCB77" : "#3d4555", color: sequencerAuto ? "#6BCB77" : "#8b949e", background: sequencerAuto ? "#6BCB7722" : "none" }}>{sequencerAuto ? "⏸ Auto" : "▷ Auto"}</button>
            <button onClick={() => setSequencerLoop((v) => !v)} style={{ ...s.btn, borderColor: sequencerLoop ? "#6BCB77" : "#3d4555", color: sequencerLoop ? "#6BCB77" : "#8b949e", background: sequencerLoop ? "#6BCB7722" : "none" }} title="Loop">↺ Loop</button>
          </div>
          {cues.length === 0 && <div style={{ color: "#556677", fontSize: 11, textAlign: "center", padding: "8px 0" }}>No cues — click ⊕ Add cue to capture the current animation state</div>}
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
              <div key={cue.id} onClick={() => goTo(idx)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", borderRadius: 5, cursor: "pointer", background: isActive ? "#E9C46A18" : "transparent", border: `1px solid ${isActive ? "#E9C46A55" : "transparent"}`, marginBottom: 3 }}>
                <span style={{ fontSize: 11, color: isActive ? "#E9C46A" : "#556677", minWidth: 18, textAlign: "right" }}>{idx + 1}</span>
                <input value={cue.label} onClick={(e) => e.stopPropagation()} onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, label: e.target.value } : c))} style={{ ...s.numInput, width: 76, background: "transparent", border: "1px solid transparent" }} onFocus={(e) => { e.target.style.borderColor = "#3d4555"; }} onBlur={(e) => { e.target.style.borderColor = "transparent"; }} />
                <span style={{ flex: 1, fontSize: 10, color: "#8b949e", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{anims.join("  ")}</span>
                <span style={{ fontSize: 10, color: "#556677" }}>fade</span>
                <input type="number" min={0} step={0.5} value={cue.fade ?? 0} onClick={(e) => e.stopPropagation()} onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, fade: Math.max(0, Number(e.target.value)) } : c))} style={{ ...s.numInput, width: 38 }} />
                <span style={{ fontSize: 10, color: "#556677" }}>s</span>
                <span style={{ fontSize: 10, color: "#556677", marginLeft: 3 }}>hold</span>
                <input type="number" min={0} value={cue.hold} onClick={(e) => e.stopPropagation()} onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, hold: Math.max(0, Number(e.target.value)) } : c))} style={{ ...s.numInput, width: 38 }} />
                <span style={{ fontSize: 10, color: "#556677" }}>s</span>
                <button disabled={idx === 0} onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = [...prev]; [a[idx-1], a[idx]] = [a[idx], a[idx-1]]; if (activeCueIdx === idx) setActiveCueIdx(idx-1); else if (activeCueIdx === idx-1) setActiveCueIdx(idx); return a; }); }} style={{ ...s.btn, padding: "1px 5px", opacity: idx === 0 ? 0.3 : 1 }}>↑</button>
                <button disabled={idx === cues.length - 1} onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = [...prev]; [a[idx], a[idx+1]] = [a[idx+1], a[idx]]; if (activeCueIdx === idx) setActiveCueIdx(idx+1); else if (activeCueIdx === idx+1) setActiveCueIdx(idx); return a; }); }} style={{ ...s.btn, padding: "1px 5px", opacity: idx === cues.length-1 ? 0.3 : 1 }}>↓</button>
                <button onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = prev.filter((_, i) => i !== idx); if (activeCueIdx >= a.length) setActiveCueIdx(a.length - 1); return a; }); }} style={{ ...s.btn, padding: "1px 6px", borderColor: "#f85149", color: "#f85149" }}>✕</button>
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
    top: 12,
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
