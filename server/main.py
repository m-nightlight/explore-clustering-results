import json
import os
import re
from contextlib import asynccontextmanager

import asyncpg
import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, Response

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://localhost/sensor_explorer")
POINT_HEIGHTS_PARQUET = os.environ.get(
    "POINT_HEIGHTS_PARQUET",
    "/Users/matsp/phd-python-projects/coordinate_editor/points_export.parquet",
)
BUILDING_CLUSTERS_PARQUET = os.environ.get(
    "BUILDING_CLUSTERS_PARQUET",
    os.path.join(os.path.dirname(__file__), "..", "data", "meta_clusters_combined_building_level.parquet"),
)
SPREAD_POSITIONS_PARQUET = os.environ.get(
    "SPREAD_POSITIONS_PARQUET",
    os.path.join(os.path.dirname(__file__), "..", "data", "sensor_spread_positions.parquet"),
)
SMHI_MEASUREMENTS_DIR = os.environ.get(
    "SMHI_MEASUREMENTS_DIR",
    "/Users/matsp/phd-python-projects/SMHI-Climate-data-collector/data_cities/göteborg/measurements",
)

def _parse_dsn_for_asyncpg(url: str):
    """Strip params asyncpg doesn't understand (e.g. gssencmode) from the DSN."""
    from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
    p = urlparse(url)
    qs = parse_qs(p.query, keep_blank_values=True)
    qs.pop("gssencmode", None)
    new_query = urlencode({k: v[0] for k, v in qs.items()})
    return urlunparse(p._replace(query=new_query))

# Whitelist prevents SQL injection when interpolating column name
CLUSTER_COLS = {
    "cluster":           "cluster",
    "stage1_cluster":    "stage1_cluster",
    "stage2_subcluster": "stage2_subcluster",
}
# Parquet-sourced cluster columns (not in DB; handled via in-memory CTE)
PARQUET_CLUSTER_COLS = {"building_cluster"}


async def init_conn(conn):
    await conn.set_type_codec(
        "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(_parse_dsn_for_asyncpg(DATABASE_URL), init=init_conn)
    try:
        df = pd.read_parquet(POINT_HEIGHTS_PARQUET, columns=["id", "lat", "lon", "floor", "lm_height", "lm_max_floor", "lm_building_id", "osm_height"])
        df = df.dropna(subset=["id"]).drop_duplicates(subset=["id"])
        df["floor"] = df["floor"].clip(lower=0, upper=df["lm_max_floor"].fillna(1))
        df = df.set_index("id")
        df = df.astype(object).where(df.notna(), other=None)
        app.state.point_heights = df.to_dict("index")
        # building_id → osm_height lookup (first non-null per building)
        bh = df[["lm_building_id", "osm_height"]].reset_index(drop=True)
        bh = bh.dropna(subset=["lm_building_id", "osm_height"]).drop_duplicates("lm_building_id")
        app.state.building_osm_heights = dict(zip(bh["lm_building_id"], bh["osm_height"].astype(float)))
    except Exception as e:
        print(f"Warning: could not load point heights from parquet: {e}")
        app.state.point_heights = {}
    try:
        sp = pd.read_parquet(SPREAD_POSITIONS_PARQUET)
        if sp.index.name != "sensor_id":
            sp = sp.set_index("sensor_id")
        cols = [c for c in ["spread_lat", "spread_lon", "lean_max_m"] if c in sp.columns]
        app.state.spread_positions = sp[cols].to_dict("index")
        print(f"Loaded spread positions for {len(app.state.spread_positions)} sensors")
    except Exception as e:
        print(f"Warning: could not load spread positions parquet: {e}")
        app.state.spread_positions = {}
        app.state.building_osm_heights = {}
    try:
        bc_df = pd.read_parquet(BUILDING_CLUSTERS_PARQUET, columns=["combined_name", "building_cluster"])
        bc_df = bc_df.dropna(subset=["combined_name", "building_cluster"])
        bc_df["building_cluster"] = bc_df["building_cluster"].astype(int)
        app.state.building_cluster_map = dict(zip(bc_df["combined_name"], bc_df["building_cluster"]))
        print(f"Loaded building_cluster for {len(app.state.building_cluster_map)} sensors")
    except Exception as e:
        print(f"Warning: could not load building clusters from parquet: {e}")
        app.state.building_cluster_map = {}
    # Preload all building footprints (all sensors with building_geom, no limit)
    try:
        async with app.state.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT ON (properties->>'lm_building_id')
                    properties->>'lm_building_id'          AS lm_building_id,
                    ST_AsGeoJSON(ST_Transform(building_geom, 4326)) AS geom,
                    MAX((properties->>'max_floor')::numeric)
                        OVER (PARTITION BY properties->>'lm_building_id') AS max_floor
                FROM sensors
                WHERE building_geom IS NOT NULL
                ORDER BY properties->>'lm_building_id'
                """
            )
        osm_heights = app.state.building_osm_heights
        features = []
        for r in rows:
            if not r["geom"]:
                continue
            bid = r["lm_building_id"]
            height = (
                osm_heights.get(bid)
                or (float(r["max_floor"]) * 3.2 if r["max_floor"] else 10.0)
            )
            features.append({
                "type": "Feature",
                "geometry": json.loads(r["geom"]),
                "properties": {"lm_building_id": bid, "height": height},
            })
        app.state.all_buildings = {"type": "FeatureCollection", "features": features}
        print(f"Preloaded {len(features)} building footprints")
    except Exception as e:
        print(f"Warning: could not preload buildings: {e}")
        app.state.all_buildings = {"type": "FeatureCollection", "features": []}
    # Ensure custom_cluster_cols table exists and load saved columns
    async with app.state.pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS custom_cluster_cols (
                name            TEXT PRIMARY KEY,
                cluster_mapping JSONB NOT NULL DEFAULT '{}',
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                updated_at      TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        rows = await conn.fetch("SELECT name, cluster_mapping FROM custom_cluster_cols ORDER BY created_at")
        app.state.custom_cluster_cols = {r["name"]: r["cluster_mapping"] for r in rows}
        print(f"Loaded {len(app.state.custom_cluster_cols)} custom cluster column(s)")
    yield
    await app.state.pool.close()


app = FastAPI(lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def generic_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
        headers={"Access-Control-Allow-Origin": "*"},
    )


# ── Helpers ────────────────────────────────────────────────────────────────────

def validated_col(cluster_col: str) -> str:
    if cluster_col in PARQUET_CLUSTER_COLS:
        return cluster_col  # handled via in-memory CTE, not a DB column
    col = CLUSTER_COLS.get(cluster_col)
    if not col:
        raise HTTPException(400, f"Invalid cluster_col. Choose from: {list(CLUSTER_COLS) + list(PARQUET_CLUSTER_COLS)}")
    return col


def parse_clusters(clusters: str | None) -> list[int] | None:
    if not clusters:
        return None
    try:
        return [int(c) for c in clusters.split(",")]
    except ValueError:
        raise HTTPException(400, "clusters must be comma-separated integers")


def reshape_profiles(rows) -> dict:
    """Convert flat DB rows → {timestamps, profiles: {cluster_id: {values, q25, q75, count}}}"""
    timestamps = []
    seen_ts = set()
    profiles: dict[str, dict] = {}

    for r in rows:
        ts = r["ts"].isoformat()
        cid = str(r["cluster_id"])

        if ts not in seen_ts:
            timestamps.append(ts)
            seen_ts.add(ts)

        if cid not in profiles:
            profiles[cid] = {
                "values": [], "q25": [], "q75": [],
                "count": int(r["sensor_count"]),
            }

        profiles[cid]["values"].append(r["val"])
        profiles[cid]["q25"].append(r["q25"])
        profiles[cid]["q75"].append(r["q75"])

    return {"timestamps": timestamps, "profiles": profiles}


async def _building_cluster_profiles(conn, bc_map: dict, cluster_list: list[int] | None) -> dict:
    """Compute cluster profiles using building_cluster via a parallel-array CTE."""
    pairs = [(sid, cid) for sid, cid in bc_map.items()
             if cluster_list is None or cid in cluster_list]
    if not pairs:
        return {"timestamps": [], "profiles": {}}
    sensor_ids = [p[0] for p in pairs]
    cluster_ids = [p[1] for p in pairs]
    rows = await conn.fetch(
        """
        WITH cluster_map(sensor_id, cluster_id) AS (
            SELECT unnest($1::text[]), unnest($2::int[])
        )
        SELECT
            t.ts,
            cm.cluster_id::text                                             AS cluster_id,
            AVG(t.temperature)                                              AS val,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY t.temperature)    AS q25,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY t.temperature)    AS q75,
            COUNT(DISTINCT t.sensor_id)                                     AS sensor_count
        FROM temperatures t
        JOIN cluster_map cm ON cm.sensor_id = t.sensor_id
        GROUP BY t.ts, cm.cluster_id
        ORDER BY t.ts, cm.cluster_id
        """,
        sensor_ids, cluster_ids,
    )
    return reshape_profiles(rows)


async def _building_cluster_means(conn, bc_map: dict, cluster_list: list[int] | None) -> dict:
    """Compute cluster means only for building_cluster (used by timeseries-overview)."""
    pairs = [(sid, cid) for sid, cid in bc_map.items()
             if cluster_list is None or cid in cluster_list]
    if not pairs:
        return {"timestamps": [], "cluster_means": {}}
    sensor_ids = [p[0] for p in pairs]
    cluster_ids = [p[1] for p in pairs]
    rows = await conn.fetch(
        """
        WITH cluster_map(sensor_id, cluster_id) AS (
            SELECT unnest($1::text[]), unnest($2::int[])
        )
        SELECT
            t.ts,
            cm.cluster_id::text  AS cluster_id,
            AVG(t.temperature)   AS val
        FROM temperatures t
        JOIN cluster_map cm ON cm.sensor_id = t.sensor_id
        GROUP BY t.ts, cm.cluster_id
        ORDER BY t.ts, cm.cluster_id
        """,
        sensor_ids, cluster_ids,
    )
    timestamps: list[str] = []
    seen_ts: set[str] = set()
    means: dict[str, list] = {}
    for r in rows:
        ts = r["ts"].isoformat()
        cid = str(r["cluster_id"])
        if ts not in seen_ts:
            timestamps.append(ts)
            seen_ts.add(ts)
        means.setdefault(cid, []).append(r["val"])
    return {"timestamps": timestamps, "cluster_means": means}


async def _building_cluster_map_profiles(conn, bc_map: dict, sensor_ids_filter: list[str]) -> dict:
    """Cluster profiles for a subset of sensors (viewport), using building_cluster."""
    id_set = set(sensor_ids_filter)
    pairs = [(sid, cid) for sid, cid in bc_map.items() if sid in id_set]
    if not pairs:
        return {"timestamps": [], "profiles": {}}
    sensor_ids = [p[0] for p in pairs]
    cluster_ids = [p[1] for p in pairs]
    rows = await conn.fetch(
        """
        WITH cluster_map(sensor_id, cluster_id) AS (
            SELECT unnest($1::text[]), unnest($2::int[])
        )
        SELECT
            t.ts,
            cm.cluster_id::text                                             AS cluster_id,
            AVG(t.temperature)                                              AS val,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY t.temperature)    AS q25,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY t.temperature)    AS q75,
            COUNT(DISTINCT t.sensor_id)                                     AS sensor_count
        FROM temperatures t
        JOIN cluster_map cm ON cm.sensor_id = t.sensor_id
        GROUP BY t.ts, cm.cluster_id
        ORDER BY t.ts, cm.cluster_id
        """,
        sensor_ids, cluster_ids,
    )
    return reshape_profiles(rows)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health(request: Request):
    async with request.app.state.pool.acquire() as conn:
        n_sensors = await conn.fetchval("SELECT COUNT(*) FROM sensors")
        n_temps   = await conn.fetchval("SELECT COUNT(*) FROM temperatures")
    return {"db": "ok", "sensor_count": n_sensors, "temperature_rows": n_temps}


@app.get("/api/metadata")
async def get_metadata(request: Request):
    """Slim metadata — cluster assignments + location only (no JSONB properties)."""
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT sensor_id, lat, lon,
                   stage1_cluster, stage2_subcluster, cluster,
                   domain_code, area
            FROM sensors
            ORDER BY sensor_id
            """
        )
    bc_map = request.app.state.building_cluster_map
    return [
        {
            "sensor_id":         r["sensor_id"],
            "lat":               r["lat"],
            "lon":               r["lon"],
            "stage1_cluster":    r["stage1_cluster"],
            "stage2_subcluster": r["stage2_subcluster"],
            "cluster":           r["cluster"],
            "building_cluster":  bc_map.get(r["sensor_id"]),
            "domain_code":       r["domain_code"],
            "area":              r["area"],
        }
        for r in rows
    ]


@app.get("/api/sensor-properties")
async def get_sensor_properties(request: Request, sensor_id: str = Query(...)):
    """Full JSONB properties for a single sensor (on-demand)."""
    async with request.app.state.pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT sensor_id, properties FROM sensors WHERE sensor_id = $1",
            sensor_id,
        )
    if not row:
        raise HTTPException(404, "Sensor not found")
    return {"sensor_id": row["sensor_id"], **(row["properties"] or {})}


@app.get("/api/cluster-profiles")
async def get_cluster_profiles(
    request: Request,
    cluster_col: str = Query("cluster"),
    clusters:    str = Query(None),
    agg:         str = Query("mean"),   # "mean" | "median"
):
    col          = validated_col(cluster_col)
    cluster_list = parse_clusters(clusters)

    if col == "building_cluster":
        async with request.app.state.pool.acquire() as conn:
            return await _building_cluster_profiles(conn, request.app.state.building_cluster_map, cluster_list)

    # Use materialized view for mean (fast); fall back to live query only for median
    if agg != "median":
        where = "WHERE cluster_col = $1"
        params: list = [col]
        if cluster_list:
            where += " AND cluster_id = ANY($2::text[])"
            params.append([str(c) for c in cluster_list])
        query = f"""
            SELECT ts, cluster_id, val, q25, q75, sensor_count
            FROM mv_cluster_profiles
            {where}
            ORDER BY ts, cluster_id
        """
        async with request.app.state.pool.acquire() as conn:
            rows = await conn.fetch(query, *params)
        return reshape_profiles(rows)

    # Median — live query
    where_live = f"WHERE s.{col} = ANY($1::smallint[])" if cluster_list else ""
    query = f"""
        SELECT
            t.ts,
            s.{col}::text                                               AS cluster_id,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.temperature)  AS val,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY t.temperature) AS q25,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY t.temperature) AS q75,
            COUNT(DISTINCT t.sensor_id)                                 AS sensor_count
        FROM temperatures t
        JOIN sensors s USING (sensor_id)
        {where_live}
        GROUP BY t.ts, s.{col}
        ORDER BY t.ts, s.{col}
    """
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(query, *([cluster_list] if cluster_list else []))
    return reshape_profiles(rows)


@app.get("/api/timeseries-overview")
async def get_timeseries_overview(
    request: Request,
    cluster_col: str = Query("cluster"),
    clusters:    str = Query(None),
):
    """Cluster means only — from materialized view."""
    col          = validated_col(cluster_col)
    cluster_list = parse_clusters(clusters)

    if col == "building_cluster":
        async with request.app.state.pool.acquire() as conn:
            return await _building_cluster_means(conn, request.app.state.building_cluster_map, cluster_list)

    where = "WHERE cluster_col = $1"
    params: list = [col]
    if cluster_list:
        where += " AND cluster_id = ANY($2::text[])"
        params.append([str(c) for c in cluster_list])

    query = f"""
        SELECT ts, cluster_id, val
        FROM mv_cluster_profiles
        {where}
        ORDER BY ts, cluster_id
    """

    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(query, *params)

    timestamps: list[str] = []
    seen_ts: set[str]     = set()
    means: dict[str, list] = {}

    for r in rows:
        ts  = r["ts"].isoformat()
        cid = str(r["cluster_id"])
        if ts not in seen_ts:
            timestamps.append(ts)
            seen_ts.add(ts)
        means.setdefault(cid, []).append(r["val"])

    return {"timestamps": timestamps, "cluster_means": means}


@app.get("/api/sensor-timeseries")
async def get_sensor_timeseries(
    request: Request,
    sensor_ids: str = Query(...),
):
    """Individual sensor time series. Max 200 sensors."""
    ids = [s.strip() for s in sensor_ids.split(",") if s.strip()]
    if len(ids) > 200:
        raise HTTPException(400, "Max 200 sensors per request")

    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT ts, sensor_id, temperature
            FROM temperatures
            WHERE sensor_id = ANY($1::text[])
            ORDER BY ts, sensor_id
            """,
            ids,
        )

    timestamps: list[str] = []
    seen_ts: set[str]     = set()
    sensors: dict[str, list] = {}

    for r in rows:
        ts  = r["ts"].isoformat()
        sid = r["sensor_id"]
        if ts not in seen_ts:
            timestamps.append(ts)
            seen_ts.add(ts)
        sensors.setdefault(sid, []).append(r["temperature"])

    return {"timestamps": timestamps, "sensors": sensors}


@app.get("/api/sensors-in-bbox")
async def get_sensors_in_bbox(
    request: Request,
    south: float = Query(...),
    west:  float = Query(...),
    north: float = Query(...),
    east:  float = Query(...),
    cluster_col: str = Query("cluster"),
    limit: int = Query(5000),
):
    col = validated_col(cluster_col)

    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT sensor_id, lat, lon,
                   stage1_cluster, stage2_subcluster, cluster
            FROM sensors
            WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            ORDER BY sensor_id
            LIMIT $5
            """,
            west, south, east, north, limit,
        )

    bc_map = request.app.state.building_cluster_map if col == "building_cluster" else None
    sensors: list[dict] = []
    for r in rows:
        s = dict(r)
        if bc_map is not None:
            s["building_cluster"] = bc_map.get(s["sensor_id"])
        sensors.append(s)

    counts: dict = {}
    for s in sensors:
        cid = str(s.get(cluster_col))
        counts[cid] = counts.get(cid, 0) + 1

    return {"sensors": sensors, "cluster_counts": counts, "truncated": len(rows) == limit}


@app.get("/api/map-cluster-profiles")
async def get_map_cluster_profiles(
    request: Request,
    sensor_ids:  str = Query(...),
    cluster_col: str = Query("cluster"),
):
    """Cluster mean profiles for a specific set of sensors (viewport analysis)."""
    col = validated_col(cluster_col)
    ids = [s.strip() for s in sensor_ids.split(",") if s.strip()]
    if not ids:
        raise HTTPException(400, "sensor_ids required")

    if col == "building_cluster":
        async with request.app.state.pool.acquire() as conn:
            return await _building_cluster_map_profiles(conn, request.app.state.building_cluster_map, ids)

    query = f"""
        SELECT
            t.ts,
            s.{col}::text                                               AS cluster_id,
            AVG(t.temperature)                                          AS val,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY t.temperature) AS q25,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY t.temperature) AS q75,
            COUNT(DISTINCT t.sensor_id)                                 AS sensor_count
        FROM temperatures t
        JOIN sensors s USING (sensor_id)
        WHERE t.sensor_id = ANY($1::text[])
        GROUP BY t.ts, s.{col}
        ORDER BY t.ts, s.{col}
    """

    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(query, ids)

    return reshape_profiles(rows)


@app.post("/api/custom-cluster-profiles")
async def custom_cluster_profiles(request: Request):
    """Compute cluster profiles from a caller-supplied sensor→cluster mapping (POST body).

    Body: { "mapping": {"sensor_id": cluster_int, ...} }
    Returns same shape as /api/cluster-profiles.
    """
    body = await request.json()
    raw = body.get("mapping", {})
    if not raw:
        return {"timestamps": [], "profiles": {}}
    mapping = {str(k): int(v) for k, v in raw.items() if v is not None}
    async with request.app.state.pool.acquire() as conn:
        return await _building_cluster_profiles(conn, mapping, None)


@app.post("/api/custom-timeseries-overview")
async def custom_timeseries_overview(request: Request):
    """Compute cluster means from a caller-supplied sensor→cluster mapping (POST body).

    Body: { "mapping": {"sensor_id": cluster_int, ...} }
    Returns same shape as /api/timeseries-overview.
    """
    body = await request.json()
    raw = body.get("mapping", {})
    if not raw:
        return {"timestamps": [], "cluster_means": {}}
    mapping = {str(k): int(v) for k, v in raw.items() if v is not None}
    async with request.app.state.pool.acquire() as conn:
        return await _building_cluster_means(conn, mapping, None)


@app.post("/api/building-geometries")
async def get_building_geometries(request: Request):
    """Return GeoJSON FeatureCollection for up to 50 buildings (POST body: {lm_building_ids: [...]})."""
    body = await request.json()
    ids = body.get("lm_building_ids", [])[:50]
    if not ids:
        return {"type": "FeatureCollection", "features": []}
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT ON (properties->>'lm_building_id')
                properties->>'lm_building_id' AS lm_building_id,
                ST_AsGeoJSON(ST_Transform(building_geom, 4326)) AS geom,
                MAX((properties->>'max_floor')::numeric)
                    OVER (PARTITION BY properties->>'lm_building_id') AS max_floor
            FROM sensors
            WHERE properties->>'lm_building_id' = ANY($1::text[])
              AND building_geom IS NOT NULL
            ORDER BY properties->>'lm_building_id'
            """,
            ids,
        )
    osm_heights = request.app.state.building_osm_heights
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": json.loads(r["geom"]),
                "properties": {
                    "lm_building_id": r["lm_building_id"],
                    "height": (
                        osm_heights.get(r["lm_building_id"])
                        or (float(r["max_floor"]) * 3.2 if r["max_floor"] else 10.0)
                    ),
                },
            }
            for r in rows if r["geom"]
        ],
    }


@app.post("/api/sensors-properties")
async def get_sensors_properties_batch(request: Request):
    """Batch fetch full properties for up to 500 sensors (POST body: {sensor_ids: [...]})."""
    body = await request.json()
    ids = body.get("sensor_ids", [])[:500]
    if not ids:
        return []
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT sensor_id, lat, lon, domain_code, area,
                   stage1_cluster, stage2_subcluster, cluster, properties
            FROM sensors
            WHERE sensor_id = ANY($1::text[])
            ORDER BY sensor_id
            """,
            ids,
        )
    bc_map = request.app.state.building_cluster_map
    return [
        {
            "sensor_id": r["sensor_id"],
            "lat": r["lat"],
            "lon": r["lon"],
            "domain_code": r["domain_code"],
            "area": r["area"],
            "stage1_cluster": r["stage1_cluster"],
            "stage2_subcluster": r["stage2_subcluster"],
            "cluster": r["cluster"],
            "building_cluster": bc_map.get(r["sensor_id"]),
            **(r["properties"] or {}),
        }
        for r in rows
    ]


_SAFE_FIELD = re.compile(r"^[a-zA-Z0-9_]+$")


@app.get("/api/filter-options")
async def get_filter_options(request: Request):
    """Return unique values for all low-cardinality sensor properties."""
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch("SELECT domain_code, area, properties FROM sensors")

    options: dict[str, set] = {}
    for r in rows:
        for col in ("domain_code", "area"):
            if r[col] is not None:
                options.setdefault(col, set()).add(r[col])
        for k, v in (r["properties"] or {}).items():
            if v is not None and not isinstance(v, (dict, list)):
                str_val = str(v).lower() if isinstance(v, bool) else str(v)
                options.setdefault(k, set()).add(str_val)

    # Only fields with 2–100 unique values are useful as filters
    return {k: sorted(v) for k, v in options.items() if 1 < len(v) <= 100}


@app.get("/api/filtered-sensor-ids")
async def get_filtered_sensor_ids(request: Request):
    """Return sensor_ids matching all supplied field=value1,value2 filters.

    Special parameters (not treated as value filters):
      min_building_floors=N  — only sensors in buildings where max(floor_df1) >= N
    """
    raw = {k: v for k, v in request.query_params.items() if v}

    # Extract special numeric filters before processing value filters
    min_building_floors_str = raw.pop("min_building_floors", None)
    min_building_floors: int | None = None
    if min_building_floors_str:
        try:
            min_building_floors = int(min_building_floors_str)
        except ValueError:
            raise HTTPException(400, "min_building_floors must be an integer")

    if not raw and min_building_floors is None:
        return {"sensor_ids": None}

    conditions: list[str] = []
    params: list = []

    for field, values_str in raw.items():
        if not _SAFE_FIELD.match(field):
            raise HTTPException(400, f"Invalid field name: {field}")
        values = [v for v in values_str.split(",") if v]
        if not values:
            continue
        params.append(values)
        idx = len(params)
        if field in ("domain_code", "area"):
            conditions.append(f"{field} = ANY(${idx}::text[])")
        else:
            conditions.append(f"properties->>'{field}' = ANY(${idx}::text[])")

    if min_building_floors is not None:
        params.append(min_building_floors)
        idx = len(params)
        conditions.append(f"""
            properties->>'lm_building_id' IN (
                SELECT properties->>'lm_building_id'
                FROM sensors
                WHERE properties->>'lm_building_id' IS NOT NULL
                GROUP BY properties->>'lm_building_id'
                HAVING MAX((properties->>'floor_df1')::numeric) >= ${idx}
            )
        """)

    if not conditions:
        return {"sensor_ids": None}

    query = "SELECT sensor_id FROM sensors WHERE " + " AND ".join(conditions)
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(query, *params)

    return {"sensor_ids": [r["sensor_id"] for r in rows]}


@app.get("/api/point-heights")
async def get_point_heights(request: Request):
    """Return per-sensor floor + building height data from the parquet export."""
    return request.app.state.point_heights


@app.get("/api/spread-positions")
async def get_spread_positions(request: Request):
    """Return pre-computed even-spread positions per sensor within building polygons."""
    return request.app.state.spread_positions


@app.get("/api/all-buildings")
async def get_all_buildings(request: Request):
    """Return all preloaded building footprints (GeoJSON FeatureCollection)."""
    return request.app.state.all_buildings


@app.get("/api/outdoor-climate")
async def get_outdoor_climate(year: int = Query(...)):
    """Return hourly outdoor climate data for Gothenburg for the given year.

    Reads from SMHI_MEASUREMENTS_DIR/year_{year}.parquet.
    Returns timestamps (ISO UTC strings) plus temperature (°C), humidity (%),
    and global_irradiation (W/m²). Missing values are returned as null.
    """
    import math
    parquet_path = os.path.join(SMHI_MEASUREMENTS_DIR, f"year_{year}.parquet")
    if not os.path.exists(parquet_path):
        raise HTTPException(404, f"No climate data for year {year}")
    try:
        df = pd.read_parquet(
            parquet_path,
            columns=["timestamp", "temperature", "humidity", "global_irradiation"],
        )
    except Exception as e:
        raise HTTPException(500, f"Failed to read climate data: {e}")

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.sort_values("timestamp")

    def _clean(v):
        return None if (v is None or (isinstance(v, float) and math.isnan(v))) else v

    return {
        "year": year,
        "timestamps": df["timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%SZ").tolist(),
        "temperature": [_clean(v) for v in df["temperature"].tolist()],
        "humidity":    [_clean(v) for v in df["humidity"].tolist()],
        "global_irradiation": [_clean(v) for v in df["global_irradiation"].tolist()],
    }


# ── Custom cluster columns (persisted) ───────────────────────────────────────

@app.get("/api/custom-cluster-cols")
async def list_custom_cluster_cols(request: Request):
    """Return all saved custom cluster column names and their sensor→cluster mappings."""
    return [
        {"name": name, "mapping": mapping}
        for name, mapping in request.app.state.custom_cluster_cols.items()
    ]


@app.put("/api/custom-cluster-cols/{name}")
async def upsert_custom_cluster_col(name: str, request: Request):
    """Save (insert or replace) a named custom cluster column mapping."""
    body = await request.json()
    mapping = body.get("mapping")
    if not isinstance(mapping, dict):
        raise HTTPException(400, "Body must be {\"mapping\": {sensor_id: cluster_int}}")
    # Validate: values must be integers
    try:
        clean = {str(k): int(v) for k, v in mapping.items()}
    except (TypeError, ValueError):
        raise HTTPException(400, "All mapping values must be integers")
    async with request.app.state.pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO custom_cluster_cols (name, cluster_mapping, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (name) DO UPDATE
              SET cluster_mapping = EXCLUDED.cluster_mapping,
                  updated_at = NOW()
            """,
            name, clean,
        )
    request.app.state.custom_cluster_cols[name] = clean
    return {"ok": True, "name": name, "count": len(clean)}


@app.get("/api/metadata-full")
async def get_metadata_full(request: Request):
    """All sensors with flattened JSONB properties for global metadata statistics.
    Returns every sensor regardless of viewport; GZip middleware compresses the response."""
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT sensor_id, domain_code, area, properties FROM sensors ORDER BY sensor_id"
        )
    return [
        {
            "sensor_id":   r["sensor_id"],
            "domain_code": r["domain_code"],
            "area":        r["area"],
            **(r["properties"] or {}),
        }
        for r in rows
    ]


@app.get("/api/outdoor-sensors")
async def get_outdoor_sensors(request: Request):
    """Locations of all outdoor sensors."""
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT sensor_id, lat, lon, properties FROM sensors WHERE sensor_type = 'outdoor' ORDER BY sensor_id"
        )
    return [
        {
            "sensor_id": r["sensor_id"],
            "lat": r["lat"],
            "lon": r["lon"],
            "address": (r["properties"] or {}).get("address"),
        }
        for r in rows
    ]


@app.get("/api/outdoor-timeseries")
async def get_outdoor_timeseries(request: Request, year: int = Query(...)):
    """Hourly outdoor sensor temperatures for a calendar year.
    15-minute data (e.g. 2023) is averaged to hourly server-side."""
    import datetime
    start = datetime.datetime(year, 1, 1, tzinfo=datetime.timezone.utc)
    end   = datetime.datetime(year + 1, 1, 1, tzinfo=datetime.timezone.utc)
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT date_trunc('hour', ts) AS hour,
                   t.sensor_id,
                   AVG(temperature)::double precision AS temperature
            FROM temperatures t
            JOIN sensors s USING (sensor_id)
            WHERE s.sensor_type = 'outdoor'
              AND ts >= $1 AND ts < $2
            GROUP BY 1, 2
            ORDER BY 1, 2
            """,
            start, end,
        )
    timestamps: list[str] = []
    seen_ts: set[str] = set()
    sensors: dict[str, list] = {}
    for r in rows:
        ts  = r["hour"].isoformat()
        sid = r["sensor_id"]
        if ts not in seen_ts:
            timestamps.append(ts)
            seen_ts.add(ts)
        sensors.setdefault(sid, []).append(r["temperature"])
    return {"timestamps": timestamps, "sensors": sensors}


# Pre-calculated degree-hour field names stored in sensors.properties
DH_FIELDS = [
    "dh_2018",
    "dh_2024",
    "dh_2025",
    "Kh above 26°C",
    "Kh above 27°C",
    "Kh above 28°C",
    "tc_h",
]


@app.get("/api/dh-fields")
async def get_dh_fields(request: Request):
    """Return pre-calculated degree-hour fields that have non-zero data."""
    async with request.app.state.pool.acquire() as conn:
        result = []
        for field in DH_FIELDS:
            count = await conn.fetchval(
                """
                SELECT COUNT(*) FROM sensors
                WHERE sensor_type != 'outdoor'
                  AND (properties->>$1)::double precision > 0
                """,
                field,
            )
            if count and count > 0:
                result.append({"field": field, "count": int(count)})
    return result


@app.get("/api/dh-data")
async def get_dh_data(request: Request, field: str = Query(...)):
    """Return per-sensor values for a pre-calculated degree-hours field."""
    if field not in DH_FIELDS:
        raise HTTPException(400, f"Unknown field. Allowed: {DH_FIELDS}")
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT sensor_id, lat, lon,
                   (properties->>$1)::double precision AS value,
                   properties->>'lm_building_id' AS lm_building_id
            FROM sensors
            WHERE sensor_type != 'outdoor'
              AND properties->>$1 IS NOT NULL
            ORDER BY sensor_id
            """,
            field,
        )
    return [
        {
            "sensor_id": r["sensor_id"],
            "lat": r["lat"],
            "lon": r["lon"],
            "value": r["value"] or 0.0,
            "lm_building_id": r["lm_building_id"],
        }
        for r in rows
        if r["lat"] is not None and r["lon"] is not None
    ]


@app.delete("/api/custom-cluster-cols/{name}")
async def delete_custom_cluster_col(name: str, request: Request):
    """Delete a saved custom cluster column."""
    async with request.app.state.pool.acquire() as conn:
        result = await conn.execute("DELETE FROM custom_cluster_cols WHERE name = $1", name)
    request.app.state.custom_cluster_cols.pop(name, None)
    if result == "DELETE 0":
        raise HTTPException(404, f"No custom column named '{name}'")
    return {"ok": True, "name": name}
