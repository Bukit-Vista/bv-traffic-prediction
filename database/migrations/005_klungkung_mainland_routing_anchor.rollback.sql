-- The production point already used this validated Semarapura anchor before
-- migration 005, so rollback preserves that pre-migration value.
UPDATE mobility_zones
   SET matrix_routing_point = ST_GeomFromText(
         'POINT(115.39737 -8.53443)',
         4326,
         'axis-order=long-lat'
       ),
       matrix_point_version = 'here-matrix-car-mainland-v2',
       matrix_coverage_scope = 'mainland_road_only',
       matrix_excluded_area_label = 'Nusa Penida',
       matrix_point_source = 'here:cm:namedplace:27356274|matrix:d0716cd4-0bab-4a0a-ab46-a530c35a8181',
       updated_at_utc = UTC_TIMESTAMP(3)
 WHERE zone_key = 'bali-klungkung';
