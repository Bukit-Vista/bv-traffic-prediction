import { apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { getRuns } from "@/lib/api/data-source";
import { requireOperationsRole } from "@/lib/api/access-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireOperationsRole(request);
    const runs = await getRuns("hourly");
    const etag = createResourceEtag("route-runs", runs);
    const cached = conditionalNotModified(request, etag);
    if (cached) return cached;
    return applyConditionalHeaders(apiJson({ runs, count: runs.length }, { selectedSlot: runs[0]?.slotUtc ?? null, slotUtc: runs[0]?.slotUtc ?? null, sourceRunId: runs[0] ? String(runs[0].id) : null, status: runs[0]?.status ?? "unavailable", coverage: runs[0]?.coverage ?? null, source: "n8n-here-routes", semantics: "measured_route_condition" }), etag);
  } catch (error) {
    return apiError(error);
  }
}
