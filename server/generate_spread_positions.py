"""
Generate evenly distributed sensor positions within building polygons.

For each building, distributes its sensors across the building footprint using
farthest-point sampling on a fine interior grid. Also computes lean_max_m —
the maximum distance (metres) each sensor can lean outward from the building
centroid before hitting the polygon boundary.

Output parquet columns: sensor_id, spread_lat, spread_lon, lean_max_m

Usage:
    uv run python generate_spread_positions.py

Env vars:
    DATABASE_URL                — PostgreSQL connection string
    BUILDING_CLUSTERS_PARQUET   — building-level parquet (combined_name, lat, lon, lm_building_id)
    SPREAD_POSITIONS_PARQUET    — output path (default: ../data/sensor_spread_positions.parquet)
"""

import asyncio
import json
import math
import os

import asyncpg
import numpy as np
import pandas as pd
from shapely.geometry import LineString, Point, shape

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://localhost/sensor_explorer")
BUILDING_CLUSTERS_PARQUET = os.environ.get(
    "BUILDING_CLUSTERS_PARQUET",
    os.path.join(os.path.dirname(__file__), "..", "data", "meta_clusters_combined_building_level.parquet"),
)
SPREAD_POSITIONS_PARQUET = os.environ.get(
    "SPREAD_POSITIONS_PARQUET",
    os.path.join(os.path.dirname(__file__), "..", "data", "sensor_spread_positions.parquet"),
)

GRID_DENSITY = 50  # candidate points per sensor (higher = better spread, slower)


def _parse_dsn(url: str) -> str:
    from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
    p = urlparse(url)
    qs = parse_qs(p.query)
    qs.pop("gssencmode", None)
    qs.pop("sslmode", None)
    return urlunparse(p._replace(query=urlencode(qs, doseq=True)))


def _sample_polygon(polygon, n: int) -> list[tuple[float, float]]:
    """Return n evenly spread (lon, lat) points inside polygon using farthest-point sampling."""
    minx, miny, maxx, maxy = polygon.bounds
    total_candidates_target = max(n * GRID_DENSITY, 100)
    bb_area = (maxx - minx) * (maxy - miny)
    if bb_area == 0:
        c = polygon.centroid
        return [(c.x, c.y)] * n

    aspect = (maxx - minx) / (maxy - miny) if (maxy - miny) > 0 else 1.0
    ny = int(np.ceil(np.sqrt(total_candidates_target / aspect)))
    nx = int(np.ceil(ny * aspect))

    xs = np.linspace(minx, maxx, max(nx, 2))
    ys = np.linspace(miny, maxy, max(ny, 2))
    xx, yy = np.meshgrid(xs, ys)
    grid_pts = np.column_stack([xx.ravel(), yy.ravel()])

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
        return [(candidates[i % len(candidates)][0], candidates[i % len(candidates)][1]) for i in range(n)]

    chosen_idx = [0]
    min_dists = np.full(len(candidates), np.inf)
    for _ in range(n - 1):
        last = candidates[chosen_idx[-1]]
        dists = np.sum((candidates - last) ** 2, axis=1)
        min_dists = np.minimum(min_dists, dists)
        chosen_idx.append(int(np.argmax(min_dists)))

    chosen = candidates[chosen_idx]
    return [(p[0], p[1]) for p in chosen]


def _lean_max_m(polygon, spread_lon: float, spread_lat: float,
                centroid_lon: float, centroid_lat: float) -> float:
    """
    Maximum lean distance in metres from spread_pos toward building exterior.
    Casts a ray from spread_pos outward from centroid and finds where it hits
    the polygon boundary.
    """
    dlon = spread_lon - centroid_lon
    dlat = spread_lat - centroid_lat

    # Convert direction to metric space to get correct angle
    lat_rad = math.radians(spread_lat)
    dx_m = dlon * math.cos(lat_rad) * 111000
    dy_m = dlat * 111000
    dist_m = math.sqrt(dx_m ** 2 + dy_m ** 2)

    spread_pt = Point(spread_lon, spread_lat)

    if dist_m < 0.01:
        # Sensor is at centroid — use distance to nearest boundary
        try:
            boundary_dist = spread_pt.distance(polygon.exterior)
        except AttributeError:
            boundary_dist = spread_pt.distance(polygon.geoms[0].exterior)
        return boundary_dist * math.cos(lat_rad) * 111000

    # Normalized direction in degree space
    deg_len = math.sqrt(dlon ** 2 + dlat ** 2)
    ray_end = Point(spread_lon + (dlon / deg_len) * 5,   # 5° = very far
                    spread_lat + (dlat / deg_len) * 5)
    ray = LineString([spread_pt, ray_end])

    # Get boundary (works for Polygon and MultiPolygon)
    try:
        boundary = polygon.exterior
    except AttributeError:
        boundary = polygon.geoms[0].exterior

    intersection = ray.intersection(boundary)
    if intersection.is_empty:
        return 0.0

    # Collect all intersection points
    if hasattr(intersection, 'geoms'):
        pts = [g for g in intersection.geoms if hasattr(g, 'x')]
    elif hasattr(intersection, 'x'):
        pts = [intersection]
    else:
        return 0.0

    if not pts:
        return 0.0

    # Nearest intersection point
    nearest = min(pts, key=lambda p: (p.x - spread_lon) ** 2 + (p.y - spread_lat) ** 2)
    dlon_int = nearest.x - spread_lon
    dlat_int = nearest.y - spread_lat
    dx_int = dlon_int * math.cos(lat_rad) * 111000
    dy_int = dlat_int * 111000
    return math.sqrt(dx_int ** 2 + dy_int ** 2)


async def main():
    print(f"Reading {BUILDING_CLUSTERS_PARQUET} …")
    df = pd.read_parquet(BUILDING_CLUSTERS_PARQUET, columns=["combined_name", "lat", "lon", "lm_building_id"])
    df = df.rename(columns={"combined_name": "sensor_id"})
    df["lm_building_id"] = df["lm_building_id"].astype(str)
    no_building = df["lm_building_id"].isna() | (df["lm_building_id"] == "nan")
    print(f"  {len(df)} sensors total, {no_building.sum()} without building id")

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

    results = []
    buildings_processed = buildings_fallback = 0

    for bid, group in df[~no_building].groupby("lm_building_id"):
        polygon = building_polygons.get(str(bid))
        if polygon is None:
            for _, row in group.iterrows():
                results.append({"sensor_id": row["sensor_id"], "spread_lat": row["lat"],
                                 "spread_lon": row["lon"], "lean_max_m": 0.0})
            buildings_fallback += 1
            continue

        centroid = polygon.centroid
        n = len(group)
        positions = _sample_polygon(polygon, n)
        buildings_processed += 1

        for (_, row), (slon, slat) in zip(group.iterrows(), positions):
            max_m = _lean_max_m(polygon, slon, slat, centroid.x, centroid.y)
            results.append({"sensor_id": row["sensor_id"], "spread_lat": slat,
                             "spread_lon": slon, "lean_max_m": max_m})

    for _, row in df[no_building].iterrows():
        results.append({"sensor_id": row["sensor_id"], "spread_lat": row["lat"],
                         "spread_lon": row["lon"], "lean_max_m": 0.0})

    out_df = pd.DataFrame(results).set_index("sensor_id")
    os.makedirs(os.path.dirname(os.path.abspath(SPREAD_POSITIONS_PARQUET)), exist_ok=True)
    out_df.to_parquet(SPREAD_POSITIONS_PARQUET)

    print(f"\nDone.")
    print(f"  Buildings with polygon spread : {buildings_processed}")
    print(f"  Buildings using original pos  : {buildings_fallback}")
    print(f"  Total sensors written         : {len(out_df)}")
    print(f"  Output: {SPREAD_POSITIONS_PARQUET}")


if __name__ == "__main__":
    asyncio.run(main())
