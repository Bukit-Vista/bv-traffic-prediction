import { apiError, apiGeoJson } from "@/lib/api/response";
import { applyConditionalHeaders, cacheControlForAt, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { idSchema, parseQuery, routeGeometryQuerySchema } from "@/lib/api/validation";
import { getRouteGeometry } from "@/lib/api/data-source";
import { AIRPORT_CORRIDOR_DISCLAIMER } from "@/lib/routes/airport-corridors";
import { enforceRateLimit } from "@/lib/api/access-control";
import { completedUtcHourWindow } from "@/lib/api/mvp-window";
import { withRedisJsonCache } from "@/lib/cache/redis-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ routeId: string }> }) {
  try {
    enforceRateLimit(request, "route-geometry", { maximum: 120 });
    const routeId = idSchema.parse((await context.params).routeId);
    const input = parseQuery(routeGeometryQuerySchema, request);
    const result = await withRedisJsonCache({
      resource: "route-geometry",
      identity: { routeId, at: input.at },
      freshness: input.at === "latest" ? "latest" : "historical"
    }, () => getRouteGeometry(routeId, input.at));
    const cacheControl = cacheControlForAt(input.at);
    const etag = createResourceEtag("route-geometry", {
      route: result.route, slotUtc: result.slotUtc, sourceRunId: result.sourceRunId,
      features: result.collection.features
    }, { routeId, at: input.at });
    const cached = conditionalNotModified(request, etag, cacheControl);
    if (cached) return cached;
    const window = completedUtcHourWindow();
    return applyConditionalHeaders(apiGeoJson(result.collection, {
      selectedSlot: result.slotUtc, slotUtc: result.slotUtc, sourceRunId: result.sourceRunId,
      requestedSlotUtc: input.at, actualSlotUtc: result.slotUtc,
      windowStartUtc: window.startUtc, windowEndExclusiveUtc: window.endExclusiveUtc, windowHours: window.windowHours,
      source: result.source, semantics: "measured_route_condition",
      routePurpose: result.route.routePurpose, routeGroupKey: result.route.routeGroupKey,
      tourismCenterKey: result.route.tourismCenterKey, routeDirection: result.route.routeDirection,
      disclaimer: AIRPORT_CORRIDOR_DISCLAIMER
    }), etag, cacheControl);
  } catch (error) {
    return apiError(error);
  }
}
