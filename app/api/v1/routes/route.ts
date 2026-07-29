import { apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { getAirportRouteDefinitions } from "@/lib/api/database-serving-contract";
import { AIRPORT_CORRIDOR_DISCLAIMER } from "@/lib/routes/airport-corridors";
import { completedUtcHourWindow } from "@/lib/api/mvp-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const routes = await getAirportRouteDefinitions();
    const scope = routes[0] ? {
      scopeKey: routes[0].scopeKey,
      scopeVersion: routes[0].scopeVersion,
      scopeStatus: routes[0].scopeStatus,
      predictionEnabled: routes[0].predictionEnabled
    } : null;
    const cacheControl = "private, max-age=300, must-revalidate";
    const etag = createResourceEtag("airport-route-definitions", { scope, routes });
    const cached = conditionalNotModified(request, etag, cacheControl);
    if (cached) return cached;
    const window = completedUtcHourWindow();
    return applyConditionalHeaders(apiJson({ routes, count: routes.length, scope }, {
      source: "api_airport_tourism_routes_v1",
      requestedSlotUtc: window.endExclusiveUtc,
      actualSlotUtc: null,
      windowStartUtc: window.startUtc,
      windowEndExclusiveUtc: window.endExclusiveUtc,
      windowHours: window.windowHours,
      status: "fresh",
      stale: false,
      semantics: null,
      disclaimer: AIRPORT_CORRIDOR_DISCLAIMER
    }), etag, cacheControl);
  } catch (error) {
    return apiError(error);
  }
}
