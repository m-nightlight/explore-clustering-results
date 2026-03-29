# Solar Shading Integration — Prompt Plan for Claude Code

## Stack context

The app uses **deck.gl** with `DeckGL` (React, .jsx), **extruded GeoJsonLayer** with `material` for 3D buildings. No Three.js. No TypeScript.

Deck.gl has a built-in `_SunLight` class (import as `SunLight` from `@deck.gl/core`) that takes a **Unix timestamp in milliseconds** and automatically computes the correct sun direction based on the viewport's lat/lon. It also has `_shadow` support on both `SunLight` and `DirectionalLight`. This means we do NOT need SunCalc for positioning the light — deck.gl handles the solar geometry internally.

We still use **suncalc** (already installed) for the utility module that reports azimuth/elevation values for the UI overlay and sun path arc, since deck.gl's SunLight doesn't expose those values.

Use these prompts sequentially. Each builds on the previous step. Test after each one before moving on.

---

## Prompt 1: Create a sun position utility module

```
We already have suncalc installed. Create a utility module at src/utils/sunPosition.js (or wherever our utils live) that:

- Exports a function getSunInfo(timestamp) that takes a Date or Unix ms timestamp and returns { azimuth, altitude, isAboveHorizon } for Gothenburg coordinates (lat: 57.7089, lng: 11.9746). Azimuth and altitude should be in degrees (converted from the radians that suncalc returns). Azimuth should be 0°=North, 90°=East, 180°=South, 270°=West (suncalc uses a different convention — south=0, west=positive — so convert accordingly).
- Exports a function getSunPath(date) that takes a Date and returns an array of { time, azimuth, altitude } objects sampled every 30 minutes from sunrise to sunset for that date. This will be used later for drawing the sun arc.
- Exports sunrise/sunset times: getSunTimes(date) returning { sunrise, sunset, solarNoon } as Date objects.
- This module is purely for UI display and the sun path visualization. The actual 3D lighting will use deck.gl's built-in SunLight which handles solar geometry internally.
- Add a quick console.log test: call getSunInfo for June 21 at 06:00, 12:00, 18:00, 22:00 CEST (UTC+2) and verify the values make sense for Nordic summer.
```

---

## Prompt 2: Add SunLight + LightingEffect with shadows to the deck.gl scene

```
Add solar lighting with shadows to our deck.gl scene. Deck.gl has built-in support for this:

Import these from '@deck.gl/core':
  import { AmbientLight, _SunLight as SunLight, LightingEffect } from '@deck.gl/core';

Create a LightingEffect with two light sources:
1. An AmbientLight with color [255, 255, 255] and intensity ~0.4 (provides base fill light so shadows aren't pitch black)
2. A SunLight with:
   - timestamp: a Unix timestamp in milliseconds (for now hard-code to June 21 at 12:00 UTC, i.e. Date.UTC(2024, 5, 21, 12))
   - color: [255, 255, 230] (slightly warm)
   - intensity: 2.0
   - _shadow: true  (this enables shadow casting — it's experimental but works with extruded polygons)

Create the LightingEffect:
  const lightingEffect = new LightingEffect({ ambientLight, sunLight });

Pass it to our DeckGL component via the effects prop:
  <DeckGL ... effects={[lightingEffect]} />

On our extruded GeoJsonLayer, make sure:
- The `material` prop is set (it probably already is). If not, set it to something like { ambient: 0.6, diffuse: 0.6, shininess: 32, specularColor: [60, 60, 60] } or similar.
- The layer does NOT have shadowEnabled: false (default is true, so just make sure we're not explicitly disabling it).

If we have a ground plane or base layer, it should also receive shadows.

Test: with the hard-coded June 21 noon timestamp, buildings should cast visible shadows roughly to the north (sun is south at noon in Gothenburg). Rotate/tilt the view to verify shadows look correct on the extruded buildings.

IMPORTANT: deck.gl's SunLight uses the viewport's lat/lon to calculate sun position, so it automatically gets the right direction for Gothenburg. We do NOT need to manually compute sun coordinates.
```

---

## Prompt 3: Connect the SunLight timestamp to the existing time series state

```
We already have a time series state/scrubber that drives cluster mean values and sensor measurements. Connect the SunLight to this same time state:

The key challenge: deck.gl's LightingEffect is not reactive — you can't just change a property on the SunLight and have it update. You need to create a NEW SunLight and a NEW LightingEffect whenever the timestamp changes, and pass the new effects array to DeckGL.

Implementation approach:
- When the current timestamp changes (however our time scrubber/slider works), create a new SunLight with the updated timestamp (as Unix ms).
- Create a new LightingEffect with the same AmbientLight and the new SunLight.
- Pass the new effects array to the DeckGL component. If we're using React state, store the effects array in state and update it when time changes.
- Use useMemo or a similar pattern so we're not creating new objects on every render — only when the timestamp actually changes.

Example pattern:
  const lightingEffect = useMemo(() => {
    const ambientLight = new AmbientLight({ color: [255, 255, 255], intensity: 0.4 });
    const sunLight = new SunLight({
      timestamp: currentTimestamp, // Unix ms from our time series state
      color: [255, 255, 230],
      intensity: 2.0,
      _shadow: true
    });
    return new LightingEffect({ ambientLight, sunLight });
  }, [currentTimestamp]);

  // Then: <DeckGL effects={[lightingEffect]} ... />

Performance note: Creating new LightingEffect objects is cheap. The shadow map re-render is the cost, and that happens automatically. If scrubbing quickly causes jank, throttle the timestamp updates to ~10fps (e.g., debounce or requestAnimationFrame). But try without throttling first — deck.gl handles this fairly well.

Don't change any existing data display logic. This is purely additive.
```

---

## Prompt 4: Add a sun info overlay to the UI

```
Add a small informational overlay panel in the 3D view showing the current sun position. Use our getSunInfo() utility from step 1.

When the time series timestamp changes, compute and display:
- Sun azimuth in degrees (e.g., "Az: 185°")
- Sun elevation/altitude in degrees (e.g., "El: 48°")
- Whether the sun is above the horizon
- Current time formatted nicely

Style it as a small semi-transparent panel in a corner of the 3D view (e.g., top-right or bottom-right). Keep it compact — one or two lines. Use our existing app's styling conventions.

Example display:
  ☀️ 14:30 CEST | Az: 220° | El: 52°

If the sun is below the horizon, show a moon icon and "Below horizon" instead.

This panel should update reactively as the user scrubs the timeline. Use the same timestamp that drives the SunLight.
```

---

## Prompt 5: Shadow quality tuning

```
Review and tune the shadow rendering for our Gothenburg summer use case:

Gothenburg summer sun maxes out at ~55° elevation (solar noon midsummer). In morning and evening it's very low angle — long dramatic shadows. Test with the scrubber at:
- 05:00 (sunrise, very low angle, long shadows to the west)
- 12:00 (highest sun, shortest shadows to the north)  
- 21:00 (low evening sun, long shadows to the east)
- 23:00 (near sunset midsummer, extremely long shadows)

Things to check and adjust:
- Are shadows being clipped at low sun angles? If so, the shadow frustum may need adjustment. Deck.gl manages this internally, but if shadows disappear at low angles, we may need to switch from SunLight to a manually positioned DirectionalLight using our suncalc utility for those edge cases.
- Is shadow quality acceptable? If shadows look blocky or aliased, check if deck.gl has any shadow map resolution settings we can adjust.
- Does the AmbientLight intensity (0.4) provide enough fill so shadowed areas are still visible but clearly darker? Adjust if needed.
- Test that shadows interact correctly with all our building geometries. Different height buildings should cast shadows on shorter neighbors.

Also consider modulating the AmbientLight intensity based on sun altitude:
- High sun (midday): ambient 0.3-0.4, sun intensity 2.0 → strong contrast
- Low sun (morning/evening): ambient 0.5-0.6, sun intensity 1.0 → softer, more even
- Below horizon: ambient 0.8, sun intensity 0 → flat night lighting

This gives a more realistic feel as time progresses through the day.
```

---

## Prompt 6: Fetch and integrate SMHI STRÅNG solar irradiance data

```
Add real measured solar irradiance from SMHI's open STRÅNG API to complement the geometric sun position. This gives us actual W/m² values that account for cloud cover, not just theoretical clear-sky geometry.

The STRÅNG API is free, no API key needed. It provides hourly global radiation (GHI) for any point in the Nordic countries at ~2.5 km resolution.

API endpoint for point data:
https://opendata-download-metanalys.smhi.se/api/category/strang1g/version/1/geotype/point/lon/{lon}/lat/{lat}/parameter/116/data.json

- Parameter 116 = Global irradiance (W/m²), hourly.
- lon/lat for Gothenburg: lon/11.97/lat/57.71
- Add query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD&interval=hourly
- Example full URL: https://opendata-download-metanalys.smhi.se/api/category/strang1g/version/1/geotype/point/lon/11.97/lat/57.71/parameter/116/data.json?from=2024-06-01&to=2024-06-30&interval=hourly
- Response is a JSON array of { "date_time": "2024-06-01 06:00:00", "value": 342.5 } objects.

Create a service/utility (e.g. src/utils/smhiIrradiance.js) that:
1. Fetches STRÅNG irradiance data for the date range matching our existing time series data. Cache the result so we don't re-fetch on every page load (localStorage or in-memory is fine).
2. Exports a function getIrradiance(timestamp) that looks up or interpolates the irradiance value (W/m²) for a given timestamp from the cached data.
3. Returns null gracefully if data is unavailable (API down, date range not covered, etc.).

Then integrate it into the lighting and UI:
- Modulate the SunLight intensity using the real irradiance value. Normalize: typical peak summer GHI in Gothenburg is ~800-900 W/m². Map this range to our sun intensity scale (e.g., 0 W/m² → intensity 0, 850 W/m² → intensity 2.0). A cloudy hour should produce noticeably dimmer lighting than a clear-sky hour at the same sun angle.
- Update the sun info overlay to show irradiance: "☀️ 14:30 | 342 W/m² | Az: 220° | El: 52°"
- Optionally: when irradiance is low relative to what clear-sky would predict at that sun angle (indicating cloud cover), tint the AmbientLight slightly blue-grey and increase its relative intensity. This creates a visual "overcast" feel.

The combination lets users distinguish:
- "Sensor dropped because this building cast a shadow on it" (sun position + visible shadow in 3D)
- "Sensor dropped because it was cloudy everywhere" (irradiance drops but sun angle was fine)

Update the useMemo that creates the LightingEffect to also depend on the irradiance value, so lighting updates when either timestamp or irradiance changes.
```

---

## Prompt 7 (Optional): Sun path arc visualization

```
Add a visual arc showing the sun's path across the sky for the current date, rendered as a deck.gl layer.

Use the getSunPath() utility from step 1 to get positions every 30 minutes from sunrise to sunset.

Render the sun path as a PathLayer or LineLayer:
- Convert the sun path (azimuth + altitude) into 3D coordinates relative to the center of our building scene. Place the arc at a radius that looks good visually (maybe 200-500m from center, elevated proportionally to altitude).
- Color-code the arc: brighter/yellow where the sun is high, dimmer/orange near sunrise and sunset.
- Add a small bright circle or icon at the sun's current position along the arc.
- The arc represents one full day, so the user can see the entire sweep and where the sun currently is.

This layer should be toggleable (a checkbox or button in the UI) since it may be distracting during normal analysis.

Alternative simpler approach: if 3D arc positioning is too complex with deck.gl's coordinate system, add a small 2D SVG/canvas sun path diagram in the overlay panel instead — a semicircle showing the horizon with the sun's arc and current position marked. This is simpler and still very informative.
```

---

## Prompt 8 (Optional): Playback animation mode

```
Add an animation/playback mode that automatically advances through the time series:

- A play/pause button that, when active, steps through timestamps at a configurable speed (e.g., 1 hour per second of real time).
- As it plays, the sun moves, shadows sweep across the buildings, and the cluster/sensor data updates in sync. The SMHI irradiance modulates the light brightness, so cloudy periods will visibly dim the scene.
- This creates a "timelapse" effect showing how solar patterns and cloud cover correlate with the measurement data throughout a summer day.
- Add speed controls (0.5x, 1x, 2x, 5x) so the user can slow down around interesting periods or fast-forward through stable ones.
- Pause when the user interacts with the 3D view (orbits, zooms) or clicks the time scrubber manually.
```

---

## Notes for Claude Code

- **All files are .jsx** — no TypeScript.
- **No Three.js** — everything is deck.gl. Use `_SunLight as SunLight`, `AmbientLight`, `LightingEffect` from `@deck.gl/core`.
- **SunLight is experimental** — import as `_SunLight` and alias to `SunLight`. The `_shadow` prop is also experimental but works with extruded polygons in GeoJsonLayer.
- **LightingEffect is not mutable** — you must create a new instance when the timestamp changes. Use React useMemo keyed on the timestamp.
- **Existing time state**: Don't duplicate state management. Hook into whatever mechanism already drives the time series display.
- **material prop**: Our GeoJsonLayer likely already has a `material` prop. Don't remove or radically change it — just make sure it works well with the new lighting. Increase `ambient` slightly if shadows look too dark.
- **Coordinate system**: deck.gl uses [longitude, latitude] and the SunLight computes sun position from the viewport center. Make sure our view is centered on Gothenburg so the sun direction is correct.
- **SMHI STRÅNG data**: The API returns historical data only (not real-time). It covers from 1999 onward. Make sure the date range in our time series falls within STRÅNG availability. The API has no rate limiting or key, but fetch once and cache. If our data year isn't in STRÅNG, fall back to geometric-only lighting.
- **Performance**: Shadow maps are the main cost. Creating new LightingEffect instances is cheap. If animation stutters, throttle timestamp updates.
- **Scope**: This is summertime analysis only — no need to handle winter, but the code should work for any date if someone changes it later.
