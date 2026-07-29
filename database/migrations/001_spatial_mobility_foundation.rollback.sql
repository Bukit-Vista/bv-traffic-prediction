-- Destructive rollback. Back up data before applying.
DROP TABLE IF EXISTS mobility_od_predictions;
DROP TABLE IF EXISTS mobility_zone_predictions;
DROP TABLE IF EXISTS mobility_zone_features;
DROP TABLE IF EXISTS mobility_model_runs;
DROP TABLE IF EXISTS mobility_model_versions;
DROP TABLE IF EXISTS mobility_zone_road_segments;
DROP TABLE IF EXISTS activity_centers;
DROP TABLE IF EXISTS population_cells;
DROP TABLE IF EXISTS mobility_zones;
DROP TABLE IF EXISTS traffic_flow_latest;
DROP TABLE IF EXISTS traffic_incident_geometries;
DROP TABLE IF EXISTS route_sample_geometries;
