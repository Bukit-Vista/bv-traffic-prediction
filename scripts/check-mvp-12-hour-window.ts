import "dotenv/config";
import { completedUtcHourWindow } from "@/lib/api/mvp-window";
import { getMvpWindowStatus } from "@/lib/api/data-source";
import { closeMySqlPool, queryRows, toMysqlDateTime } from "@/lib/db/mysql";

type CountRow = { count_value: number };

async function main() {
  const window = completedUtcHourWindow();
  const [status, duplicateFlow, duplicateRoutes, pointerRegressions, connectionErrors] = await Promise.all([
    getMvpWindowStatus(window),
    queryRows<CountRow>(`SELECT COUNT(*) AS count_value FROM (
      SELECT segment_id, collection_slot_utc FROM traffic_flow_observations
      WHERE collection_slot_utc >= ? AND collection_slot_utc < ?
      GROUP BY segment_id, collection_slot_utc HAVING COUNT(*) > 1
    ) duplicates`, [toMysqlDateTime(window.startUtc), toMysqlDateTime(window.endExclusiveUtc)]),
    queryRows<CountRow>(`SELECT COUNT(*) AS count_value FROM (
      SELECT route_id, collection_slot_utc FROM route_samples
      WHERE collection_slot_utc >= ? AND collection_slot_utc < ?
      GROUP BY route_id, collection_slot_utc HAVING COUNT(*) > 1
    ) duplicates`, [toMysqlDateTime(window.startUtc), toMysqlDateTime(window.endExclusiveUtc)]),
    queryRows<CountRow>(`SELECT COUNT(*) AS count_value FROM traffic_flow_latest l
      WHERE l.collection_slot_utc <> (
        SELECT MAX(o.collection_slot_utc) FROM traffic_flow_observations o WHERE o.segment_id = l.segment_id
      )`),
    queryRows<CountRow>(`SELECT
      (SELECT COUNT(*) FROM traffic_flow_collection_runs WHERE started_at_utc >= ? AND started_at_utc < ? AND CAST(error_json AS CHAR) LIKE '%max%connection%') +
      (SELECT COUNT(*) FROM ingestion_runs WHERE started_at_utc >= ? AND started_at_utc < ? AND CAST(error_json AS CHAR) LIKE '%max%connection%') AS count_value`,
    [toMysqlDateTime(window.startUtc), toMysqlDateTime(window.endExclusiveUtc), toMysqlDateTime(window.startUtc), toMysqlDateTime(window.endExclusiveUtc)])
  ]);
  const duplicateIdentities = Number(duplicateFlow[0]?.count_value ?? 0) + Number(duplicateRoutes[0]?.count_value ?? 0);
  const stuckSlots = status.flow.stuckSlotsUtc.length + status.routes.stuckSlotsUtc.length;
  const failedSlots = status.flow.failedSlotsUtc.length + status.routes.failedSlotsUtc.length;
  const partialSlots = status.flow.partialSlotsUtc.length + status.routes.partialSlotsUtc.length;
  const checks = [
    { key: "flow_slots", actual: status.flow.presentSlots, expected: 24, ok: status.flow.presentSlots === 24 && status.flow.passedSlots === 24 },
    { key: "route_slots", actual: status.routes.presentSlots, expected: 12, ok: status.routes.presentSlots === 12 && status.routes.passedSlots === 12 },
    { key: "route_samples", actual: status.routes.presentSamples, expected: 168, ok: status.routes.presentSamples === 168 },
    { key: "route_geometries", actual: status.routes.presentGeometries, expected: 168, ok: status.routes.presentGeometries === 168 },
    { key: "partial_slots", actual: partialSlots, expected: 0, ok: partialSlots === 0 },
    { key: "failed_slots", actual: failedSlots, expected: 0, ok: failedSlots === 0 },
    { key: "stuck_slots", actual: stuckSlots, expected: 0, ok: stuckSlots === 0 },
    { key: "duplicate_logical_identities", actual: duplicateIdentities, expected: 0, ok: duplicateIdentities === 0 },
    { key: "latest_pointer_regressions", actual: Number(pointerRegressions[0]?.count_value ?? 0), expected: 0, ok: Number(pointerRegressions[0]?.count_value ?? 0) === 0 },
    { key: "new_max_connection_errors", actual: Number(connectionErrors[0]?.count_value ?? 0), expected: 0, ok: Number(connectionErrors[0]?.count_value ?? 0) === 0 }
  ];
  process.stdout.write(`${JSON.stringify({ ready: checks.every((check) => check.ok), window, checks, status }, null, 2)}\n`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function run() {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ready: false, error: error instanceof Error ? error.message : "MVP gate failed" })}\n`);
    process.exitCode = 1;
  } finally {
    await closeMySqlPool().catch(() => undefined);
  }
}

void run();
