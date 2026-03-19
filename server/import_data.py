#!/usr/bin/env python
"""
One-time import: parquet files → TimescaleDB.

Usage:
    DATABASE_URL=postgresql://user:pass@localhost:5432/sensordb uv run python import_data.py
"""

import io
import os
import sys
from pathlib import Path

import duckdb
import pandas as pd
import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://localhost/sensor_explorer")
DATA_DIR = Path(__file__).parent.parent / "data"
TEMPERATURES_FILE = DATA_DIR / "temperatures_2019.parquet"
METADATA_FILE     = DATA_DIR / "meta_clusters_combined.parquet"

REAL_COLS = {"combined_name", "lat", "lon", "geometry",
             "stage1_cluster", "stage2_subcluster", "cluster",
             "domain_code", "area"}


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def apply_schema(conn):
    with open(Path(__file__).parent / "schema.sql") as f:
        schema = f.read()
    with conn.cursor() as cur:
        cur.execute(schema)
    conn.commit()
    print("Schema applied.")


def import_metadata(conn):
    print("Reading metadata parquet …")
    df = pd.read_parquet(METADATA_FILE)
    print(f"  {len(df)} rows, {len(df.columns)} columns")

    rows = []
    for _, row in df.iterrows():
        lat = row.get("lat")
        lon = row.get("lon")
        if pd.isna(lat) or pd.isna(lon):
            continue

        geom_hex = row.get("geometry")
        building_hex = str(geom_hex) if pd.notna(geom_hex) else None

        props = {}
        for col in df.columns:
            if col in REAL_COLS:
                continue
            v = row[col]
            props[col] = None if pd.isna(v) else (v.item() if hasattr(v, "item") else v)

        def si(col):
            v = row.get(col)
            return int(v) if pd.notna(v) else None

        def st(col):
            v = row.get(col)
            return str(v) if pd.notna(v) else None

        # tuple order must match the INSERT template exactly (14 %s)
        rows.append((
            str(row["combined_name"]),   # 1 sensor_id
            float(lon),                  # 2 ST_MakePoint arg1 (lon)
            float(lat),                  # 3 ST_MakePoint arg2 (lat)
            float(lat),                  # 4 lat column
            float(lon),                  # 5 lon column
            building_hex,               # 6 CASE WHEN IS NOT NULL
            building_hex,               # 7 ST_GeomFromEWKB hex
            si("stage1_cluster"),        # 8
            si("stage2_subcluster"),     # 9
            si("cluster"),               # 10
            st("domain_code"),           # 11
            st("area"),                  # 12
            psycopg2.extras.Json(props), # 13
        ))

    with conn.cursor() as cur:
        cur.execute("TRUNCATE sensors CASCADE")
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO sensors
                (sensor_id, geom, lat, lon, building_geom,
                 stage1_cluster, stage2_subcluster, cluster,
                 domain_code, area, properties)
            VALUES %s
            ON CONFLICT (sensor_id) DO NOTHING
            """,
            rows,
            template="""(
                %s,
                ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                %s, %s,
                CASE WHEN %s IS NOT NULL
                     THEN ST_GeomFromEWKB(decode(%s, 'hex'))
                     ELSE NULL END,
                %s, %s, %s, %s, %s, %s
            )""",
        )
    conn.commit()
    print(f"  Imported {len(rows)} sensors.")
    return {r[0] for r in rows}


def import_temperatures(conn, valid_sensor_ids):
    print("Reading temperatures parquet …")
    duck = duckdb.connect()

    cols = duck.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{TEMPERATURES_FILE}')"
    ).fetchdf()["column_name"].tolist()

    time_col    = "__index_level_0__"
    sensor_cols = [c for c in cols if c != time_col and c in valid_sensor_ids]

    n_ts = duck.execute(
        f"SELECT COUNT(*) FROM read_parquet('{TEMPERATURES_FILE}')"
    ).fetchone()[0]
    print(f"  {n_ts} timestamps × {len(sensor_cols)} sensors → "
          f"~{n_ts * len(sensor_cols):,} rows")

    with conn.cursor() as cur:
        cur.execute("TRUNCATE temperatures")
    conn.commit()

    CHUNK = 50
    inserted = 0

    with conn.cursor() as cur:
        for i in range(0, len(sensor_cols), CHUNK):
            batch = sensor_cols[i : i + CHUNK]
            cols_sql = ", ".join(f'"{c}"' for c in batch)

            df = duck.execute(
                f'SELECT "{time_col}", {cols_sql} '
                f"FROM read_parquet('{TEMPERATURES_FILE}')"
            ).fetchdf()

            df_long = (
                df.melt(
                    id_vars=[time_col],
                    value_vars=batch,
                    var_name="sensor_id",
                    value_name="temperature",
                )
                .dropna(subset=["temperature"])
            )
            df_long[time_col] = pd.to_datetime(df_long[time_col], utc=True)

            buf = io.StringIO()
            df_long[[time_col, "sensor_id", "temperature"]].to_csv(
                buf, index=False, header=False
            )
            buf.seek(0)
            cur.copy_expert(
                "COPY temperatures (ts, sensor_id, temperature) FROM STDIN WITH CSV",
                buf,
            )
            inserted += len(df_long)
            print(
                f"  batch {i // CHUNK + 1}/{-(-len(sensor_cols) // CHUNK)}  "
                f"({inserted:,} rows so far)",
                end="\r",
            )

    conn.commit()
    duck.close()
    print(f"\n  Done. {inserted:,} rows inserted.")


def main():
    for f in (TEMPERATURES_FILE, METADATA_FILE):
        if not f.exists():
            print(f"ERROR: {f} not found")
            sys.exit(1)

    print(f"Connecting to {DATABASE_URL} …")
    conn = get_conn()
    apply_schema(conn)
    valid_ids = import_metadata(conn)
    import_temperatures(conn, valid_ids)
    conn.close()
    print("Import complete.")


if __name__ == "__main__":
    main()
