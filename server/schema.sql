CREATE EXTENSION IF NOT EXISTS postgis CASCADE;

CREATE TABLE IF NOT EXISTS sensors (
    sensor_id           TEXT PRIMARY KEY,
    lat                 DOUBLE PRECISION NOT NULL,
    lon                 DOUBLE PRECISION NOT NULL,
    geom                GEOMETRY(Point, 4326),
    building_geom       GEOMETRY(MultiPolygon, 3007),
    stage1_cluster      SMALLINT,
    stage2_subcluster   SMALLINT,
    cluster             SMALLINT,
    domain_code         TEXT,
    area                TEXT,
    sensor_type         TEXT NOT NULL DEFAULT 'indoor',
    properties          JSONB NOT NULL DEFAULT '{}'
);

-- Add sensor_type to existing deployments that pre-date this column
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS sensor_type TEXT NOT NULL DEFAULT 'indoor';

CREATE INDEX IF NOT EXISTS idx_sensors_geom    ON sensors USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_sensors_cluster ON sensors (cluster);
CREATE INDEX IF NOT EXISTS idx_sensors_stage1  ON sensors (stage1_cluster);
CREATE INDEX IF NOT EXISTS idx_sensors_stage2  ON sensors (stage2_subcluster);
CREATE INDEX IF NOT EXISTS idx_sensors_props   ON sensors USING GIN (properties);

CREATE TABLE IF NOT EXISTS temperatures (
    ts          TIMESTAMPTZ      NOT NULL,
    sensor_id   TEXT             NOT NULL REFERENCES sensors(sensor_id),
    temperature DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_temp_sensor ON temperatures (sensor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_temp_ts     ON temperatures (ts DESC);

CREATE TABLE IF NOT EXISTS custom_cluster_cols (
    name            TEXT PRIMARY KEY,
    cluster_mapping JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Pre-aggregated cluster profiles (mean/q25/q75 per ts × cluster column × cluster id).
-- Used by /api/cluster-profiles (non-median) and /api/timeseries-overview for fast reads.
-- Refresh with: REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cluster_profiles;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cluster_profiles AS
SELECT
    t.ts,
    u.cluster_col,
    u.cluster_id::text                                           AS cluster_id,
    AVG(t.temperature)                                           AS val,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY t.temperature)  AS q25,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY t.temperature)  AS q75,
    COUNT(DISTINCT t.sensor_id)                                  AS sensor_count
FROM temperatures t
JOIN sensors s USING (sensor_id)
JOIN LATERAL (VALUES
    ('cluster',            s.cluster::int),
    ('stage1_cluster',     s.stage1_cluster::int),
    ('stage2_subcluster',  s.stage2_subcluster::int)
) AS u(cluster_col, cluster_id) ON u.cluster_id IS NOT NULL
GROUP BY t.ts, u.cluster_col, u.cluster_id
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_cluster_profiles
    ON mv_cluster_profiles (cluster_col, cluster_id, ts DESC);

-- After creating, populate once:
-- REFRESH MATERIALIZED VIEW mv_cluster_profiles;
