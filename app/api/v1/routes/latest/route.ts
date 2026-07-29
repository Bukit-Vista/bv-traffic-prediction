import { apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, cacheControlForAt, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { getLatestAirportRouteMeasurements, getMobilityProductScope, getSourceStatuses } from "@/lib/api/database-serving-contract";
import { getRoutes, getRuns } from "@/lib/api/data-source";
import { parseQuery, routeAtQuerySchema } from "@/lib/api/validation";
import { AIRPORT_CORRIDOR_DISCLAIMER, groupAirportTourismCorridors } from "@/lib/routes/airport-corridors";
import { completedUtcHourWindow } from "@/lib/api/mvp-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(routeAtQuerySchema, request);
    const [routes, sourceStatuses, scope] = await Promise.all([
      input.at === "latest" ? getLatestAirportRouteMeasurements() : getRoutes(input.at),
      input.at === "latest" ? getSourceStatuses() : Promise.resolve([]),
      getMobilityProductScope()
    ]);
    const slotUtc = routes.reduce<string | null>((latest, route) => {
      if (!route.collectionSlotUtc) return latest;
      return !latest || route.collectionSlotUtc > latest ? route.collectionSlotUtc : latest;
    }, null);
    const routeSource = sourceStatuses.find((source) => source.dataset === "routes") ?? null;
    const historicalRun = input.at === "latest"
      ? null
      : (await getRuns("hourly")).find((run) => run.slotUtc === slotUtc) ?? null;
    const newestFailed = input.at === "latest" && routeSource?.status === "failed";
    const stale = input.at === "latest" && (routes.some((route) => route.status === "stale") || newestFailed);
    const window = completedUtcHourWindow();
    const freshnessSeconds = slotUtc
      ? Math.max(0, Math.floor((Date.now() - new Date(slotUtc).getTime()) / 1000))
      : null;
    const corridors = groupAirportTourismCorridors(routes);
    const cacheControl = cacheControlForAt(input.at);
    const etag = createResourceEtag("airport-route-latest", { routes, routeSource, historicalRun, scope }, { at: input.at });
    const cached = conditionalNotModified(request, etag, cacheControl);
    if (cached) return cached;
    return applyConditionalHeaders(apiJson({
      routes,
      corridors,
      count: routes.length,
      corridorCount: corridors.length,
      scope: {
        scopeKey: scope.scopeKey,
        scopeVersion: scope.scopeVersion,
        scopeStatus: scope.status,
        predictionEnabled: scope.predictionEnabled
      }
    }, {
      selectedSlot: slotUtc,
      slotUtc,
      requestedSlotUtc: input.at,
      actualSlotUtc: slotUtc,
      windowStartUtc: window.startUtc,
      windowEndExclusiveUtc: window.endExclusiveUtc,
      windowHours: window.windowHours,
      source: input.at === "latest" ? "api_airport_route_latest_v1" : "here_routes_mysql_exact_slot",
      sourceRunId: routeSource?.runId ?? (historicalRun ? String(historicalRun.id) : null),
      semantics: "measured_route_condition",
      stale,
      isFallback: newestFailed,
      fallbackSlotUtc: newestFailed ? slotUtc : null,
      status: stale ? "stale" : routeSource?.status ?? historicalRun?.status ?? "fresh",
      freshnessSeconds,
      coverage: routeSource?.coverage ?? historicalRun?.coverage ?? null,
      disclaimer: AIRPORT_CORRIDOR_DISCLAIMER
    }), etag, cacheControl);
  } catch (error) {
    return apiError(error);
  }
}
