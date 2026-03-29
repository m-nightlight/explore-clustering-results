/**
 * Sun position utilities for Gothenburg (lat: 57.7089, lng: 11.9746).
 *
 * Azimuth convention used throughout this module:
 *   0° = North, 90° = East, 180° = South, 270° = West  (clockwise from north)
 *
 * suncalc uses: 0 = South, positive toward West (radians) — converted here.
 * Altitude is degrees above horizon; negative means below.
 *
 * NOTE: 3D lighting uses deck.gl's built-in _SunLight which handles solar
 * geometry internally. These utilities are for UI display and sun path
 * visualisation only.
 */

import SunCalc from "suncalc";

const LAT = 57.7089;
const LNG = 11.9746;
const RAD2DEG = 180 / Math.PI;

/** suncalc azimuth (rad, south=0, CW toward west) → degrees, north=0, CW */
function toNorthCWDeg(suncalcAzimuthRad) {
  return ((suncalcAzimuthRad * RAD2DEG) + 180) % 360;
}

/**
 * Returns the sun position for Gothenburg at the given timestamp.
 *
 * @param {Date|number} timestamp  Date object or Unix milliseconds
 * @returns {{ azimuth: number, altitude: number, isAboveHorizon: boolean }}
 *          azimuth in degrees 0–360 (N=0, E=90, S=180, W=270)
 *          altitude in degrees (positive = above horizon)
 */
export function getSunInfo(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const { azimuth, altitude } = SunCalc.getPosition(date, LAT, LNG);
  return {
    azimuth: toNorthCWDeg(azimuth),
    altitude: altitude * RAD2DEG,
    isAboveHorizon: altitude > 0,
  };
}

/**
 * Returns sunrise, sunset, and solar noon for the given date in Gothenburg.
 *
 * @param {Date|number} date
 * @returns {{ sunrise: Date, sunset: Date, solarNoon: Date }}
 */
export function getSunTimes(date) {
  const d = date instanceof Date ? date : new Date(date);
  const times = SunCalc.getTimes(d, LAT, LNG);
  return {
    sunrise: times.sunrise,
    sunset: times.sunset,
    solarNoon: times.solarNoon,
  };
}

/**
 * Returns an array of sun positions sampled every 30 minutes from sunrise
 * to sunset for the given date. Used for drawing the sun arc.
 *
 * @param {Date|number} date
 * @returns {Array<{ time: Date, azimuth: number, altitude: number }>}
 */
export function getSunPath(date) {
  const { sunrise, sunset } = getSunTimes(date);

  // On days with no sunrise/sunset (polar night / midnight sun), sunrise or
  // sunset may be NaN. Guard and fall back to a full 24-hour scan so callers
  // always get a usable array.
  const start = isNaN(sunrise) ? new Date(date).setHours(0, 0, 0, 0) : sunrise.getTime();
  const end   = isNaN(sunset)  ? new Date(date).setHours(23, 59, 0, 0) : sunset.getTime();

  const STEP_MS = 30 * 60 * 1000;
  const path = [];

  for (let t = start; t <= end; t += STEP_MS) {
    const ts = new Date(t);
    const { azimuth, altitude } = SunCalc.getPosition(ts, LAT, LNG);
    path.push({
      time: ts,
      azimuth: toNorthCWDeg(azimuth),
      altitude: altitude * RAD2DEG,
    });
  }

  // Always include exact sunset as final point
  if (path.length === 0 || path[path.length - 1].time.getTime() < end) {
    const ts = new Date(end);
    const { azimuth, altitude } = SunCalc.getPosition(ts, LAT, LNG);
    path.push({ time: ts, azimuth: toNorthCWDeg(azimuth), altitude: altitude * RAD2DEG });
  }

  return path;
}

// ── Sanity check ──────────────────────────────────────────────────────────────
// Run:  node src/utils/sunPosition.js
//
// Expected for Gothenburg June 21 (Nordic midsummer, UTC+2 = CEST):
//   06:00 CEST  low sun in NE    azimuth ~50°   altitude ~10°
//   12:00 CEST  near solar noon  azimuth ~180°  altitude ~53°
//   18:00 CEST  afternoon west   azimuth ~270°  altitude ~30°
//   22:00 CEST  barely above     azimuth ~330°  altitude ~2°  (white night)

if (typeof process !== "undefined" && process.argv[1]?.endsWith("sunPosition.js")) {
  const fmt = (n, w = 8) => n.toFixed(1).padStart(w);

  console.log("\nSun positions for Gothenburg — June 21 (midsummer, CEST = UTC+2)\n");
  console.log(
    "Local".padEnd(10),
    "Azimuth°".padStart(10),
    "Altitude°".padStart(11),
    "Above horizon".padStart(15)
  );
  console.log("─".repeat(50));

  for (const [h, label] of [[6, "06:00"], [12, "12:00"], [18, "18:00"], [22, "22:00"]]) {
    const ts = new Date(Date.UTC(2025, 5, 21, h - 2, 0, 0)); // CEST → UTC
    const { azimuth, altitude, isAboveHorizon } = getSunInfo(ts);
    console.log(
      label.padEnd(10),
      fmt(azimuth),
      fmt(altitude, 11),
      String(isAboveHorizon).padStart(15)
    );
  }

  const { sunrise, sunset, solarNoon } = getSunTimes(new Date(Date.UTC(2025, 5, 21, 12, 0, 0)));
  const toLocal = (d) => d.toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" });
  console.log("\nKey times (Stockholm / CEST):");
  console.log("  Sunrise:    ", toLocal(sunrise));
  console.log("  Solar noon: ", toLocal(solarNoon));
  console.log("  Sunset:     ", toLocal(sunset));

  const path = getSunPath(new Date(Date.UTC(2025, 5, 21, 12, 0, 0)));
  const peak = path.reduce((a, b) => b.altitude > a.altitude ? b : a);
  console.log(`\nSun path: ${path.length} samples, peak altitude ${peak.altitude.toFixed(1)}° at ${toLocal(peak.time)}`);
}
