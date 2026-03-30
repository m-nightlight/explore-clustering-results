/**
 * SMHI STRÅNG solar irradiance utility for Gothenburg (lon: 11.97, lat: 57.71).
 *
 * STRÅNG is SMHI's open mesoscale analysis of solar radiation.
 * Parameter 117 = Global Horizontal Irradiance (GHI), hourly, W/m².
 * Covers 1999-onward; no API key required.
 *
 * Timestamps in the API response are ISO 8601 UTC ("YYYY-MM-DDTHH:MM:SSZ").
 * Typical summer peak in Gothenburg: ~800–900 W/m² on a clear day.
 */

const API_BASE =
  "https://opendata-download-metanalys.smhi.se/api/category/strang1g/version/1" +
  "/geotype/point/lon/11.97/lat/57.71/parameter/117/data.json";

const LS_PREFIX = "smhi_strang_v3_"; // v3: switched to parameter 117 (global GHI)

/**
 * Fetch hourly GHI data for [fromDate, toDate] (inclusive, "YYYY-MM-DD").
 * Results are cached in localStorage; cache is read-before-fetch on every call.
 * Returns null on network or parse failure — callers must handle null gracefully.
 *
 * @param {string} fromDate  e.g. "2024-06-01"
 * @param {string} toDate    e.g. "2024-06-30"
 * @returns {Promise<Array<{date_time: string, value: number}> | null>}
 */
export async function fetchStrangData(fromDate, toDate) {
  const cacheKey = `${LS_PREFIX}${fromDate}_${toDate}`;

  // Return cached data if available
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    /* ignore storage read errors */
  }

  try {
    // No &interval param — omitting it returns all hourly entries.
    // &interval=hourly collapses to one daily-aggregate entry (a SMHI API quirk).
    const url = `${API_BASE}?from=${fromDate}&to=${toDate}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`SMHI STRÅNG fetch failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data)) return null;

    // Cache for future loads (data is historical, won't change)
    try {
      localStorage.setItem(cacheKey, JSON.stringify(data));
    } catch {
      /* quota exceeded — continue without caching */
    }

    return data;
  } catch (err) {
    console.warn("SMHI STRÅNG fetch error:", err);
    return null;
  }
}

/**
 * Look up the irradiance (W/m²) closest to the given timestamp from STRÅNG data.
 * Matches the nearest hourly entry within ±90 minutes.
 * Returns null if data is unavailable or no entry is within range.
 *
 * @param {number} timestampMs  Unix ms (UTC)
 * @param {Array | null} data   Result of fetchStrangData
 * @returns {number | null}
 */
export function getIrradiance(timestampMs, data) {
  if (!data?.length) return null;

  // STRÅNG date_time strings are already ISO 8601 UTC ("2019-07-26T12:00:00Z")
  // — parse directly; do NOT append Z (would produce "...ZZ" → NaN).
  let closest = null;
  let minDiff = Infinity;

  for (const entry of data) {
    const entryMs = new Date(entry.date_time).getTime();
    const diff = Math.abs(entryMs - timestampMs);
    if (diff < minDiff) {
      minDiff = diff;
      closest = entry.value;
    }
    // Data is sorted chronologically; once diff grows again we can stop
    if (entryMs > timestampMs + 5400000) break; // 90 min past target
  }

  // Only return if within ±90 minutes of a known entry
  return minDiff <= 5400000 ? closest : null;
}

/**
 * Estimate clear-sky GHI (W/m²) from sun altitude alone.
 * Rough approximation: peak_GHI * sin(altitude). Used to detect cloud cover
 * by comparing against actual STRÅNG values.
 *
 * @param {number} altitudeDeg  Sun altitude in degrees
 * @returns {number}  0 when below horizon
 */
export function clearSkyEstimate(altitudeDeg) {
  if (altitudeDeg <= 0) return 0;
  return 900 * Math.sin(altitudeDeg * (Math.PI / 180));
}
