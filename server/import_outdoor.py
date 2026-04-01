#!/usr/bin/env python
"""
Import outdoor temperature sensors and their timeseries data (2016-2025).

Sensors are upserted into the existing `sensors` table with sensor_type='outdoor'.
Temperatures are loaded year-by-year into the existing `temperatures` table.
Existing outdoor rows for each year are replaced; indoor data is untouched.

Usage:
    DATABASE_URL=postgresql://localhost/sensor_explorer uv run python import_outdoor.py
    DATABASE_URL=... uv run python import_outdoor.py --years 2019 2020
"""

import io
import os
import sys
from pathlib import Path

import duckdb
import pandas as pd
import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://localhost/sensor_explorer"
)

COORDS_FILE = Path(
    "/Users/matsp/phd-python-projects/indoor_overheat/data/db_metadata"
    "/outdoor_coordinates/node_ids_coords_2026_04_01.csv"
)
DATA_BASE = Path("/Users/matsp/phd-python-projects/indoor_overheat/data/H")
ALL_YEARS  = list(range(2016, 2026))
TIME_COL   = "__index_level_0__"


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def apply_schema(conn):
    schema_path = Path(__file__).parent / "schema.sql"
    with open(schema_path) as f:
        conn.cursor().execute(f.read())
    conn.commit()
    print("Schema up to date.")


def import_sensors(conn) -> set[str]:
    print(f"Reading coordinates from {COORDS_FILE.name} …")
    df = pd.read_csv(COORDS_FILE, sep=";")
    print(f"  {len(df)} outdoor sensors")

    rows = []
    for _, row in df.iterrows():
        sensor_id = str(row["combined_name"]).strip()
        lat = float(row["lat"])
        lon = float(row["lon"])
        props = {
            "is_outdoor": True,
            "address": str(row["address"]) if pd.notna(row.get("address")) else None,
        }
        rows.append((
            sensor_id,
            lon, lat,   # ST_MakePoint(lon, lat)
            lat, lon,   # lat / lon columns
            psycopg2.extras.Json(props),
        ))

    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO sensors (sensor_id, geom, lat, lon, sensor_type, properties)
            VALUES %s
            ON CONFLICT (sensor_id) DO UPDATE SET
                lat         = EXCLUDED.lat,
                lon         = EXCLUDED.lon,
                sensor_type = 'outdoor',
                properties  = sensors.properties || EXCLUDED.properties
            """,
            rows,
            template=(
                "(%s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s, %s, 'outdoor', %s)"
            ),
        )
    conn.commit()
    print(f"  Upserted {len(rows)} outdoor sensors.")
    return {r[0] for r in rows}


def import_temperatures(conn, valid_ids: set[str], years: list[int]) -> None:
    for year in years:
        parquet = DATA_BASE / str(year) / "outdoor" / "temp_data_avg.parquet"
        if not parquet.exists():
            print(f"  {year}: parquet not found — skipping")
            continue

        duck = duckdb.connect()
        cols = duck.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{parquet}')"
        ).fetchdf()["column_name"].tolist()

        sensor_cols = [c for c in cols if c != TIME_COL and c in valid_ids]
        if not sensor_cols:
            print(f"  {year}: no matching sensors in parquet — skipping")
            duck.close()
            continue

        n_ts = duck.execute(
            f"SELECT COUNT(*) FROM read_parquet('{parquet}')"
        ).fetchone()[0]
        print(
            f"  {year}: {n_ts} timestamps × {len(sensor_cols)} sensors "
            f"→ ~{n_ts * len(sensor_cols):,} rows"
        )

        # Remove existing rows for these sensors in this calendar year
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM temperatures "
                "WHERE sensor_id = ANY(%s) AND ts >= %s AND ts < %s",
                (list(sensor_cols), f"{year}-01-01", f"{year + 1}-01-01"),
            )
        conn.commit()

        CHUNK = 20
        inserted = 0

        with conn.cursor() as cur:
            for i in range(0, len(sensor_cols), CHUNK):
                batch = sensor_cols[i : i + CHUNK]
                cols_sql = ", ".join(f'"{c}"' for c in batch)

                df = duck.execute(
                    f'SELECT "{TIME_COL}", {cols_sql} '
                    f"FROM read_parquet('{parquet}')"
                ).fetchdf()

                df_long = (
                    df.melt(
                        id_vars=[TIME_COL],
                        value_vars=batch,
                        var_name="sensor_id",
                        value_name="temperature",
                    )
                    .dropna(subset=["temperature"])
                )
                df_long[TIME_COL] = pd.to_datetime(df_long[TIME_COL], utc=True)

                buf = io.StringIO()
                df_long[[TIME_COL, "sensor_id", "temperature"]].to_csv(
                    buf, index=False, header=False
                )
                buf.seek(0)
                cur.copy_expert(
                    "COPY temperatures (ts, sensor_id, temperature) FROM STDIN WITH CSV",
                    buf,
                )
                inserted += len(df_long)
                print(
                    f"    chunk {i // CHUNK + 1}/{-(-len(sensor_cols) // CHUNK)}"
                    f"  ({inserted:,} rows so far)",
                    end="\r",
                )

        conn.commit()
        duck.close()
        print(f"\n    {year} done — {inserted:,} rows inserted.")


def main():
    years = ALL_YEARS
    if "--years" in sys.argv:
        idx = sys.argv.index("--years")
        years = [int(y) for y in sys.argv[idx + 1 :] if y.isdigit()]

    if not COORDS_FILE.exists():
        print(f"ERROR: coordinates file not found:\n  {COORDS_FILE}")
        sys.exit(1)

    print(f"Connecting to {DATABASE_URL} …")
    conn = get_conn()
    apply_schema(conn)
    valid_ids = import_sensors(conn)

    print(f"\nImporting temperatures for years: {years}")
    import_temperatures(conn, valid_ids, years)

    conn.close()
    print("\nOutdoor import complete.")


if __name__ == "__main__":
    main()
