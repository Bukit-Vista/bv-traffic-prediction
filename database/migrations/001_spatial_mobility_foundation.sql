-- Bali Traffic + Predicted Mobility spatial foundation (MySQL 8.0.44+)
-- Apply with the n8n/write account. The web application account remains read-only.

CREATE TABLE IF NOT EXISTS route_sample_geometries (
    route_sample_id BIGINT NOT NULL,
    encoded_flexible_polyline TEXT NULL,
    geometry GEOMETRY NOT NULL SRID 4326,
    created_at_utc DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (route_sample_id),
    SPATIAL INDEX sx_route_sample_geometries_geometry (geometry),
    CONSTRAINT fk_route_sample_geometries_sample
        FOREIGN KEY (route_sample_id) REFERENCES route_samples(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS traffic_incident_geometries (
    incident_id BIGINT NOT NULL,
    geometry GEOMETRY NOT NULL SRID 4326,
    PRIMARY KEY (incident_id),
    SPATIAL INDEX sx_traffic_incident_geometries_geometry (geometry),
    CONSTRAINT fk_traffic_incident_geometries_incident
        FOREIGN KEY (incident_id) REFERENCES traffic_incidents(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS traffic_flow_latest (
    segment_id BIGINT NOT NULL,
    observation_id BIGINT NOT NULL,
    observed_at_utc DATETIME NOT NULL,
    PRIMARY KEY (segment_id),
    UNIQUE KEY uq_traffic_flow_latest_observation (observation_id),
    KEY ix_traffic_flow_latest_observed (observed_at_utc),
    CONSTRAINT fk_traffic_flow_latest_segment
        FOREIGN KEY (segment_id) REFERENCES traffic_road_segments(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_traffic_flow_latest_observation
        FOREIGN KEY (observation_id) REFERENCES traffic_flow_observations(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mobility_zones (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    zone_key VARCHAR(32) NOT NULL,
    name VARCHAR(160) NULL,
    zone_type VARCHAR(32) NOT NULL DEFAULT 'hex_1km',
    regency_name VARCHAR(120) NULL,
    district_name VARCHAR(120) NULL,
    resident_population DECIMAL(14,2) NULL,
    population_source VARCHAR(80) NULL,
    population_vintage SMALLINT NULL,
    centroid POINT NOT NULL SRID 4326,
    geometry POLYGON NOT NULL SRID 4326,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_mobility_zones_key (zone_key),
    SPATIAL INDEX sx_mobility_zones_centroid (centroid),
    SPATIAL INDEX sx_mobility_zones_geometry (geometry)
);

CREATE TABLE IF NOT EXISTS population_cells (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    zone_id BIGINT UNSIGNED NULL,
    source VARCHAR(80) NOT NULL,
    dataset_version VARCHAR(80) NOT NULL,
    population_vintage SMALLINT NOT NULL,
    estimated_population DECIMAL(14,4) NOT NULL,
    geometry POLYGON NOT NULL SRID 4326,
    PRIMARY KEY (id),
    KEY ix_population_cells_zone (zone_id, population_vintage),
    SPATIAL INDEX sx_population_cells_geometry (geometry),
    CONSTRAINT fk_population_cells_zone
        FOREIGN KEY (zone_id) REFERENCES mobility_zones(id)
);

CREATE TABLE IF NOT EXISTS activity_centers (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    zone_id BIGINT UNSIGNED NOT NULL,
    external_key VARCHAR(160) NULL,
    name VARCHAR(200) NOT NULL,
    category VARCHAR(80) NOT NULL,
    source VARCHAR(80) NOT NULL,
    base_attraction_weight DECIMAL(8,4) NOT NULL DEFAULT 1,
    location POINT NOT NULL SRID 4326,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (id),
    UNIQUE KEY uq_activity_centers_source_key (source, external_key),
    KEY ix_activity_centers_zone (zone_id, category),
    SPATIAL INDEX sx_activity_centers_location (location),
    CONSTRAINT fk_activity_centers_zone
        FOREIGN KEY (zone_id) REFERENCES mobility_zones(id)
);

CREATE TABLE IF NOT EXISTS mobility_zone_road_segments (
    zone_id BIGINT UNSIGNED NOT NULL,
    segment_id BIGINT NOT NULL,
    overlap_meters DECIMAL(12,2) NOT NULL,
    aggregation_weight DECIMAL(12,8) NOT NULL,
    PRIMARY KEY (zone_id, segment_id),
    KEY ix_zone_road_segments_segment (segment_id),
    CONSTRAINT fk_zone_road_segments_zone
        FOREIGN KEY (zone_id) REFERENCES mobility_zones(id),
    CONSTRAINT fk_zone_road_segments_segment
        FOREIGN KEY (segment_id) REFERENCES traffic_road_segments(id)
);

CREATE TABLE IF NOT EXISTS mobility_model_versions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    version VARCHAR(40) NOT NULL,
    algorithm VARCHAR(80) NOT NULL,
    parameters_json JSON NOT NULL,
    feature_schema_json JSON NOT NULL,
    description TEXT NULL,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_mobility_model_versions_version (version)
);

CREATE TABLE IF NOT EXISTS mobility_model_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    model_version_id BIGINT UNSIGNED NOT NULL,
    flow_collection_run_id BIGINT NULL,
    prediction_for_utc DATETIME NOT NULL,
    started_at_utc DATETIME(3) NOT NULL,
    completed_at_utc DATETIME(3) NULL,
    status ENUM('running','success','partial','failed') NOT NULL,
    zone_count INT UNSIGNED NOT NULL DEFAULT 0,
    od_count INT UNSIGNED NOT NULL DEFAULT 0,
    input_coverage DECIMAL(6,5) NULL,
    suppressed_candidate_count INT UNSIGNED NOT NULL DEFAULT 0,
    error_message TEXT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_mobility_model_run_bucket_version
        (prediction_for_utc, model_version_id),
    KEY ix_mobility_model_runs_status_time (status, prediction_for_utc),
    CONSTRAINT fk_mobility_model_runs_version
        FOREIGN KEY (model_version_id) REFERENCES mobility_model_versions(id),
    CONSTRAINT fk_mobility_model_runs_flow_run
        FOREIGN KEY (flow_collection_run_id) REFERENCES traffic_flow_collection_runs(id)
);

CREATE TABLE IF NOT EXISTS mobility_zone_features (
    model_run_id BIGINT UNSIGNED NOT NULL,
    zone_id BIGINT UNSIGNED NOT NULL,
    time_bucket_utc DATETIME NOT NULL,
    population_potential DECIMAL(8,5) NOT NULL,
    attraction_score DECIMAL(8,5) NOT NULL,
    accessibility_score DECIMAL(8,5) NOT NULL,
    traffic_activity_score DECIMAL(8,5) NOT NULL,
    incident_penalty DECIMAL(8,5) NOT NULL,
    temporal_factor DECIMAL(8,5) NOT NULL,
    mean_jam_factor DECIMAL(6,3) NULL,
    mean_speed_kph DECIMAL(8,3) NULL,
    traffic_confidence DECIMAL(6,5) NULL,
    feature_coverage DECIMAL(6,5) NOT NULL,
    PRIMARY KEY (model_run_id, zone_id),
    KEY ix_mobility_zone_features_zone_time (zone_id, time_bucket_utc),
    CONSTRAINT fk_mobility_zone_features_run
        FOREIGN KEY (model_run_id) REFERENCES mobility_model_runs(id),
    CONSTRAINT fk_mobility_zone_features_zone
        FOREIGN KEY (zone_id) REFERENCES mobility_zones(id)
);

CREATE TABLE IF NOT EXISTS mobility_zone_predictions (
    model_run_id BIGINT UNSIGNED NOT NULL,
    zone_id BIGINT UNSIGNED NOT NULL,
    time_bucket_utc DATETIME NOT NULL,
    presence_score DECIMAL(5,2) NOT NULL,
    inbound_score DECIMAL(5,2) NOT NULL,
    outbound_score DECIMAL(5,2) NOT NULL,
    hotspot_rank INT UNSIGNED NULL,
    confidence DECIMAL(6,5) NOT NULL,
    PRIMARY KEY (model_run_id, zone_id),
    KEY ix_zone_predictions_time_presence (time_bucket_utc, presence_score),
    KEY ix_zone_predictions_zone_time (zone_id, time_bucket_utc),
    CONSTRAINT fk_zone_predictions_run
        FOREIGN KEY (model_run_id) REFERENCES mobility_model_runs(id),
    CONSTRAINT fk_zone_predictions_zone
        FOREIGN KEY (zone_id) REFERENCES mobility_zones(id),
    CONSTRAINT ck_zone_prediction_scores CHECK (
        presence_score BETWEEN 0 AND 100
        AND inbound_score BETWEEN 0 AND 100
        AND outbound_score BETWEEN 0 AND 100
        AND confidence BETWEEN 0 AND 1
    )
);

CREATE TABLE IF NOT EXISTS mobility_od_predictions (
    model_run_id BIGINT UNSIGNED NOT NULL,
    origin_zone_id BIGINT UNSIGNED NOT NULL,
    destination_zone_id BIGINT UNSIGNED NOT NULL,
    time_bucket_utc DATETIME NOT NULL,
    raw_flow_weight DECIMAL(20,8) NOT NULL,
    mobility_score DECIMAL(5,2) NOT NULL,
    predicted_share DECIMAL(10,9) NOT NULL,
    travel_time_seconds INT UNSIGNED NULL,
    distance_meters INT UNSIGNED NULL,
    confidence DECIMAL(6,5) NOT NULL,
    PRIMARY KEY (model_run_id, origin_zone_id, destination_zone_id),
    KEY ix_od_predictions_time_score (time_bucket_utc, mobility_score),
    KEY ix_od_predictions_origin_time (origin_zone_id, time_bucket_utc),
    KEY ix_od_predictions_destination_time
        (destination_zone_id, time_bucket_utc),
    CONSTRAINT fk_od_predictions_run
        FOREIGN KEY (model_run_id) REFERENCES mobility_model_runs(id),
    CONSTRAINT fk_od_predictions_origin
        FOREIGN KEY (origin_zone_id) REFERENCES mobility_zones(id),
    CONSTRAINT fk_od_predictions_destination
        FOREIGN KEY (destination_zone_id) REFERENCES mobility_zones(id),
    CONSTRAINT ck_od_prediction_values CHECK (
        origin_zone_id <> destination_zone_id
        AND mobility_score BETWEEN 0 AND 100
        AND predicted_share BETWEEN 0 AND 1
        AND confidence BETWEEN 0 AND 1
    )
);

