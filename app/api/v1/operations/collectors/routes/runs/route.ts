import { enforceRateLimit, requireOperationsRole } from "@/lib/api/access-control";
import { getCollectorRunHistory } from "@/lib/api/database-serving-contract";
import { apiError, apiJson } from "@/lib/api/response";
import { parseQuery, rangeQuerySchema, resolveBoundedUtcRange } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireOperationsRole(request);
    enforceRateLimit(request, "operations-route-history", { maximum: 60 });
    const input = resolveBoundedUtcRange(parseQuery(rangeQuerySchema, request));
    const runs = await getCollectorRunHistory("routes", input);
    return apiJson({ runs, count: runs.length, range: { from: input.from, to: input.to } }, {
      collectionSlotUtc: runs[0]?.slotUtc ?? null,
      sourceRunId: runs[0] ? String(runs[0].id) : null,
      source: "api_route_run_history_v1",
      status: runs[0]?.status ?? "unavailable",
      coverage: runs[0]?.coverage ?? null,
      semantics: "measured_route_condition"
    });
  } catch (error) {
    return apiError(error);
  }
}
