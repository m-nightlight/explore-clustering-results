"""
Generate evenly distributed sensor positions within building polygons.

For each building, distributes its sensors across the building footprint using
farthest-point sampling on a fine interior grid. Output is a parquet file with
columns: sensor_id, spread_lat, spread_lon.

Usage:
    pip install shapely
    python generate_spread_positions.py

Env vars:
    DATABASE_URL               — PostgreSQL connection string
    POINT_HEIGHTS_PARQUET      — path to existing sensor parquet (source of lm_building_id)
    SPREAD_POSITIONS_PARQUET   — output path (default: ../data/sensor_spread_positions.parquet)
"""

import asyncio
import json
import os

import asyncpg
import numpy as np
import pandas as pd
from shapely.geometry import Point, shape

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://localhost/sensor_explorer")
# The building-level parquet (combined_name, lat, lon, lm_building_id, floor_df1, …)
BUILDING_CLUSTERS_PARQUET = os.environ.get(
    "BUILDING_CLUSTERS_PARQUET",
    os.path.join(os.path.dirname(__file__), "..", "data", "meta_clusters_combined_building_level.parquet"),
)
SPREAD_POSITIONS_PARQUET = os.environ.get(
    "SPREAD_POSITIONS_PARQUET",
    os.path.join(os.path.dirname(__file__), "..", "data", "sensor_spread_positions.parquet"),
)

# Grid density: candidate points per sensor (higher = better spread, slower)
GRID_DENSITY = 50


def _parse_dsn(url: str) -> str:
    """Strip params asyncpg doesn't understand."""
    from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
    p = urlparse(url)
    qs = parse_qs(p.query)
    qs.pop("gssencmode", None)
    qs.pop("sslmode", None)
    clean = p._replace(query=urlencode(qs, doseq=True))
    return urlunparse(clean)


def _sample_polygon(polygon, n: int) -> list[tuple[float, float]]:
    """
    Return n evenly spread (lon, lat) points inside `polygon`.
    Uses a fine grid then farthest-point sampling for visual uniformity.
    """
    minx, miny, maxx, maxy = polygon.bounds

    # Build candidate grid — enough cells to get GRID_DENSITY × n interior points
    total_candidates_target = max(n * GRID_DENSITY, 100)
    bb_area = (maxx - minx) * (maxy - miny)
    if bb_area == 0:
        c = polygon.centroid
        return [(c.x, c.y)] * n

    # Aspect-correct cell count
    aspect = (maxx - minx) / (maxy - miny) if (maxy - miny) > 0 else 1.0
    ny = int(np.ceil(np.sqrt(total_candidates_target / aspect)))
    nx = int(np.ceil(ny * aspect))

    xs = np.linspace(minx, maxx, max(nx, 2))
    ys = np.linspace(miny, maxy, max(ny, 2))
    xx, yy = np.meshgrid(xs, ys)
    grid_pts = np.column_stack([xx.ravel(), yy.ravel()])

    # Filter to polygon interior (vectorised, works with shapely 1.x and 2.x)
    try:
        from shapely import contains_xy
        mask = contains_xy(polygon, grid_pts[:, 0], grid_pts[:, 1])
    except ImportError:
        from shapely.vectorized import contains
        mask = contains(polygon, grid_pts[:, 0], grid_pts[:, 1])
    candidates = grid_pts[mask]

    if len(candidates) == 0:
        c = polygon.centroid
        return [(c.x, c.y)] * n

    if len(candidates) <= n:
        # Fewer candidates than sensors — repeat cyclically
        chosen = [candidates[i % len(candidates)] for i in range(n)]
        return [(p[0], p[1]) for p in chosen]

    # Farthest-point sampling for spatial uniformity
    chosen_idx = [0]  # seed with first candidate
    min_dists = np.full(len(candidates), np.inf)

    for _ in range(n - 1):
        last = candidates[chosen_idx[-1]]
        dists = np.sum((candidates - last) ** 2, axis=1)
        min_dists = np.minimum(min_dists, dists)
        chosen_idx.append(int(np.argmax(min_dists)))

    chosen = candidates[chosen_idx]
    return [(p[0], p[1]) for p in chosen]


async def main():
    # ── Load building-level parquet for sensor → building mapping ──
    print(f"Reading {BUILDING_CLUSTERS_PARQUET} …")
    df = pd.read_parquet(BUILDING_CLUSTERS_PARQUET, columns=["combined_name", "lat", "lon", "lm_building_id"])
    df = df.rename(columns={"combined_name": "sensor_id"})
    df["lm_building_id"] = df["lm_building_id"].astype(str)

    no_building = df["lm_building_id"].isna() | (df["lm_building_id"] == "nan")
    print(f"  {len(df)} sensors total, {no_building.sum()} without building id (kept at original position)")

    # ── Fetch building polygons from DB ──
    print("Connecting to database …")
    conn = await asyncpg.connect(_parse_dsn(DATABASE_URL))
    rows = await conn.fetch("""
        SELECT DISTINCT ON (properties->>'lm_building_id')
            properties->>'lm_building_id'                  AS lm_building_id,
            ST_AsGeoJSON(ST_Transform(building_geom, 4326)) AS geom
        FROM sensors
        WHERE building_geom IS NOT NULL
        ORDER BY properties->>'lm_building_id'
    """)
    await conn.close()
    print(f"  {len(rows)} building polygons fetched")

    building_polygons: dict[str, object] = {}
    for r in rows:
        if r["geom"]:
            building_polygons[r["lm_building_id"]] = shape(json.loads(r["geom"]))

    # ── Distribute sensors within each building ──
    results = []
    buildings_processed = 0
    buildings_fallback = 0

    for bid, group in df.groupby("lm_building_id"):
        polygon = building_polygons.get(str(bid))
        if polygon is None:
            # No polygon — keep original positions
            for _, row in group.iterrows():
                results.append({
                    "sensor_id": row["sensor_id"],
                    "spread_lat": row["lat"],
                    "spread_lon": row["lon"],
                })
            buildings_fallback += 1
            continue

        n = len(group)
        positions = _sample_polygon(polygon, n)
        buildings_processed += 1

        for (_, row), (slon, slat) in zip(group.iterrows(), positions):
            results.append({
                "sensor_id": row["sensor_id"],
                "spread_lat": slat,
                "spread_lon": slon,
            })

    # Sensors without a building id
    for _, row in df[no_building].iterrows():
        results.append({
            "sensor_id": row["sensor_id"],
            "spread_lat": row["lat"],
            "spread_lon": row["lon"],
        })

    out_df = pd.DataFrame(results).set_index("sensor_id")
    os.makedirs(os.path.dirname(SPREAD_POSITIONS_PARQUET), exist_ok=True)
    out_df.to_parquet(SPREAD_POSITIONS_PARQUET)

    print(f"\nDone.")
    print(f"  Buildings with polygon spread: {buildings_processed}")
    print(f"  Buildings using original pos:  {buildings_fallback}")
    print(f"  Total sensors written:         {len(out_df)}")
    print(f"  Output: {SPREAD_POSITIONS_PARQUET}")


if __name__ == "__main__":
    asyncio.run(main())
