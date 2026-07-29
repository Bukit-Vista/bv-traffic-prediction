-- Versioned normalized Flow history contract for the 12-hour MVP.
-- Apply only through the database-owned migration process after the A7 soak.
-- The web application account must receive SELECT on this view only.

CREATE OR REPLACE SQL SECURITY DEFINER VIEW api_traffic_flow_history_v1 AS
SELECT
  s.id AS segment_id,
  s.segment_key,
  s.road_name,
  s.functional_class,
  ST_AsGeoJSON(s.geometry) AS geometry_geojson,
  o.id AS observation_id,
  o.collection_slot_utc,
  o.source_updated_utc,
  o.fetched_at_utc,
  o.speed_kph,
  o.free_flow_kph,
  o.relative_speed,
  o.jam_factor,
  o.jam_tendency,
  o.confidence,
  o.traversability,
  o.road_closure
FROM traffic_road_segments s
JOIN traffic_flow_observations o ON o.segment_id = s.id
WHERE ST_SRID(s.geometry) = 4326;
