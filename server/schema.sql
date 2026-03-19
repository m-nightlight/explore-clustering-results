CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
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
    properties          JSONB NOT NULL DEFAULT '{}'
);

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

SELECT create_hypertable(
    'temperatures', 'ts',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_temp_sensor ON temperatures (sensor_id, ts DESC);

-- Compression: beneficial once data is loaded
ALTER TABLE temperatures SET (
    timescaledb.compress,
    timescaledb.compress_orderby     = 'ts DESC',
    timescaledb.compress_segmentby   = 'sensor_id'
);
