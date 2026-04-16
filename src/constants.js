import { SphereGeometry } from "@luma.gl/engine";

export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

export const API = "http://localhost:8000";

export const MAP_STYLES = [
  { id: "dark",           name: "Dark",           url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" },
  { id: "light",          name: "Light",          url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" },
  { id: "voyager",        name: "Voyager",        url: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json" },
  { id: "satellite",      name: "Satellite",      url: "mapbox://styles/matspmapping/cmg9qmif500a801sa4f0b5p5o" },
  { id: "street-numbers", name: "Street Numbers", url: "mapbox://styles/matspmapping/cmj2jmgfx004701se4c711vwc" },
];

export const resolveStyle = (url) =>
  url.startsWith("mapbox://styles/")
    ? `https://api.mapbox.com/styles/v1/${url.slice(16)}?access_token=${MAPBOX_TOKEN}`
    : url;

export const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

// 6-stop blue→red temperature color scale
export const TEMP_COLOR_STOPS = [
  [65, 105, 225],   // cold  (blue)
  [100, 180, 220],
  [180, 220, 180],  // mild  (green-ish)
  [255, 230, 100],
  [255, 140, 0],    // warm  (orange)
  [200, 30,  30],   // hot   (red)
];

export function tempToColor(temp, min, max) {
  const t = Math.max(0, Math.min(1, (temp - min) / Math.max(1, max - min)));
  const scaled = t * (TEMP_COLOR_STOPS.length - 1);
  const lo = Math.floor(scaled), hi = Math.min(lo + 1, TEMP_COLOR_STOPS.length - 1);
  const f = scaled - lo;
  return TEMP_COLOR_STOPS[lo].map((c, i) => Math.round(c + f * (TEMP_COLOR_STOPS[hi][i] - c)));
}

export const COLORS = [
  "#E63946","#457B9D","#2A9D8F","#E9C46A","#F4A261",
  "#6BCB77","#A8DADC","#6A0572","#AB83A1","#1D3557",
  "#F77F00","#D62828","#023E8A","#0077B6","#00B4D8",
  "#90BE6D","#F94144","#277DA1","#577590","#4D908E",
  "#43AA8B","#F3722C","#F8961E","#F9844A","#F9C74F",
];

export const getClusterColor = (i) => COLORS[i % COLORS.length];

// Visually distinct group colours, different enough from COLORS palette
export const GROUP_COLORS = ["#FFFFFF","#FFD93D","#FF6B9D","#6BCB77","#C8B6FF","#FF9A3C","#4CC9F0"];

export const SPHERE_GEOMETRY = new SphereGeometry({ radius: 1, nlat: 8, nlong: 8 });

export const TABS = [
  { id: "profiles",     label: "Cluster Profiles",      icon: "◈" },
  { id: "timeseries",   label: "Time Series",            icon: "◆" },
  { id: "metadata",     label: "Metadata Statistics",    icon: "▦" },
  { id: "map",          label: "Sensor Map",             icon: "◉" },
  { id: "deghours",     label: "Degree Hours",           icon: "▲" },
  { id: "homogeneity",  label: "Building Homogeneity",   icon: "⬡" },
];
