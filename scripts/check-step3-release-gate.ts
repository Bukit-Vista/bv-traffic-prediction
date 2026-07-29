import "dotenv/config";
import { closeMySqlPool, getMySqlPool, hasMutationPrivileges, queryRows } from "@/lib/db/mysql";

type CountRow = { count_value: number };
type StatusRow = { slot_count: number; bad_count: number };

async function main() {
  const [flowRows, routeRows, duplicateFlow, duplicateRoutes, stuckRuns, latestRoutes, latestGeometry, pointerRegressions, connectionErrors, routeDetailViews] = await Promise.all([
    queryRows<StatusRow>(`SELECT COUNT(DISTINCT collection_slot_utc) AS slot_count,
      SUM(status <> 'success') AS bad_count FROM (
        SELECT collection_slot_utc, status FROM api_flow_run_history_v1
        ORDER BY collection_slot_utc DESC, run_id DESC LIMIT 48
      ) recent`),
    queryRows<StatusRow>(`SELECT COUNT(DISTINCT collection_slot_utc) AS slot_count,
      SUM(status <> 'success') AS bad_count FROM (
        SELECT collection_slot_utc, status FROM api_route_run_history_v1
        ORDER BY collection_slot_utc DESC, run_id DESC LIMIT 24
      ) recent`),
    queryRows<CountRow>(`SELECT COUNT(*) AS count_value FROM (
      SELECT segment_id, collection_slot_utc FROM traffic_flow_observations
      GROUP BY segment_id, collection_slot_utc HAVING COUNT(*) > 1
    ) duplicates`),
    queryRows<CountRow>(`SELECT COUNT(*) AS count_value FROM (
      SELECT route_id, collection_slot_utc FROM route_samples
      GROUP BY route_id, collection_slot_utc HAVING COUNT(*) > 1
    ) duplicates`),
    queryRows<CountRow>("SELECT COUNT(*) AS count_value FROM api_collector_alert_state_v1 WHERE is_stuck = 1"),
    queryRows<CountRow>("SELECT COUNT(*) AS count_value FROM api_airport_route_latest_v1 WHERE route_sample_id IS NOT NULL"),
    queryRows<CountRow>(`SELECT COUNT(DISTINCT r.id) AS count_value FROM routes r
      JOIN route_samples s ON s.route_id = r.id
      JOIN route_sample_geometries g ON g.route_sample_id = s.id
      WHERE r.active = 1 AND r.route_purpose = 'airport_tourism' AND s.provider = 'here'
        AND s.collection_slot_utc = (SELECT MAX(s2.collection_slot_utc) FROM route_samples s2 WHERE s2.route_id = r.id AND s2.provider = 'here')`),
    queryRows<CountRow>(`SELECT COUNT(*) AS count_value FROM traffic_flow_latest l
      WHERE l.collection_slot_utc <> (
        SELECT MAX(o.collection_slot_utc) FROM traffic_flow_observations o WHERE o.segment_id = l.segment_id
      )`),
    queryRows<CountRow>(`SELECT
      (SELECT COUNT(*) FROM traffic_flow_collection_runs WHERE started_at_utc >= UTC_TIMESTAMP() - INTERVAL 24 HOUR AND CAST(error_json AS CHAR) LIKE '%max%connection%') +
      (SELECT COUNT(*) FROM ingestion_runs WHERE started_at_utc >= UTC_TIMESTAMP() - INTERVAL 24 HOUR AND CAST(error_json AS CHAR) LIKE '%max%connection%') AS count_value`),
    queryRows<CountRow>(`SELECT COUNT(DISTINCT table_name) AS count_value FROM information_schema.views
      WHERE table_schema = DATABASE() AND table_name IN ('api_airport_route_history_v1','api_airport_route_geometry_v1')`)
  ]);
  const [rawGrantRows] = await getMySqlPool().query("SHOW GRANTS");
  const grantRows = rawGrantRows as Array<Record<string, string>>;
  const grants = grantRows.flatMap((row) => Object.values(row)).join(" ");
  const checks = [
    { key: "flow_slots", actual: Number(flowRows[0]?.slot_count ?? 0), expected: 48, ok: Number(flowRows[0]?.slot_count ?? 0) === 48 },
    { key: "route_slots", actual: Number(routeRows[0]?.slot_count ?? 0), expected: 24, ok: Number(routeRows[0]?.slot_count ?? 0) === 24 },
    { key: "partial_or_failed_slots", actual: Number(flowRows[0]?.bad_count ?? 0) + Number(routeRows[0]?.bad_count ?? 0), expected: 0, ok: Number(flowRows[0]?.bad_count ?? 0) + Number(routeRows[0]?.bad_count ?? 0) === 0 },
    { key: "duplicate_logical_identities", actual: Number(duplicateFlow[0]?.count_value ?? 0) + Number(duplicateRoutes[0]?.count_value ?? 0), expected: 0, ok: Number(duplicateFlow[0]?.count_value ?? 0) + Number(duplicateRoutes[0]?.count_value ?? 0) === 0 },
    { key: "stuck_runs", actual: Number(stuckRuns[0]?.count_value ?? 0), expected: 0, ok: Number(stuckRuns[0]?.count_value ?? 0) === 0 },
    { key: "latest_pointer_regressions", actual: Number(pointerRegressions[0]?.count_value ?? 0), expected: 0, ok: Number(pointerRegressions[0]?.count_value ?? 0) === 0 },
    { key: "new_max_connection_errors", actual: Number(connectionErrors[0]?.count_value ?? 0), expected: 0, ok: Number(connectionErrors[0]?.count_value ?? 0) === 0 },
    { key: "latest_airport_routes", actual: Number(latestRoutes[0]?.count_value ?? 0), expected: 14, ok: Number(latestRoutes[0]?.count_value ?? 0) === 14 },
    { key: "latest_route_geometries", actual: Number(latestGeometry[0]?.count_value ?? 0), expected: 14, ok: Number(latestGeometry[0]?.count_value ?? 0) === 14 },
    { key: "route_detail_read_views", actual: Number(routeDetailViews[0]?.count_value ?? 0), expected: 2, ok: Number(routeDetailViews[0]?.count_value ?? 0) === 2 },
    { key: "select_only_application_account", actual: hasMutationPrivileges(grants) ? 0 : 1, expected: 1, ok: /\bSELECT\b/i.test(grants) && !hasMutationPrivileges(grants) }
  ];
  process.stdout.write(`${JSON.stringify({ ready: checks.every((check) => check.ok), checks }, null, 2)}\n`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ready: false, error: error instanceof Error ? error.message : "Gate check failed" })}\n`);
  process.exitCode = 1;
}).finally(closeMySqlPool);
