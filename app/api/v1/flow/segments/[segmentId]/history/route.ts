import { apiError, apiJson } from "@/lib/api/response";
import { idSchema, mvpWindowQuerySchema, parseQuery } from "@/lib/api/validation";
import { queryRows, toMysqlDateTime } from "@/lib/db/mysql";
import { toIsoUtc } from "@/lib/db/mappers";
import { coverageForSlots, expectedSlots, resolveMvpUtcWindow } from "@/lib/api/mvp-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ segmentId: string }> }) {
  try {
    const segmentId = idSchema.parse((await context.params).segmentId);
    const input = parseQuery(mvpWindowQuerySchema, request);
    const window = resolveMvpUtcWindow(input);
    const limit = window.windowHours * 2;
    const values = [segmentId, toMysqlDateTime(window.startUtc), toMysqlDateTime(window.endExclusiveUtc)];
    type Row = { collection_slot_utc: string; source_updated_utc: string | null; fetched_at_utc: string; speed_kph: number | null; free_flow_kph: number | null; jam_factor: number | null; confidence: number | null };
    let source = "api_traffic_flow_history_v1";
    let rows: Row[];
    try {
      rows = await queryRows<Row>(`SELECT collection_slot_utc, source_updated_utc, fetched_at_utc, speed_kph, free_flow_kph, jam_factor, confidence FROM api_traffic_flow_history_v1 WHERE segment_id = ? AND collection_slot_utc >= ? AND collection_slot_utc < ? ORDER BY collection_slot_utc LIMIT ${limit}`, values);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
      if (process.env.MVP_HISTORY_VIEWS_REQUIRED === "true" || code !== "ER_NO_SUCH_TABLE") throw error;
      source = "normalized_flow_table_fallback";
      rows = await queryRows<Row>(`SELECT collection_slot_utc, source_updated_utc, fetched_at_utc, speed_kph, free_flow_kph, jam_factor, confidence FROM traffic_flow_observations WHERE segment_id = ? AND collection_slot_utc >= ? AND collection_slot_utc < ? ORDER BY collection_slot_utc LIMIT ${limit}`, values);
    }
    const points = rows.map((row) => ({ collectionSlotUtc: toIsoUtc(row.collection_slot_utc), sourceUpdatedUtc: toIsoUtc(row.source_updated_utc), fetchedAtUtc: toIsoUtc(row.fetched_at_utc), speedKph: row.speed_kph == null ? null : Number(row.speed_kph), freeFlowKph: row.free_flow_kph == null ? null : Number(row.free_flow_kph), jamFactor: row.jam_factor == null ? null : Number(row.jam_factor), confidence: row.confidence == null ? null : Number(row.confidence) }));
    const coverage = coverageForSlots(expectedSlots(window, 30), points.map((point) => point.collectionSlotUtc as string));
    return apiJson({ segmentId, bucket: "30m", window, coverage, points }, {
      selectedSlot: points.at(-1)?.collectionSlotUtc ?? null, slotUtc: points.at(-1)?.collectionSlotUtc ?? null,
      requestedSlotUtc: window.endExclusiveUtc, actualSlotUtc: points.at(-1)?.collectionSlotUtc ?? null,
      windowStartUtc: window.startUtc, windowEndExclusiveUtc: window.endExclusiveUtc, windowHours: window.windowHours,
      status: coverage.coverage === 1 ? "success" : "partial", coverage: coverage.coverage,
      source, semantics: "measured_traffic"
    });
  } catch (error) { return apiError(error); }
}
