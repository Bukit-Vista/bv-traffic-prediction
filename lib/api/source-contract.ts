import { ApiUnavailableError } from "@/lib/api/core";
import { queryRows, type QueryRows } from "@/lib/db/mysql";
import { withRedisJsonCache } from "@/lib/cache/redis-json";

export type SourceContractCheck = { key: string; ok: boolean; detail: string };

const SERVING_VIEW_COLUMNS: Record<string, string[]> = {
  api_mobility_scope_v1: ["scope_key", "scope_version", "prediction_enabled", "status", "disclaimer", "freshness_policy_json", "blocking_policy_json"],
  api_airport_destinations_v1: ["scope_key", "scope_version", "destination_key", "route_group_key", "display_order", "active"],
  api_airport_tourism_routes_v1: ["route_id", "route_group_key", "tourism_center_key", "route_direction", "display_order"],
  api_airport_route_latest_v1: ["route_id", "route_sample_id", "collection_slot_utc", "current_duration_seconds", "typical_duration_seconds", "ratio_vs_typical"],
  api_airport_route_slots_v1: ["collection_slot_utc", "observed_route_count", "successful_route_count", "average_ratio_vs_typical"],
  api_traffic_flow_latest_v1: ["segment_id", "segment_key", "geometry_geojson", "collection_slot_utc", "jam_factor", "confidence"],
  api_source_status_v1: ["dataset", "run_id", "collection_slot_utc", "status", "expected_count", "successful_count", "record_count"],
  api_collector_alert_state_v1: ["dataset", "run_id", "collection_slot_utc", "status", "coverage_ratio", "freshness_state", "health_state", "alert_code", "is_stale", "is_stuck"],
  api_flow_run_history_v1: ["dataset", "run_id", "collection_slot_utc", "status", "coverage_ratio", "retry_count", "http_429_count", "duration_seconds"],
  api_route_run_history_v1: ["dataset", "run_id", "collection_slot_utc", "status", "coverage_ratio", "retry_count", "http_429_count", "duration_seconds"]
};

const ROUTE_DETAIL_VIEW_COLUMNS: Record<string, string[]> = {
  api_airport_route_history_v1: ["route_id", "route_sample_id", "route_group_key", "tourism_center_key", "route_direction", "collection_slot_utc", "sampled_at_utc", "distance_meters", "current_duration_seconds", "typical_duration_seconds", "base_duration_seconds", "delay_vs_typical_seconds", "delay_vs_base_seconds", "ratio_vs_typical", "ratio_vs_base", "http_status"],
  api_airport_route_geometry_v1: ["route_id", "route_sample_id", "collection_slot_utc", "section_index", "geometry_geojson", "point_count"],
  api_traffic_flow_history_v1: ["segment_id", "segment_key", "road_name", "functional_class", "geometry_geojson", "observation_id", "collection_slot_utc", "source_updated_utc", "fetched_at_utc", "speed_kph", "free_flow_kph", "relative_speed", "jam_factor", "jam_tendency", "confidence", "traversability", "road_closure"]
};

export async function validateDatabaseServingContract(query: QueryRows = queryRows): Promise<SourceContractCheck[]> {
  type CountRow = { count_value: number };
  const viewNames = Object.keys(SERVING_VIEW_COLUMNS);
  const inspectedViewNames = [...viewNames, ...Object.keys(ROUTE_DETAIL_VIEW_COLUMNS)];
  const placeholders = inspectedViewNames.map(() => "?").join(",");
  const columns = await query<{ table_name_value: string; column_name_value: string }>(
    `SELECT TABLE_NAME AS table_name_value, COLUMN_NAME AS column_name_value
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
    inspectedViewNames
  );
  const missingViews = viewNames.filter((view) => !columns.some((column) => column.table_name_value === view));
  const missingColumns = Object.entries(SERVING_VIEW_COLUMNS).flatMap(([view, required]) => required
    .filter((column) => !columns.some((candidate) => candidate.table_name_value === view && candidate.column_name_value === column))
    .map((column) => `${view}.${column}`));
  if (missingViews.length || missingColumns.length) {
    throw new ApiUnavailableError("The Step 3 database serving views or required columns are missing.");
  }
  const missingRouteDetailViews = Object.keys(ROUTE_DETAIL_VIEW_COLUMNS).filter((view) => !columns.some((column) => column.table_name_value === view));
  const missingRouteDetailColumns = Object.entries(ROUTE_DETAIL_VIEW_COLUMNS).flatMap(([view, required]) => required
    .filter((column) => !columns.some((candidate) => candidate.table_name_value === view && candidate.column_name_value === column))
    .map((column) => `${view}.${column}`));
  const routeFallbackAllowed = process.env.ROUTE_READ_CONTRACT_FALLBACK_ENABLED !== "false" && process.env.STEP3_ROUTE_VIEWS_REQUIRED !== "true" && process.env.MVP_HISTORY_VIEWS_REQUIRED !== "true";
  const [scopeRows, destinations, routeDefinitions, latestRoutes, latestFlow, sourceStatuses, collectorStates] = await Promise.all([
    query<{ status: string; prediction_enabled: number }>("SELECT status, prediction_enabled FROM api_mobility_scope_v1"),
    query<{ destination_key: string; active: number }>("SELECT destination_key, active FROM api_airport_destinations_v1 ORDER BY display_order"),
    query<{ route_count: number; group_count: number; from_airport: number; to_airport: number; missing_metadata: number }>(
      `SELECT COUNT(*) AS route_count, COUNT(DISTINCT route_group_key) AS group_count,
              SUM(route_direction = 'from_airport') AS from_airport,
              SUM(route_direction = 'to_airport') AS to_airport,
              SUM(route_group_key IS NULL OR tourism_center_key IS NULL) AS missing_metadata
         FROM api_airport_tourism_routes_v1`
    ),
    query<CountRow>("SELECT COUNT(*) AS count_value FROM api_airport_route_latest_v1 WHERE route_sample_id IS NOT NULL"),
    query<CountRow>("SELECT COUNT(*) AS count_value FROM api_traffic_flow_latest_v1"),
    query<{ dataset: string }>("SELECT dataset FROM api_source_status_v1 ORDER BY dataset"),
    query<{ dataset: string }>("SELECT dataset FROM api_collector_alert_state_v1 ORDER BY dataset")
  ]);

  const scope = scopeRows[0];
  const expectedDestinations = ["canggu", "ubud", "uluwatu", "seminyak", "sanur", "jimbaran", "nusa-dua"].sort();
  const actualDestinations = destinations.filter((row) => Boolean(row.active)).map((row) => row.destination_key).sort();
  const destinationsReady = actualDestinations.length === expectedDestinations.length &&
    actualDestinations.every((key, index) => key === expectedDestinations[index]);
  const route = routeDefinitions[0];
  const routesReady = Number(route?.route_count ?? 0) === 14 && Number(route?.group_count ?? 0) === 7 &&
    Number(route?.from_airport ?? 0) === 7 && Number(route?.to_airport ?? 0) === 7 &&
    Number(route?.missing_metadata ?? 0) === 0;
  const statusDatasets = sourceStatuses.map((row) => row.dataset).sort();
  const statusesReady = statusDatasets.length === 2 && statusDatasets.includes("flow") && statusDatasets.includes("routes");
  const collectorDatasets = collectorStates.map((row) => row.dataset).sort();
  const collectorsReady = collectorDatasets.length === 2 && collectorDatasets.includes("flow") && collectorDatasets.includes("routes");
  const routeDetailViewsReady = missingRouteDetailViews.length === 0 && missingRouteDetailColumns.length === 0;
  const checks: SourceContractCheck[] = [
    { key: "serving_views_present", ok: missingViews.length === 0, detail: missingViews.length ? `Missing views: ${missingViews.join(", ")}.` : "All required Step 3 versioned API views are present." },
    { key: "serving_view_columns", ok: missingColumns.length === 0, detail: missingColumns.length ? `Missing columns: ${missingColumns.join(", ")}.` : "Versioned API view columns match the Step 1 contract." },
    { key: "mobility_scope_gate", ok: scopeRows.length === 1 && Boolean(scope) && ["draft", "approved"].includes(scope?.status ?? "") && (!Boolean(scope?.prediction_enabled) || scope?.status === "approved"), detail: scope ? `Scope is ${scope.status}; prediction_enabled=${Number(scope.prediction_enabled)}.` : "No product scope is available." },
    { key: "airport_destination_registry", ok: destinationsReady, detail: `${actualDestinations.length} active destinations: ${actualDestinations.join(", ") || "none"}.` },
    { key: "airport_route_view_definitions", ok: routesReady, detail: `${Number(route?.route_count ?? 0)} routes across ${Number(route?.group_count ?? 0)} groups (${Number(route?.from_airport ?? 0)} from airport, ${Number(route?.to_airport ?? 0)} to airport).` },
    { key: "airport_route_latest_view", ok: Number(latestRoutes[0]?.count_value ?? 0) === 14, detail: `${Number(latestRoutes[0]?.count_value ?? 0)} latest directional route measurements.` },
    { key: "traffic_flow_latest_view", ok: Number(latestFlow[0]?.count_value ?? 0) > 0, detail: `${Number(latestFlow[0]?.count_value ?? 0)} latest Flow rows.` },
    { key: "source_status_view", ok: statusesReady, detail: `${statusDatasets.length} status rows: ${statusDatasets.join(", ") || "none"}.` },
    { key: "collector_alert_view", ok: collectorsReady, detail: `${collectorDatasets.length} collector states: ${collectorDatasets.join(", ") || "none"}.` },
    { key: "route_detail_views", ok: routeDetailViewsReady || routeFallbackAllowed, detail: routeDetailViewsReady
      ? "Versioned Route detail and Flow history views are present."
      : `Pending data-engineering views: ${missingRouteDetailViews.join(", ") || missingRouteDetailColumns.join(", ")}. Normalized-table fallback is ${routeFallbackAllowed ? "temporarily enabled" : "disabled"}.` }
  ];
  if (checks.some((check) => !check.ok)) {
    throw new ApiUnavailableError("The Step 1 database serving contract is not ready for production reads.");
  }
  return checks;
}

export async function validateSourceContract(query: QueryRows = queryRows): Promise<SourceContractCheck[]> {
  type CountRow = { count_value: number };
  const [columns, indexes, counts, tourismCounts, latestRouteRun, tourismGeometry] = await Promise.all([
    query<{ table_name_value: string; column_name_value: string; nullable_value: "YES" | "NO" }>(
      `SELECT TABLE_NAME AS table_name_value, COLUMN_NAME AS column_name_value, IS_NULLABLE AS nullable_value FROM information_schema.columns
        WHERE table_schema = DATABASE() AND (
          (table_name = 'traffic_flow_observations' AND column_name = 'collection_slot_utc') OR
          (table_name = 'route_samples' AND column_name IN ('collection_slot_utc','current_duration_seconds','typical_duration_seconds')) OR
          (table_name = 'routes' AND column_name IN ('route_purpose','route_group_key','tourism_center_key','route_direction'))
        )`
    ),
    query<{ table_name_value: string; index_name_value: string; columns_csv: string; non_unique_value: number }>(
      `SELECT TABLE_NAME AS table_name_value, INDEX_NAME AS index_name_value, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns_csv, NON_UNIQUE AS non_unique_value
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name IN ('traffic_flow_observations','route_samples','routes')
        GROUP BY table_name, index_name, non_unique`
    ),
    Promise.all([
      query<CountRow>(`SELECT COUNT(*) AS count_value FROM traffic_flow_latest`),
      query<CountRow>(`SELECT COUNT(*) AS count_value FROM traffic_flow_observations WHERE collection_slot_utc IS NULL`),
      query<CountRow>(`SELECT COUNT(*) AS count_value FROM route_samples WHERE collection_slot_utc IS NULL OR current_duration_seconds IS NULL OR typical_duration_seconds IS NULL`),
      query<CountRow>(`SELECT COUNT(*) AS count_value FROM (SELECT route_id, collection_slot_utc FROM route_samples GROUP BY route_id, collection_slot_utc HAVING COUNT(*) > 1) duplicates`),
      query<CountRow>(`SELECT COUNT(*) AS count_value FROM route_sample_geometries WHERE ST_SRID(geometry) <> 4326`)
    ]),
    query<{ active_routes: number; route_groups: number; from_airport: number; to_airport: number; missing_metadata: number }>(
      `SELECT COUNT(*) AS active_routes, COUNT(DISTINCT route_group_key) AS route_groups,
              SUM(route_direction = 'from_airport') AS from_airport,
              SUM(route_direction = 'to_airport') AS to_airport,
              SUM(route_group_key IS NULL OR tourism_center_key IS NULL) AS missing_metadata
         FROM routes WHERE active = 1 AND route_purpose = 'airport_tourism'`
    ),
    query<{ route_expected_count: number; route_success_count: number; route_failure_count: number; status: string }>(
      `SELECT route_expected_count, route_success_count, route_failure_count, status
         FROM ingestion_runs WHERE source = 'n8n-here-routes'
        ORDER BY collection_slot_utc DESC, id DESC LIMIT 1`
    ),
    query<{ routes_with_geometry: number; wrong_srid: number }>(
      `SELECT COUNT(DISTINCT r.id) AS routes_with_geometry,
              SUM(ST_SRID(g.geometry) <> 4326) AS wrong_srid
         FROM routes r
         JOIN route_samples s ON s.route_id = r.id
         JOIN route_sample_geometries g ON g.route_sample_id = s.id
        WHERE r.active = 1 AND r.route_purpose = 'airport_tourism'
          AND s.provider = 'here'
          AND s.collection_slot_utc = (
            SELECT MAX(s2.collection_slot_utc) FROM route_samples s2
             WHERE s2.route_id = r.id AND s2.provider = 'here'
          )`
    )
  ]);

  const requiredColumns = [
    ["traffic_flow_observations", "collection_slot_utc"],
    ["route_samples", "collection_slot_utc"],
    ["route_samples", "current_duration_seconds"],
    ["route_samples", "typical_duration_seconds"]
  ];
  const requiredColumnsOk = requiredColumns.every(([table, column]) =>
    columns.some((row) => row.table_name_value === table && row.column_name_value === column && row.nullable_value === "NO")
  );
  const flowUnique = indexes.some((row) => row.table_name_value === "traffic_flow_observations" && Number(row.non_unique_value) === 0 && row.columns_csv === "segment_id,collection_slot_utc");
  const routeUnique = indexes.some((row) => row.table_name_value === "route_samples" && Number(row.non_unique_value) === 0 && row.columns_csv === "route_id,collection_slot_utc");
  const tourismColumns = ["route_purpose", "route_group_key", "tourism_center_key", "route_direction"];
  const tourismColumnsPresent = tourismColumns.every((column) => columns.some((row) => row.table_name_value === "routes" && row.column_name_value === column));
  const purposeIndex = indexes.some((row) => row.table_name_value === "routes" && row.columns_csv === "route_purpose,active");
  const groupIndex = indexes.some((row) => row.table_name_value === "routes" && row.columns_csv === "route_group_key,route_direction");
  const [latest, nullFlow, nullRoute, duplicateRoute, wrongSrid] = counts.map((rows) => Number(rows[0]?.count_value ?? 0));
  const tourism = tourismCounts[0];
  const routeRun = latestRouteRun[0];
  const geometry = tourismGeometry[0];
  const tourismDefinitionsReady = Number(tourism?.active_routes ?? 0) === 14 && Number(tourism?.route_groups ?? 0) === 7 && Number(tourism?.from_airport ?? 0) === 7 && Number(tourism?.to_airport ?? 0) === 7 && Number(tourism?.missing_metadata ?? 0) === 0;
  const routeRunReady = routeRun?.status === "success" && Number(routeRun.route_expected_count) === 14 && Number(routeRun.route_success_count) === 14 && Number(routeRun.route_failure_count) === 0;
  const tourismGeometryReady = Number(geometry?.routes_with_geometry ?? 0) === 14 && Number(geometry?.wrong_srid ?? 0) === 0;
  const checks: SourceContractCheck[] = [
    { key: "required_non_null_columns", ok: requiredColumnsOk, detail: requiredColumnsOk ? "Required Flow/Route slot and duration columns are non-null." : "Required source columns are missing or nullable." },
    { key: "flow_unique_slot", ok: flowUnique, detail: flowUnique ? "Flow segment/slot unique index is present." : "Flow segment/slot unique index is missing." },
    { key: "route_unique_slot", ok: routeUnique, detail: routeUnique ? "Route/slot unique index is present." : "Route/slot unique index is missing." },
    { key: "latest_pointer", ok: latest > 0, detail: `${latest} latest Flow pointers.` },
    { key: "flow_slot_nulls", ok: nullFlow === 0, detail: `${nullFlow} Flow observations have null collection slots.` },
    { key: "route_required_nulls", ok: nullRoute === 0, detail: `${nullRoute} Route samples have null required measurements.` },
    { key: "route_duplicate_slots", ok: duplicateRoute === 0, detail: `${duplicateRoute} duplicate Route slot groups.` },
    { key: "route_geometry_srid", ok: wrongSrid === 0, detail: `${wrongSrid} Route geometry sections are not SRID 4326.` },
    { key: "airport_tourism_columns", ok: tourismColumnsPresent, detail: tourismColumnsPresent ? "Airport-tourism route metadata columns are present." : "Airport-tourism route metadata columns are missing." },
    { key: "airport_tourism_indexes", ok: purposeIndex && groupIndex, detail: purposeIndex && groupIndex ? "Airport-tourism purpose and group indexes are present." : "Airport-tourism route indexes are missing." },
    { key: "airport_tourism_definitions", ok: tourismDefinitionsReady, detail: `${Number(tourism?.active_routes ?? 0)} active routes across ${Number(tourism?.route_groups ?? 0)} groups (${Number(tourism?.from_airport ?? 0)} from airport, ${Number(tourism?.to_airport ?? 0)} to airport).` },
    { key: "airport_tourism_latest_run", ok: routeRunReady, detail: routeRun ? `Latest Route run is ${routeRun.status}: ${routeRun.route_success_count}/${routeRun.route_expected_count} successful, ${routeRun.route_failure_count} failed.` : "No Route run is available." },
    { key: "airport_tourism_geometry", ok: tourismGeometryReady, detail: `${Number(geometry?.routes_with_geometry ?? 0)} airport-tourism routes have latest geometry; ${Number(geometry?.wrong_srid ?? 0)} sections use the wrong SRID.` }
  ];
  if (checks.some((check) => !check.ok)) {
    throw new ApiUnavailableError("The HERE source schema contract is not ready for production reads.");
  }
  return checks;
}

export function validateSourceContractOnce() {
  return withRedisJsonCache(
    { resource: "source-contract-validation", identity: "current", ttlSeconds: 300 },
    () => validateFullSourceContract()
  );
}

export async function validateFullSourceContract(query: QueryRows = queryRows) {
  const [sourceChecks, servingChecks] = await Promise.all([
    validateSourceContract(query),
    validateDatabaseServingContract(query)
  ]);
  return [...sourceChecks, ...servingChecks];
}
