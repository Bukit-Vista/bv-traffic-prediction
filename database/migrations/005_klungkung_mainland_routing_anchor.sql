-- Klungkung Regency includes Nusa Penida, which places its geometric centroid
-- offshore. Preserve that administrative centroid and use the validated HERE
-- Semarapura point for road routing.

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
       matrix_point_validated_at_utc = UTC_TIMESTAMP(3),
       updated_at_utc = UTC_TIMESTAMP(3)
 WHERE zone_key = 'bali-klungkung';
