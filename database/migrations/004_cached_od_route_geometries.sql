-- Cached HERE road paths for directional mobility OD relationships.
-- Populate through the external collection workflow; the web application only reads it.

CREATE TABLE IF NOT EXISTS mobility_od_route_geometries (
    -- Match the production mobility_zones.id type exactly. MySQL requires
    -- foreign-key columns to have identical signedness.
    origin_zone_id BIGINT NOT NULL,
    destination_zone_id BIGINT NOT NULL,
    provider VARCHAR(24) NOT NULL DEFAULT 'here',
    transport_mode VARCHAR(24) NOT NULL DEFAULT 'car',
    encoded_flexible_polyline MEDIUMTEXT NOT NULL,
    geometry LINESTRING NOT NULL SRID 4326,
    point_count INT UNSIGNED NOT NULL,
    distance_meters INT UNSIGNED NULL,
    duration_seconds INT UNSIGNED NULL,
    fetched_at_utc DATETIME(3) NOT NULL,
    expires_at_utc DATETIME(3) NULL,
    PRIMARY KEY (origin_zone_id, destination_zone_id),
    SPATIAL INDEX sx_mobility_od_route_geometry (geometry),
    KEY ix_mobility_od_route_expiry (expires_at_utc),
    CONSTRAINT fk_mobility_od_route_origin
        FOREIGN KEY (origin_zone_id) REFERENCES mobility_zones(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_mobility_od_route_destination
        FOREIGN KEY (destination_zone_id) REFERENCES mobility_zones(id)
        ON DELETE CASCADE,
    CONSTRAINT ck_mobility_od_route_direction CHECK (
        origin_zone_id <> destination_zone_id
    )
);
