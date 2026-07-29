import { apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag, HISTORICAL_CACHE_CONTROL, LATEST_CACHE_CONTROL } from "@/lib/api/conditional-cache";
import { getRouteHistory } from "@/lib/api/data-source";
import { idSchema, mvpWindowQuerySchema, parseQuery } from "@/lib/api/validation";
import { AIRPORT_CORRIDOR_DISCLAIMER } from "@/lib/routes/airport-corridors";
import { enforceRateLimit } from "@/lib/api/access-control";
import { coverageForSlots, expectedSlots, resolveMvpUtcWindow } from "@/lib/api/mvp-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ routeId: string }> }) {
  try {
    enforceRateLimit(request, "route-history", { maximum: 120 });
    const routeId = idSchema.parse((await context.params).routeId);
    const parsed = parseQuery(mvpWindowQuerySchema, request);
    const window = resolveMvpUtcWindow(parsed);
    const result = await getRouteHistory(routeId, { from: window.startUtc, to: window.endExclusiveUtc, limit: window.windowHours });
    const points = result.points;
    const expected = expectedSlots(window, 60);
    const coverage = coverageForSlots(expected, points.map((point) => point.collectionSlotUtc));
    const cacheControl = parsed.from && parsed.to ? HISTORICAL_CACHE_CONTROL : LATEST_CACHE_CONTROL;
    const etag = createResourceEtag("route-history", { route: result.route, points, window, coverage }, { routeId });
    const cached = conditionalNotModified(request, etag, cacheControl);
    if (cached) return cached;
    return applyConditionalHeaders(apiJson({ route: result.route, bucket: "1h", window, coverage, points }, {
      selectedSlot: points.at(-1)?.collectionSlotUtc ?? null,
      slotUtc: points.at(-1)?.collectionSlotUtc ?? null,
      requestedSlotUtc: window.endExclusiveUtc,
      actualSlotUtc: points.at(-1)?.collectionSlotUtc ?? null,
      windowStartUtc: window.startUtc,
      windowEndExclusiveUtc: window.endExclusiveUtc,
      windowHours: window.windowHours,
      status: coverage.coverage === 1 ? "success" : "partial",
      coverage: coverage.coverage,
      source: result.source,
      semantics: "measured_route_condition",
      routePurpose: result.route.routePurpose,
      routeGroupKey: result.route.routeGroupKey,
      tourismCenterKey: result.route.tourismCenterKey,
      routeDirection: result.route.routeDirection,
      disclaimer: AIRPORT_CORRIDOR_DISCLAIMER
    }), etag, cacheControl);
  } catch (error) {
    return apiError(error);
  }
}
