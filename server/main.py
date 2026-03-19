import json
import os
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://localhost/sensor_explorer")

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
    app.state.pool = await asyncpg.create_pool(DATABASE_URL, init=init_conn)
    yield
    await app.state.pool.close()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
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
    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT sensor_id, lat, lon,
                   stage1_cluster, stage2_subcluster, cluster,
                   domain_code, area, properties
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
            **(r["properties"] or {}),
        }
        for r in rows
    ]


@app.get("/api/cluster-profiles")
async def get_cluster_profiles(
    request: Request,
    cluster_col: str = Query("cluster"),
    clusters:    str = Query(None),
    agg:         str = Query("mean"),   # "mean" | "median"
):
    col          = validated_col(cluster_col)
    cluster_list = parse_clusters(clusters)

    if agg == "median":
        agg_expr = "PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.temperature)"
    else:
        agg_expr = "AVG(t.temperature)"

    # col is from a whitelist — safe to interpolate
    query = f"""
        SELECT
            t.ts,
            s.{col}::text                                               AS cluster_id,
            {agg_expr}                                                  AS val,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY t.temperature) AS q25,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY t.temperature) AS q75,
            COUNT(DISTINCT t.sensor_id)                                 AS sensor_count
        FROM temperatures t
        JOIN sensors s USING (sensor_id)
        {"WHERE s." + col + " = ANY($1::smallint[])" if cluster_list else ""}
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
    """Cluster means only — lighter version of cluster-profiles for the main chart."""
    col          = validated_col(cluster_col)
    cluster_list = parse_clusters(clusters)

    query = f"""
        SELECT
            t.ts,
            s.{col}::text       AS cluster_id,
            AVG(t.temperature)  AS val
        FROM temperatures t
        JOIN sensors s USING (sensor_id)
        {"WHERE s." + col + " = ANY($1::smallint[])" if cluster_list else ""}
        GROUP BY t.ts, s.{col}
        ORDER BY t.ts, s.{col}
    """

    async with request.app.state.pool.acquire() as conn:
        rows = await conn.fetch(query, *([cluster_list] if cluster_list else []))

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
            """,
            west, south, east, north,
        )

    sensors     = [dict(r) for r in rows]
    counts: dict = {}
    for s in sensors:
        cid = str(s[cluster_col])
        counts[cid] = counts.get(cid, 0) + 1

    return {"sensors": sensors, "cluster_counts": counts}


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
