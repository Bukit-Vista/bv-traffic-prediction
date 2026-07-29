import { ApiNotFoundError, apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { getRoutes } from "@/lib/api/data-source";
import { idSchema } from "@/lib/api/validation";
import { AIRPORT_CORRIDOR_DISCLAIMER } from "@/lib/routes/airport-corridors";
import { completedUtcHourWindow } from "@/lib/api/mvp-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ routeId: string }> }) {
  try {
    const id = idSchema.parse((await context.params).routeId);
    const route = (await getRoutes()).find((candidate) => candidate.id === id);
    if (!route) throw new ApiNotFoundError("ROUTE_NOT_FOUND", "The requested route is not an active airport-tourism route.");
    const etag = createResourceEtag("route-latest", route, { routeId: id });
    const cached = conditionalNotModified(request, etag);
    if (cached) return cached;
    const window = completedUtcHourWindow();
    return applyConditionalHeaders(apiJson(route, {
      selectedSlot: route.collectionSlotUtc ?? null, slotUtc: route.collectionSlotUtc ?? null,
      requestedSlotUtc: "latest", actualSlotUtc: route.collectionSlotUtc ?? null,
      windowStartUtc: window.startUtc, windowEndExclusiveUtc: window.endExclusiveUtc, windowHours: window.windowHours,
      source: "here_routes_mysql", semantics: "measured_route_condition",
      routePurpose: route.routePurpose, routeGroupKey: route.routeGroupKey,
      tourismCenterKey: route.tourismCenterKey, routeDirection: route.routeDirection,
      disclaimer: AIRPORT_CORRIDOR_DISCLAIMER
    }), etag);
  } catch (error) {
    return apiError(error);
  }
}
