import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { ColumnLayer, GeoJsonLayer } from "@deck.gl/layers";
import { WebMercatorViewport } from "@deck.gl/core";
import Map from "react-map-gl/mapbox";
import { CommandChip, Popover, PopLabel, PopRow, PopDivider, ChipBtn, ToggleChip } from "./components/CommandStrip.jsx";


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
  "dh_2018":       { label: "2018 (>26°C)", group: "year",      unit: "°h" },
  "dh_2024":       { label: "2024 (>26°C)", group: "year",      unit: "°h" },
  "dh_2025":       { label: "2025 (>26°C)", group: "year",      unit: "°h" },
  "Kh above 26°C": { label: "2019 >26°C", group: "threshold", unit: "°h" },
  "Kh above 27°C": { label: "2019 >27°C", group: "threshold", unit: "°h" },
  "Kh above 28°C": { label: "2019 >28°C", group: "threshold", unit: "°h" },
  "tc_h":          { label: "tc_h",      group: "other",     unit: "h"   },
};

const FIELD_SHORT = {
  "dh_2018":       "2018",
  "dh_2024":       "2024",
  "dh_2025":       "2025",
  "Kh above 26°C": ">26°C",
  "Kh above 27°C": ">27°C",
  "Kh above 28°C": ">28°C",
  "tc_h":          "tc_h",
};

const FIELD_ORDER = Object.keys(FIELD_META);

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
  const [buildingView, setBuildingView]       = useState(false);
  const [buildingOutlierActive, setBuildingOutlierActive] = useState(true);
  const [buildingOutlierCutoff, setBuildingOutlierCutoff] = useState(null);
  const [buildingOutlierInput, setBuildingOutlierInput]   = useState("");

  // Parquet coordinates
  const [useParquetCoords, setUseParquetCoords] = useState(true);
  const [pointHeights, setPointHeights]         = useState({});

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
  const [openPopover, setOpenPopover]     = useState(null);
  const [presentMode, setPresentMode]     = useState(false);
  const popoverRef                        = useRef(null);
  const deckRef                           = useRef(null);
  const mapRef                            = useRef(null);
  const holdTimerRef                      = useRef(null);
  const transitionTimerRef                = useRef(null);

  // Outlier filter
  const [outlierActive, setOutlierActive]     = useState(true);
  const [outlierCutoff, setOutlierCutoff]     = useState(2000);
  const [outlierInput, setOutlierInput]       = useState("2000");
  const [scaleMax, setScaleMax]               = useState(null); // null = auto
  const [scaleMaxInput, setScaleMaxInput]     = useState("");
  const [buildingScaleMax, setBuildingScaleMax]           = useState(null);
  const [buildingScaleMaxInput, setBuildingScaleMaxInput] = useState("");

  // ── Data ──
  const [fieldCache, setFieldCache]   = useState({});
  const [loading, setLoading]         = useState(false);
  const [buildings3D, setBuildings3D] = useState(null);

  // ── One-time fetches ──
  useEffect(() => {
    fetchJson(`${API}/api/dh-fields`)
      .then((fields) => {
        setAvailableFields(fields);
        const preferred = fields.find((f) => f.field === "dh_2025")
          ?? fields.find((f) => f.field === "dh_2024")
          ?? fields.find((f) => f.field === "dh_2018")
          ?? fields[0];
        if (preferred) setSelectedFields([preferred.field]);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    fetchJson(`${API}/api/point-heights`).then(setPointHeights).catch(() => {});
  }, []);

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
          setOpenPopover("rig");
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
    setOpenPopover("rig");
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

  const applyScaleMaxInput = () => {
    const v = parseFloat(scaleMaxInput);
    if (!isNaN(v) && v > 0) setScaleMax(v); else { setScaleMax(null); setScaleMaxInput(""); }
  };
  const applyBuildingScaleMaxInput = () => {
    const v = parseFloat(buildingScaleMaxInput);
    if (!isNaN(v) && v > 0) setBuildingScaleMax(v); else { setBuildingScaleMax(null); setBuildingScaleMaxInput(""); }
  };

  // ── Effective cutoff (null = no filtering) ──
  const activeCutoff = outlierActive && outlierCutoff != null ? outlierCutoff : null;

  // ── Global max across ALL loaded sensor data — fixed scale for year comparison ──
  const globalMaxValue = useMemo(() => {
    let max = 0;
    Object.values(fieldCache).forEach((data) => {
      if (data) data.forEach((d) => {
        const v = d.value;
        if (activeCutoff !== null && v > activeCutoff) return;
        if (v > max) max = v;
      });
    });
    return max || 1;
  }, [fieldCache, activeCutoff]);

  // ── Global max across ALL loaded building averages — fixed scale for building view ──
  const globalBuildingMaxValue = useMemo(() => {
    let max = 0;
    Object.values(fieldCache).forEach((data) => {
      if (!data?.length) return;
      const groups = {};
      data.forEach((d) => {
        const bid = d.lm_building_id;
        if (!bid) return;
        if (!groups[bid]) groups[bid] = [];
        groups[bid].push(d.value);
      });
      Object.values(groups).forEach((vals) => {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        if (avg > max) max = avg;
      });
    });
    return max || 1;
  }, [fieldCache]);

  // User override or auto global max
  const effectiveSensorMax   = scaleMax          ?? globalMaxValue;
  const effectiveBuildingMax = buildingScaleMax   ?? globalBuildingMaxValue;

  // ── Max value for color/height scale (respects outlier filter) ──
  const maxValue = useMemo(() => {
    let max = 0;
    selectedFields.forEach((f) => {
      const data = fieldCache[f];
      if (data) {
        data.forEach((d) => {
          const v = d.value;
          if (activeCutoff !== null && v > activeCutoff) return;
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

  // Per-building mean DH value (outlier filter applied)
  const buildingDhValues = useMemo(() => {
    if (!buildingView) return {};
    const groups = {};
    selectedFields.forEach((field) => {
      const data = fieldCache[field];
      if (!data?.length) return;
      data.forEach((d) => {
        const v = d.value;
        if (activeCutoff !== null && v > activeCutoff) return;
        const bid = d.lm_building_id;
        if (!bid) return;
        if (!groups[bid]) groups[bid] = [];
        groups[bid].push(v);
      });
    });
    const result = {};
    Object.entries(groups).forEach(([bid, vals]) => {
      result[bid] = vals.reduce((a, b) => a + b, 0) / vals.length;
    });
    return result;
  }, [buildingView, selectedFields, fieldCache, activeCutoff]);

  const activeBuildingCutoff = buildingView && buildingOutlierActive && buildingOutlierCutoff != null
    ? buildingOutlierCutoff : null;

  const buildingMaxValue = useMemo(() => {
    const vals = Object.values(buildingDhValues).filter(
      (v) => activeBuildingCutoff === null || v <= activeBuildingCutoff
    );
    return vals.length ? Math.max(...vals) : 1;
  }, [buildingDhValues, activeBuildingCutoff]);

  const buildingOutlierCount = useMemo(() => {
    if (activeBuildingCutoff === null) return 0;
    return Object.values(buildingDhValues).filter((v) => v > activeBuildingCutoff).length;
  }, [buildingDhValues, activeBuildingCutoff]);

  // Auto-suggest building cutoff at 99th percentile when building values arrive
  useEffect(() => {
    if (buildingOutlierCutoff !== null) return;
    const vals = Object.values(buildingDhValues);
    if (!vals.length) return;
    const sorted = [...vals].sort((a, b) => a - b);
    const suggested = Math.ceil(percentile(sorted, 99));
    setBuildingOutlierCutoff(suggested);
    setBuildingOutlierInput(String(suggested));
  }, [buildingDhValues]);

  const applyBuildingOutlierInput = () => {
    const v = parseFloat(buildingOutlierInput);
    if (!isNaN(v) && v > 0) setBuildingOutlierCutoff(v);
  };

  // Auto-scale: max column ≈ 40 m
  const baseH = maxValue > 0 ? 40 / maxValue : 1;

  // ── Layers ──
  const layers = useMemo(() => {
    const ls = [];

    if (buildingView && buildings3D?.features?.length) {
      ls.push(
        new GeoJsonLayer({
          id: "dh-buildings-view",
          data: buildings3D,
          filled: true,
          stroked: false,
          extruded: true,
          wireframe: false,
          getElevation: (f) => f.properties?.height ?? 10,
          getFillColor: (f) => {
            const bid = f.properties?.lm_building_id;
            const val = buildingDhValues[bid];
            if (val == null) return [45, 60, 90, 70];
            if (activeBuildingCutoff !== null && val > activeBuildingCutoff) return [45, 60, 90, 40];
            return [...dhToColor(val, effectiveBuildingMax), 230];
          },
          getLineColor: [0, 0, 0, 0],
          lineWidthMinPixels: 0,
          material: { ambient: 0.4, diffuse: 0.6, shininess: 32, specularColor: [60, 60, 60] },
          pickable: true,
          updateTriggers: {
            getFillColor: [buildingDhValues, buildingMaxValue, activeBuildingCutoff],
          },
        })
      );
    } else if (showBuildings && buildings3D?.features?.length) {
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

    if (!buildingView) selectedFields.forEach((field) => {
      const data = fieldCache[field];
      if (!data?.length) return;

      const lonOffset = 0;
      const visible = data.filter((d) => activeCutoff === null || d.value <= activeCutoff);

      ls.push(
        new ColumnLayer({
          id: `dh-${field}`,
          data: visible,
          getPosition: (d) => {
            const h = pointHeights[d.sensor_id];
            const lat = (useParquetCoords && h?.lat != null) ? h.lat : d.lat;
            const lon = (useParquetCoords && h?.lon != null) ? h.lon : d.lon;
            return [lon + lonOffset, lat];
          },
          getElevation: (d) => Math.max(0.5, d.value * baseH * heightScale),
          getFillColor: (d) => [...dhToColor(d.value, effectiveSensorMax), 230],
          getLineColor: (d) => [...dhToColor(d.value, effectiveSensorMax), 80],
          radius,
          diskResolution: 18,
          extruded: true,
          stroked: false,
          pickable: true,
          updateTriggers: {
            getPosition:  [useParquetCoords, pointHeights],
            getElevation: [baseH, heightScale],
            getFillColor: [buildingView ? effectiveBuildingMax : effectiveSensorMax],
          },
        })
      );
    });

    return ls;
  }, [
    buildingView, buildingDhValues, buildingMaxValue, activeBuildingCutoff,
    showBuildings, buildingWireframe, buildings3D,
    selectedFields, fieldCache,
    heightScale, radius, maxValue, effectiveSensorMax, effectiveBuildingMax, baseH,
    activeCutoff,
    useParquetCoords, pointHeights,
  ]);

  // ── Tooltip ──
  const getTooltip = useCallback(({ object, layer }) => {
    if (!object) return null;
    const tooltipStyle = {
      background: "#1a1f2e",
      border: "1px solid #3d4555",
      borderRadius: "6px",
      padding: "8px 12px",
      fontSize: "12px",
      fontFamily: "monospace",
      pointerEvents: "none",
    };
    if (layer?.id === "dh-buildings-view") {
      const bid = object.properties?.lm_building_id;
      const val = buildingDhValues[bid];
      if (val == null) return null;
      if (activeBuildingCutoff !== null && val > activeBuildingCutoff) return null;
      const field = selectedFields[0];
      const meta = FIELD_META[field] ?? { label: field ?? "", unit: "°h" };
      return {
        html: `<strong style="color:#e0e0e0">${bid}</strong><br/><span style="color:#8b949e">${meta.label} — building avg</span><br/><span style="color:#E9C46A;font-size:13px"><strong>${val.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${meta.unit}</strong></span>`,
        style: tooltipStyle,
      };
    }
    const field = layer?.id?.replace("dh-", "");
    const meta = FIELD_META[field] ?? { label: field, unit: "" };
    return {
      html: `<strong style="color:#e0e0e0">${object.sensor_id}</strong><br/><span style="color:#8b949e">${meta.label}</span><br/><span style="color:#E9C46A;font-size:13px"><strong>${object.value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${meta.unit}</strong></span>`,
      style: tooltipStyle,
    };
  }, [buildingDhValues, selectedFields, activeBuildingCutoff]);

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

  useEffect(() => {
    if (!openPopover) return;
    const handler = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setOpenPopover(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openPopover]);

  const exportImage = useCallback((scale = 1) => {
    const deck = deckRef.current?.deck;
    const map  = mapRef.current;
    if (!deck) return;

    // Never change useDevicePixels on the live canvas — resizing it mid-cycle
    // causes "drawing to destination smaller than viewport" WebGL errors and
    // blanks the layers. The deck.gl canvas is already at devicePixelRatio × CSS
    // pixels (2× on retina), which is the native high-res source. The scale
    // multiplier soft-upscales the output via the 2D canvas instead.
    const composite = () => {
      const deckCanvas = deck.canvas;
      const srcW = deckCanvas.width;
      const srcH = deckCanvas.height;
      const outW = Math.round(srcW * scale);
      const outH = Math.round(srcH * scale);
      const out = document.createElement("canvas");
      out.width = outW;
      out.height = outH;
      const ctx = out.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // DOM query is more reliable than a ref on <Map> inside DeckGL's child tree.
      const mapCanvas = deckCanvas.parentElement?.querySelector(".mapboxgl-canvas");
      if (mapCanvas) {
        try { ctx.drawImage(mapCanvas, 0, 0, outW, outH); } catch { /* tainted — skip */ }
      }
      ctx.drawImage(deckCanvas, 0, 0, outW, outH);
      out.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `degree-hours-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    };

    if (map) {
      map.once("render", composite);
      map.triggerRepaint();
    } else {
      requestAnimationFrame(composite);
    }
  }, []);

  const s = styles;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Present mode top bar */}
      {presentMode && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 30,
          background: "rgba(16,20,28,0.95)", backdropFilter: "blur(8px)",
          borderBottom: "1px solid #2e3440",
          display: "flex", alignItems: "center", gap: 6, padding: "6px 12px" }}>
          <button onClick={() => { const prev = activeCueIdx - 1; if (prev >= 0) goTo(prev); }}
            disabled={activeCueIdx <= 0}
            style={{ ...s.presentBtn, opacity: activeCueIdx <= 0 ? 0.4 : 1 }}>◀ Back</button>
          <button onClick={() => { const next = activeCueIdx + 1; if (next < cues.length) goTo(next); else if (cues.length > 0) goTo(0); }}
            disabled={cues.length === 0}
            style={{ ...s.presentBtn, borderColor: "#E9C46A", color: "#E9C46A", opacity: cues.length === 0 ? 0.4 : 1 }}>Go ▶</button>
          <button onClick={() => setSequencerAuto((v) => !v)}
            style={{ ...s.presentBtn, borderColor: sequencerAuto ? "#6BCB77" : "#556677", color: sequencerAuto ? "#6BCB77" : "#8b949e" }}>
            {sequencerAuto ? "⏸ Auto" : "▷ Auto"}</button>
          <button
            onClick={() => { setIsRotating(false); setIsZooming(false); setIsZoomIn(false); setIsZoomOut(false); setIsTilting(false); setIsSweeping(false); setIsFlyover(false); cueTransitionRef.current = null; setIsTransitioning(false); }}
            style={{ ...s.presentBtn, borderColor: "#f85149", color: "#f85149" }}>⏹ Pause</button>
          <div style={{ flex: 1 }} />
          <button onClick={() => goTo(0)} disabled={cues.length === 0}
            style={{ ...s.presentBtn, borderColor: "#8b949e", color: "#8b949e", opacity: cues.length === 0 ? 0.4 : 1 }}>⏮ Reset</button>
          <button onClick={() => { goTo(0); setSequencerAuto(true); }} disabled={cues.length === 0}
            style={{ ...s.presentBtn, borderColor: "#4CC9F0", color: "#4CC9F0", opacity: cues.length === 0 ? 0.4 : 1 }}>↺ Replay</button>
          <button onClick={() => setPresentMode(false)}
            style={{ ...s.presentBtn, borderColor: "#C8B6FF", color: "#C8B6FF" }}>✕ Exit</button>
        </div>
      )}

      {/* DeckGL fills everything */}
      <DeckGL
        ref={deckRef}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        controller={{ maxPitch: 85 }}
        layers={layers}
        getTooltip={getTooltip}
      >
        <Map
          ref={mapRef}
          key={mapStyleId}
          mapStyle={resolveStyle(MAP_STYLES.find((ms) => ms.id === mapStyleId).url)}
          mapboxAccessToken={MAPBOX_TOKEN}
          preserveDrawingBuffer={true}
        />
      </DeckGL>

      {loading && <div style={s.overlay}>Loading degree hours…</div>}
      {!loading && selectedFields.length === 0 && (
        <div style={s.overlay}>Select a field to visualise.</div>
      )}

      {/* Legend — bottom left */}
      {!loading && selectedFields.length > 0 && (
        <div style={{ ...s.legend, top: "auto", bottom: 44, left: 14 }}>
          {selectedFields.length === 1 && (
            <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 5 }}>
              {FIELD_META[selectedFields[0]]?.label ?? selectedFields[0]}
              {buildingView && <span style={{ color: "#E9C46A", marginLeft: 5 }}>— bldg avg</span>}
            </div>
          )}
          <div style={{ width: 180, height: 10, borderRadius: 3,
            background: `linear-gradient(to right, ${DH_COLOR_STOPS.map((c) => `rgb(${c.join(",")})`).join(",")})` }} />
          <div style={{ display: "flex", justifyContent: "space-between", width: 180, marginTop: 2, fontSize: 10, color: "#556677" }}>
            <span>0</span>
            <span>{Math.round((buildingView ? effectiveBuildingMax : effectiveSensorMax) / 2).toLocaleString()}</span>
            <span>{Math.round(buildingView ? effectiveBuildingMax : effectiveSensorMax).toLocaleString()} °h</span>
          </div>
          {selectedFields.length > 1 && (
            <div style={{ marginTop: 5, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {selectedFields.map((f, i) => (
                <span key={f} style={{ fontSize: 10, color: FIELD_COLORS[i % FIELD_COLORS.length], fontWeight: 700 }}>
                  ▪ {FIELD_META[f]?.label ?? f}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Cue flash message */}
      {cueMsg && (
        <div style={{ position: "absolute", bottom: 48, left: "50%", transform: "translateX(-50%)",
          background: "rgba(16,20,28,0.92)", border: "1px solid #2e3440", borderRadius: 6,
          padding: "5px 12px", fontSize: 11, color: "#6BCB77", fontFamily: "monospace",
          whiteSpace: "nowrap", zIndex: 25, pointerEvents: "none" }}>
          {cueMsg}
        </div>
      )}

      {/* ── Floating command strip ── */}
      {!presentMode && (
        <div ref={popoverRef} style={{ position: "absolute", top: 14, left: 14, right: 14, zIndex: 20,
          display: "flex", alignItems: "flex-start", gap: 8 }}>

          {/* Title block */}
          <div style={{ background: "rgba(16,20,28,0.92)", backdropFilter: "blur(12px)",
            border: "1px solid #2e3440", borderRadius: 6, padding: "5px 10px", flexShrink: 0,
            display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3" }}>Degree Hours</div>
              <div style={{ display: "flex", gap: 3 }}>
                {[2, 3, 4].map((scale) => (
                  <button key={scale} onClick={() => exportImage(scale)} title={`Export ${scale}× PNG`} style={{
                    background: "none", border: "1px solid #3d4555", borderRadius: 3,
                    color: "#556677", cursor: "pointer", fontSize: 9, fontFamily: "monospace",
                    padding: "1px 5px", lineHeight: 1.4,
                  }}>
                    {scale}×
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 9, color: "#3d4555", textTransform: "uppercase", letterSpacing: 0.6 }}>
              {selectedFields.map((f) => FIELD_SHORT[f] ?? f).join(" · ") || "—"}
              {outlierActive && outlierCutoff != null ? ` · ⚠${outlierCutoff}` : ""}
            </div>
          </div>

          <div style={{ flex: 1 }} />

          {/* Data chip */}
          <div style={{ position: "relative" }}>
            <CommandChip
              label="Data"
              value={[
                selectedFields.length > 0 ? selectedFields.map((f) => FIELD_SHORT[f] ?? f).join("+") : "–",
                outlierActive && outlierCutoff != null ? `⚠${outlierCutoff}` : null,
                outlierActive && outlierCount > 0 ? `${outlierCount} hidden` : null,
              ].filter(Boolean).join(" · ")}
              active={openPopover === "data"}
              onClick={() => setOpenPopover(openPopover === "data" ? null : "data")}
            />
            {openPopover === "data" && (
              <Popover>
                {fieldGroups.year.length > 0 && (
                  <>
                    <PopLabel>Year</PopLabel>
                    <PopRow>
                      {fieldGroups.year.map((f) => {
                        const active = selectedFields.includes(f);
                        const color = FIELD_COLORS[FIELD_ORDER.indexOf(f) % FIELD_COLORS.length] ?? FIELD_COLORS[0];
                        return (
                          <ChipBtn key={f} onClick={() => toggleField(f)}
                            style={{ borderColor: active ? color : "#3d4555", color: active ? color : "#8b949e", background: active ? `${color}22` : "none", fontWeight: active ? 700 : 400 }}>
                            {FIELD_META[f]?.label ?? f}
                          </ChipBtn>
                        );
                      })}
                    </PopRow>
                  </>
                )}
                {fieldGroups.threshold.length > 0 && (
                  <>
                    <PopLabel>Threshold</PopLabel>
                    <PopRow>
                      {fieldGroups.threshold.map((f) => {
                        const active = selectedFields.includes(f);
                        const color = FIELD_COLORS[FIELD_ORDER.indexOf(f) % FIELD_COLORS.length] ?? FIELD_COLORS[0];
                        return (
                          <ChipBtn key={f} onClick={() => toggleField(f)}
                            style={{ borderColor: active ? color : "#3d4555", color: active ? color : "#8b949e", background: active ? `${color}22` : "none", fontWeight: active ? 700 : 400 }}>
                            {FIELD_SHORT[f] ?? FIELD_META[f]?.label ?? f}
                          </ChipBtn>
                        );
                      })}
                    </PopRow>
                  </>
                )}
                {fieldGroups.other.length > 0 && (
                  <>
                    <PopLabel>Other</PopLabel>
                    <PopRow>
                      {fieldGroups.other.map((f) => {
                        const active = selectedFields.includes(f);
                        const color = FIELD_COLORS[FIELD_ORDER.indexOf(f) % FIELD_COLORS.length] ?? FIELD_COLORS[0];
                        return (
                          <ChipBtn key={f} onClick={() => toggleField(f)}
                            style={{ borderColor: active ? color : "#3d4555", color: active ? color : "#8b949e", background: active ? `${color}22` : "none" }}>
                            {FIELD_META[f]?.label ?? f}
                          </ChipBtn>
                        );
                      })}
                    </PopRow>
                  </>
                )}
                <PopDivider />
                <PopLabel>Sensor cutoff</PopLabel>
                <PopRow>
                  <ChipBtn onClick={() => setOutlierActive((v) => !v)}
                    style={{ borderColor: outlierActive ? "#f85149" : "#3d4555", color: outlierActive ? "#f85149" : "#8b949e", background: outlierActive ? "#f8514922" : "none" }}>
                    ⚠ Filter
                  </ChipBtn>
                  <input value={outlierInput} onChange={(e) => setOutlierInput(e.target.value)}
                    onBlur={applyOutlierInput} onKeyDown={(e) => e.key === "Enter" && applyOutlierInput()}
                    style={{ ...s.numInput, width: 60 }} placeholder="cutoff" />
                  {outlierActive && outlierCount > 0 && (
                    <span style={{ fontSize: 10, color: "#f85149" }}>{outlierCount} hidden</span>
                  )}
                </PopRow>
                {buildingView && (
                  <>
                    <PopLabel>Building cutoff</PopLabel>
                    <PopRow>
                      <ChipBtn onClick={() => setBuildingOutlierActive((v) => !v)}
                        style={{ borderColor: buildingOutlierActive ? "#f85149" : "#3d4555", color: buildingOutlierActive ? "#f85149" : "#8b949e", background: buildingOutlierActive ? "#f8514922" : "none" }}>
                        ⚠ Filter
                      </ChipBtn>
                      <input value={buildingOutlierInput} onChange={(e) => setBuildingOutlierInput(e.target.value)}
                        onBlur={applyBuildingOutlierInput} onKeyDown={(e) => e.key === "Enter" && applyBuildingOutlierInput()}
                        style={{ ...s.numInput, width: 60 }} placeholder="cutoff" />
                      {buildingOutlierActive && buildingOutlierCount > 0 && (
                        <span style={{ fontSize: 10, color: "#f85149" }}>{buildingOutlierCount} hidden</span>
                      )}
                    </PopRow>
                  </>
                )}
                <PopDivider />
                <PopLabel>Scale max — sensors (auto: {Math.round(globalMaxValue).toLocaleString()})</PopLabel>
                <PopRow>
                  <input value={scaleMaxInput} onChange={(e) => setScaleMaxInput(e.target.value)}
                    onBlur={applyScaleMaxInput} onKeyDown={(e) => e.key === "Enter" && applyScaleMaxInput()}
                    style={{ ...s.numInput, width: 72 }} placeholder="auto" />
                  {scaleMax !== null && (
                    <ChipBtn onClick={() => { setScaleMax(null); setScaleMaxInput(""); }}
                      style={{ color: "#8b949e" }}>✕ reset</ChipBtn>
                  )}
                </PopRow>
                <PopLabel>Scale max — buildings (auto: {Math.round(globalBuildingMaxValue).toLocaleString()})</PopLabel>
                <PopRow>
                  <input value={buildingScaleMaxInput} onChange={(e) => setBuildingScaleMaxInput(e.target.value)}
                    onBlur={applyBuildingScaleMaxInput} onKeyDown={(e) => e.key === "Enter" && applyBuildingScaleMaxInput()}
                    style={{ ...s.numInput, width: 72 }} placeholder="auto" />
                  {buildingScaleMax !== null && (
                    <ChipBtn onClick={() => { setBuildingScaleMax(null); setBuildingScaleMaxInput(""); }}
                      style={{ color: "#8b949e" }}>✕ reset</ChipBtn>
                  )}
                </PopRow>
              </Popover>
            )}
          </div>

          {/* Layers chip */}
          <div style={{ position: "relative" }}>
            <CommandChip
              label="Layers"
              value={[
                showBuildings ? "Bldgs" : null,
                buildingWireframe ? "Wire" : null,
                buildingView ? "Avg" : null,
              ].filter(Boolean).join(" · ") || "–"}
              active={openPopover === "layers"}
              onClick={() => setOpenPopover(openPopover === "layers" ? null : "layers")}
            />
            {openPopover === "layers" && (
              <Popover>
                <PopLabel>Buildings</PopLabel>
                <PopRow>
                  <ToggleChip active={showBuildings} color="#6BCB77" onClick={() => setShowBuildings((v) => !v)}>▦ Bldgs</ToggleChip>
                  {showBuildings && (
                    <ToggleChip active={buildingWireframe} color="#88AADD" onClick={() => setBuildingWireframe((v) => !v)}>⬡ Wire</ToggleChip>
                  )}
                  <ToggleChip active={buildingView} color="#E9C46A" onClick={() => setBuildingView((v) => !v)}>⬛ Bldg avg</ToggleChip>
                </PopRow>
                <PopLabel>Sensors</PopLabel>
                <PopRow>
                  <ToggleChip active={useParquetCoords} color="#4CC9F0" onClick={() => setUseParquetCoords((v) => !v)}>⌖ Parquet coords</ToggleChip>
                </PopRow>
                <PopDivider />
                <PopLabel>Height ×{heightScale.toFixed(1)}</PopLabel>
                <PopRow>
                  <input type="range" min={0.1} max={25} step={0.1} value={heightScale}
                    onChange={(e) => setHeightScale(Number(e.target.value))}
                    style={{ width: 160, accentColor: "#E9C46A", cursor: "pointer" }} />
                </PopRow>
                <PopLabel>Radius {radius}m</PopLabel>
                <PopRow>
                  <input type="range" min={2} max={20} step={1} value={radius}
                    onChange={(e) => setRadius(Number(e.target.value))}
                    style={{ width: 80, accentColor: "#58a6ff", cursor: "pointer" }} />
                </PopRow>
                <PopDivider />
                <PopLabel>Map style</PopLabel>
                <PopRow>
                  {MAP_STYLES.map((ms) => (
                    <ChipBtn key={ms.id} onClick={() => setMapStyleId(ms.id)}
                      style={{ borderColor: mapStyleId === ms.id ? "#4CC9F0" : "#3d4555", color: mapStyleId === ms.id ? "#4CC9F0" : "#8b949e", background: mapStyleId === ms.id ? "#4CC9F022" : "none" }}>
                      {ms.name}
                    </ChipBtn>
                  ))}
                </PopRow>
              </Popover>
            )}
          </div>

          {/* Camera chip */}
          <div style={{ position: "relative" }}>
            <CommandChip
              label="Camera"
              value={[
                isRotating ? `↻${rotateSpeed}` : null,
                isZooming ? `⇱±${zoomAmp}` : null,
                isZoomIn ? `⊕${zoomInFactor}×` : null,
                isZoomOut ? `⊖${zoomOutFactor}×` : null,
                isTilting ? `⟂±${tiltAmp}°` : null,
                isSweeping ? `↓${sweepTarget}°` : null,
                isFlyover ? `→${flyoverSpeed}m/s` : null,
              ].filter(Boolean).join(" ") || "–"}
              active={openPopover === "camera"}
              onClick={() => setOpenPopover(openPopover === "camera" ? null : "camera")}
            />
            {openPopover === "camera" && (
              <Popover>
                <PopLabel>Rotate</PopLabel>
                <PopRow>
                  <ToggleChip active={isRotating} color="#E9C46A" onClick={() => setIsRotating((v) => !v)}>
                    {isRotating ? "⏸ Rot" : "↻ Rot"}
                  </ToggleChip>
                  {[0.1, 0.3, 1, 3].map((spd) => (
                    <ChipBtn key={spd} onClick={() => setRotateSpeed(spd)}
                      style={{ borderColor: rotateSpeed === spd ? "#E9C46A" : "#3d4555", color: rotateSpeed === spd ? "#E9C46A" : "#8b949e", background: rotateSpeed === spd ? "#E9C46A22" : "none" }}>
                      {spd}×
                    </ChipBtn>
                  ))}
                </PopRow>
                <PopLabel>Zoom osc</PopLabel>
                <PopRow>
                  <ToggleChip active={isZooming} color="#C8B6FF" onClick={() => { isZooming ? setIsZooming(false) : startZoom(); }}>
                    {isZooming ? "⏸ Zoom" : "⇱ Zoom"}
                  </ToggleChip>
                  {[0.5, 1, 2].map((amp) => (
                    <ChipBtn key={amp} onClick={() => setZoomAmp(amp)}
                      style={{ borderColor: zoomAmp === amp ? "#C8B6FF" : "#3d4555", color: zoomAmp === amp ? "#C8B6FF" : "#8b949e", background: zoomAmp === amp ? "#C8B6FF22" : "none" }}>
                      ±{amp}
                    </ChipBtn>
                  ))}
                </PopRow>
                <PopLabel>Zoom in</PopLabel>
                <PopRow>
                  <ToggleChip active={isZoomIn} color="#C8B6FF" onClick={() => { isZoomIn ? setIsZoomIn(false) : startZoomIn(); }}>
                    {isZoomIn ? "⏸ ZIn" : "⊕ ZIn"}
                  </ToggleChip>
                  {[2, 3, 5, 10].map((f) => (
                    <ChipBtn key={f} onClick={() => setZoomInFactor(f)}
                      style={{ borderColor: zoomInFactor === f ? "#C8B6FF" : "#3d4555", color: zoomInFactor === f ? "#C8B6FF" : "#8b949e", background: zoomInFactor === f ? "#C8B6FF22" : "none" }}>
                      {f}×
                    </ChipBtn>
                  ))}
                  {[4000, 8000, 16000].map((d) => (
                    <ChipBtn key={d} onClick={() => setZoomInDuration(d)}
                      style={{ borderColor: zoomInDuration === d ? "#C8B6FF" : "#3d4555", color: zoomInDuration === d ? "#C8B6FF" : "#8b949e", background: zoomInDuration === d ? "#C8B6FF22" : "none" }}>
                      {d/1000}s
                    </ChipBtn>
                  ))}
                </PopRow>
                <PopLabel>Zoom out</PopLabel>
                <PopRow>
                  <ToggleChip active={isZoomOut} color="#C8B6FF" onClick={() => { isZoomOut ? setIsZoomOut(false) : startZoomOut(); }}>
                    {isZoomOut ? "⏸ ZOut" : "⊖ ZOut"}
                  </ToggleChip>
                  {[2, 3, 5, 10].map((f) => (
                    <ChipBtn key={f} onClick={() => setZoomOutFactor(f)}
                      style={{ borderColor: zoomOutFactor === f ? "#C8B6FF" : "#3d4555", color: zoomOutFactor === f ? "#C8B6FF" : "#8b949e", background: zoomOutFactor === f ? "#C8B6FF22" : "none" }}>
                      {f}×
                    </ChipBtn>
                  ))}
                  {[4000, 8000, 16000].map((d) => (
                    <ChipBtn key={d} onClick={() => setZoomOutDuration(d)}
                      style={{ borderColor: zoomOutDuration === d ? "#C8B6FF" : "#3d4555", color: zoomOutDuration === d ? "#C8B6FF" : "#8b949e", background: zoomOutDuration === d ? "#C8B6FF22" : "none" }}>
                      {d/1000}s
                    </ChipBtn>
                  ))}
                </PopRow>
                <PopLabel>Tilt osc</PopLabel>
                <PopRow>
                  <ToggleChip active={isTilting} color="#FF6B9D" onClick={() => { isTilting ? setIsTilting(false) : startTilt(); }}>
                    {isTilting ? "⏸ Tilt" : "⟂ Tilt"}
                  </ToggleChip>
                  {[10, 20, 35].map((amp) => (
                    <ChipBtn key={amp} onClick={() => setTiltAmp(amp)}
                      style={{ borderColor: tiltAmp === amp ? "#FF6B9D" : "#3d4555", color: tiltAmp === amp ? "#FF6B9D" : "#8b949e", background: tiltAmp === amp ? "#FF6B9D22" : "none" }}>
                      ±{amp}°
                    </ChipBtn>
                  ))}
                </PopRow>
                <PopLabel>Sweep</PopLabel>
                <PopRow>
                  <ToggleChip active={isSweeping} color="#FF6B9D" onClick={() => { isSweeping ? setIsSweeping(false) : startSweep(); }}>
                    {isSweeping ? "⏸ Sweep" : "↓ Sweep"}
                  </ToggleChip>
                  {[5, 30, 60, 75].map((t) => (
                    <ChipBtn key={t} onClick={() => setSweepTarget(t)}
                      style={{ borderColor: sweepTarget === t ? "#FF6B9D" : "#3d4555", color: sweepTarget === t ? "#FF6B9D" : "#8b949e", background: sweepTarget === t ? "#FF6B9D22" : "none" }}>
                      {t}°
                    </ChipBtn>
                  ))}
                  {[5000, 10000, 20000].map((d) => (
                    <ChipBtn key={d} onClick={() => setSweepDuration(d)}
                      style={{ borderColor: sweepDuration === d ? "#FF6B9D" : "#3d4555", color: sweepDuration === d ? "#FF6B9D" : "#8b949e", background: sweepDuration === d ? "#FF6B9D22" : "none" }}>
                      {d/1000}s
                    </ChipBtn>
                  ))}
                </PopRow>
                <PopLabel>Flyover</PopLabel>
                <PopRow>
                  <ToggleChip active={isFlyover} color="#6BCB77" onClick={() => setIsFlyover((v) => !v)}>
                    {isFlyover ? "⏸ Fly" : "→ Fly"}
                  </ToggleChip>
                  {[10, 30, 100].map((spd) => (
                    <ChipBtn key={spd} onClick={() => setFlyoverSpeed(spd)}
                      style={{ borderColor: flyoverSpeed === spd ? "#6BCB77" : "#3d4555", color: flyoverSpeed === spd ? "#6BCB77" : "#8b949e", background: flyoverSpeed === spd ? "#6BCB7722" : "none" }}>
                      {spd}m/s
                    </ChipBtn>
                  ))}
                </PopRow>
              </Popover>
            )}
          </div>

          {/* Rig chip */}
          <div style={{ position: "relative" }}>
            <CommandChip
              label="Rig"
              value={cues.length > 0 ? `${cues.length} cues` : "–"}
              active={openPopover === "rig"}
              onClick={() => setOpenPopover(openPopover === "rig" ? null : "rig")}
            />
            {openPopover === "rig" && (
              <Popover style={{ width: 320 }}>
                <PopRow>
                  <ChipBtn onClick={addCue} style={{ borderColor: "#6BCB77", color: "#6BCB77" }}>⊕ Add</ChipBtn>
                  <ChipBtn onClick={updateCue} disabled={activeCueIdx < 0}
                    style={{ borderColor: activeCueIdx >= 0 ? "#4CC9F0" : "#3d4555", color: activeCueIdx >= 0 ? "#4CC9F0" : "#556677", opacity: activeCueIdx < 0 ? 0.5 : 1 }}>
                    ⟳ Update
                  </ChipBtn>
                  <ChipBtn onClick={mergeView} disabled={activeCueIdx < 0}
                    style={{ borderColor: activeCueIdx >= 0 ? "#4CC9F0" : "#3d4555", color: activeCueIdx >= 0 ? "#4CC9F0" : "#556677", opacity: activeCueIdx < 0 ? 0.5 : 1 }}>
                    ⤵ Merge
                  </ChipBtn>
                </PopRow>
                <PopDivider />
                <PopRow>
                  <ToggleChip active={sequencerAuto} color="#6BCB77" onClick={() => setSequencerAuto((v) => !v)}>
                    {sequencerAuto ? "⏸ Auto" : "▷ Auto"}
                  </ToggleChip>
                  <ToggleChip active={sequencerLoop} color="#6BCB77" onClick={() => setSequencerLoop((v) => !v)}>↺ Loop</ToggleChip>
                  <ChipBtn onClick={() => { const prev = activeCueIdx - 1; if (prev >= 0) goTo(prev); }} disabled={activeCueIdx <= 0}
                    style={{ opacity: activeCueIdx <= 0 ? 0.4 : 1 }}>◀</ChipBtn>
                  <ChipBtn onClick={() => { const next = activeCueIdx + 1; if (next < cues.length) goTo(next); else if (cues.length > 0) goTo(0); }} disabled={cues.length === 0}
                    style={{ borderColor: "#E9C46A", color: "#E9C46A", opacity: cues.length === 0 ? 0.4 : 1 }}>Go ▶</ChipBtn>
                  <ChipBtn
                    onClick={() => { setIsRotating(false); setIsZooming(false); setIsZoomIn(false); setIsZoomOut(false); setIsTilting(false); setIsSweeping(false); setIsFlyover(false); cueTransitionRef.current = null; setIsTransitioning(false); }}
                    style={{ borderColor: "#f85149", color: "#f85149" }}>⏸</ChipBtn>
                  <ChipBtn onClick={() => goTo(0)} disabled={cues.length === 0}
                    style={{ opacity: cues.length === 0 ? 0.4 : 1 }}>⏮</ChipBtn>
                </PopRow>
                <div style={{ maxHeight: 240, overflowY: "auto", marginTop: 2 }}>
                  {cues.length === 0 && (
                    <div style={{ color: "#556677", fontSize: 11, textAlign: "center", padding: "8px 0" }}>
                      No cues — click ⊕ Add to capture current state
                    </div>
                  )}
                  {cues.map((cue, idx) => {
                    const isActive = idx === activeCueIdx;
                    const anims = [];
                    if (cue.rotate)  anims.push(`↻${cue.rotateSpeed}`);
                    if (cue.zoom)    anims.push(`⇱±${cue.zoomAmp}`);
                    if (cue.zoomIn)  anims.push(`⊕${cue.zoomInFactor}×`);
                    if (cue.zoomOut) anims.push(`⊖${cue.zoomOutFactor}×`);
                    if (cue.tilt)    anims.push(`⟂±${cue.tiltAmp}°`);
                    if (cue.sweep)   anims.push(`↓${cue.sweepTarget}°`);
                    if (cue.flyover) anims.push(`→${cue.flyoverSpeed}`);
                    if (!anims.length) anims.push("—");
                    return (
                      <div key={cue.id} onClick={() => goTo(idx)}
                        style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", borderRadius: 4,
                                 cursor: "pointer", background: isActive ? "#E9C46A18" : "transparent",
                                 border: `1px solid ${isActive ? "#E9C46A55" : "transparent"}`, marginBottom: 2 }}>
                        <span style={{ fontSize: 10, color: isActive ? "#E9C46A" : "#556677", minWidth: 14, textAlign: "right" }}>{idx + 1}</span>
                        <input value={cue.label} onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, label: e.target.value } : c))}
                          style={{ ...s.numInput, flex: 1, background: "transparent", border: "1px solid transparent", padding: "1px 4px" }}
                          onFocus={(e) => { e.target.style.borderColor = "#3d4555"; }}
                          onBlur={(e) => { e.target.style.borderColor = "transparent"; }} />
                        <span style={{ fontSize: 9, color: "#556677", whiteSpace: "nowrap" }}>{anims.join(" ")}</span>
                        <span style={{ fontSize: 9, color: "#3d4555" }}>f</span>
                        <input type="number" min={0} step={0.5} value={cue.fade ?? 0}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, fade: Math.max(0, Number(e.target.value)) } : c))}
                          style={{ ...s.numInput, width: 28, padding: "1px 3px" }} />
                        <span style={{ fontSize: 9, color: "#3d4555" }}>h</span>
                        <input type="number" min={0} value={cue.hold}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setCues((prev) => prev.map((c, i) => i === idx ? { ...c, hold: Math.max(0, Number(e.target.value)) } : c))}
                          style={{ ...s.numInput, width: 28, padding: "1px 3px" }} />
                        <button disabled={idx === 0} onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = [...prev]; [a[idx-1], a[idx]] = [a[idx], a[idx-1]]; if (activeCueIdx === idx) setActiveCueIdx(idx-1); else if (activeCueIdx === idx-1) setActiveCueIdx(idx); return a; }); }}
                          style={{ ...s.btn, padding: "0 3px", opacity: idx === 0 ? 0.3 : 1, fontSize: 9 }}>↑</button>
                        <button disabled={idx === cues.length - 1} onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = [...prev]; [a[idx], a[idx+1]] = [a[idx+1], a[idx]]; if (activeCueIdx === idx) setActiveCueIdx(idx+1); else if (activeCueIdx === idx+1) setActiveCueIdx(idx); return a; }); }}
                          style={{ ...s.btn, padding: "0 3px", opacity: idx === cues.length-1 ? 0.3 : 1, fontSize: 9 }}>↓</button>
                        <button onClick={(e) => { e.stopPropagation(); setCues((prev) => { const a = prev.filter((_, i) => i !== idx); if (activeCueIdx >= a.length) setActiveCueIdx(a.length - 1); return a; }); }}
                          style={{ ...s.btn, padding: "0 4px", borderColor: "#f85149", color: "#f85149", fontSize: 9 }}>✕</button>
                      </div>
                    );
                  })}
                </div>
                <PopDivider />
                <PopRow>
                  <ChipBtn onClick={saveCues} style={{ borderColor: "#6BCB77", color: "#6BCB77" }}>💾 Save</ChipBtn>
                  <ChipBtn onClick={loadCues} style={{ borderColor: "#6BCB77", color: "#6BCB77" }}>📂 Load</ChipBtn>
                  <ChipBtn onClick={() => setPresentMode(true)} style={{ borderColor: "#C8B6FF", color: "#C8B6FF" }}>⛶ Present</ChipBtn>
                </PopRow>
                {cueMsg && (
                  <div style={{ fontSize: 10, color: "#6BCB77", fontFamily: "monospace", marginTop: 2 }}>{cueMsg}</div>
                )}
              </Popover>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────
const styles = {
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
  legend: {
    position: "absolute",
    zIndex: 5,
    background: "rgba(22,27,34,0.88)",
    backdropFilter: "blur(4px)",
    border: "1px solid #2e3440",
    borderRadius: 10,
    padding: "10px 14px",
    fontFamily: "monospace",
    pointerEvents: "none",
  },
};



