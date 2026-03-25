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


async def init_conn(conn):
    await conn.set_type_codec(
        "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(_parse_dsn_for_asyncpg(DATABASE_URL), init=init_conn)
    try:
        df = pd.read_parquet(POINT_HEIGHTS_PARQUET, columns=["id", "lat", "lon", "floor", "lm_height", "lm_max_floor"])
        df = df.dropna(subset=["id"]).drop_duplicates(subset=["id"])
        df["floor"] = df["floor"].clip(lower=0, upper=df["lm_max_floor"].fillna(1))
        df = df.set_index("id")
        # astype(object) first so NaN stays as Python None after .where()
        df = df.astype(object).where(df.notna(), other=None)
        app.state.point_heights = df.to_dict("index")
    except Exception as e:
        print(f"Warning: could not load point heights from parquet: {e}")
        app.state.point_heights = {}
    yield
    await app.state.pool.close()


app = FastAPI(lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
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
    col = CLUSTER_COLS.get(cluster_col)
    if not col:
        raise HTTPException(400, f"Invalid cluster_col. Choose from: {list(CLUSTER_COLS)}")
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
    return [
        {
            "sensor_id":         r["sensor_id"],
            "lat":               r["lat"],
            "lon":               r["lon"],
            "stage1_cluster":    r["stage1_cluster"],
            "stage2_subcluster": r["stage2_subcluster"],
            "cluster":           r["cluster"],
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

    sensors     = [dict(r) for r in rows]
    counts: dict = {}
    for s in sensors:
        cid = str(s[cluster_col])
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
                ST_AsGeoJSON(ST_Transform(building_geom, 4326)) AS geom
            FROM sensors
            WHERE properties->>'lm_building_id' = ANY($1::text[])
              AND building_geom IS NOT NULL
            ORDER BY properties->>'lm_building_id'
            """,
            ids,
        )
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": json.loads(r["geom"]),
                "properties": {"lm_building_id": r["lm_building_id"]},
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
