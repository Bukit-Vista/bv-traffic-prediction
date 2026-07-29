import { requireOperationsRole } from "@/lib/api/access-control";
import { getCollectorAlertStates } from "@/lib/api/database-serving-contract";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { apiError, apiJson } from "@/lib/api/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireOperationsRole(request);
    const collectors = await getCollectorAlertStates();
    const etag = createResourceEtag("operations-collectors", collectors);
    const cacheControl = "private, max-age=15, must-revalidate";
    const cached = conditionalNotModified(request, etag, cacheControl);
    if (cached) return cached;
    return applyConditionalHeaders(apiJson({ collectors, count: collectors.length }, {
      collectionSlotUtc: collectors.reduce<string | null>((latest, item) => !latest || item.collectionSlotUtc > latest ? item.collectionSlotUtc : latest, null),
      source: "api_collector_alert_state_v1",
      status: collectors.some((item) => item.isFailed || item.isStuck) ? "critical" : collectors.some((item) => item.isPartial || item.isStale) ? "partial" : "success",
      isStale: collectors.some((item) => item.isStale),
      semantics: "measured_traffic"
    }), etag, cacheControl);
  } catch (error) {
    return apiError(error);
  }
}
