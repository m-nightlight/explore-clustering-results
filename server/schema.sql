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
