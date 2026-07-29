-- Step 3 application read contracts. Apply through the database-owned migration
-- process; the application account must retain SELECT-only privileges.

CREATE OR REPLACE SQL SECURITY DEFINER VIEW api_airport_route_history_v1 AS
SELECT
  s.route_id,
  s.id AS route_sample_id,
  r.route_group_key,
  r.tourism_center_key,
  r.route_direction,
  s.collection_slot_utc,
  s.sampled_at_utc,
  s.distance_meters,
  s.current_duration_seconds,
  s.typical_duration_seconds,
  s.base_duration_seconds,
  s.delay_vs_typical_seconds,
  s.delay_vs_base_seconds,
  s.ratio_vs_typical,
  s.ratio_vs_base,
  s.http_status
FROM route_samples s
JOIN routes r ON r.id = s.route_id
WHERE r.active = 1
  AND r.route_purpose = 'airport_tourism'
  AND s.provider = 'here';

CREATE OR REPLACE SQL SECURITY DEFINER VIEW api_airport_route_geometry_v1 AS
SELECT
  s.route_id,
  s.id AS route_sample_id,
  s.collection_slot_utc,
  g.section_index,
  ST_AsGeoJSON(g.geometry) AS geometry_geojson,
  ST_NumPoints(g.geometry) AS point_count
FROM route_samples s
JOIN routes r ON r.id = s.route_id
JOIN route_sample_geometries g ON g.route_sample_id = s.id
WHERE r.active = 1
  AND r.route_purpose = 'airport_tourism'
  AND s.provider = 'here'
  AND ST_SRID(g.geometry) = 4326;
