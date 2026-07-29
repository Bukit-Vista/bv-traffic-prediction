import { apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { getCollectorAlertStates, getMobilityProductScope } from "@/lib/api/database-serving-contract";
import { completedUtcHourWindow } from "@/lib/api/mvp-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const [sources, scope] = await Promise.all([
      getCollectorAlertStates(),
      getMobilityProductScope()
    ]);
    const flow = sources.find((source) => source.dataset === "flow") ?? null;
    const routes = sources.find((source) => source.dataset === "routes") ?? null;
    const latestSlot = sources.reduce<string | null>((latest, source) => !latest || source.collectionSlotUtc > latest ? source.collectionSlotUtc : latest, null);
    const unhealthy = sources.some((source) => source.isFailed || source.isStuck);
    const warning = sources.some((source) => source.isPartial || source.isStale || source.isRunning);
    const cacheControl = "private, max-age=20, stale-while-revalidate=10";
    const etag = createResourceEtag("traffic-overview", { sources, scopeVersion: scope.scopeVersion });
    const cached = conditionalNotModified(request, etag, cacheControl);
    if (cached) return cached;
    const window = completedUtcHourWindow();
    return applyConditionalHeaders(apiJson({ flow, routes, sources, scope: {
      scopeKey: scope.scopeKey, scopeVersion: scope.scopeVersion,
      predictionEnabled: scope.predictionEnabled, disclaimer: scope.disclaimer
    } }, {
      collectionSlotUtc: latestSlot,
      requestedSlotUtc: "latest",
      actualSlotUtc: latestSlot,
      windowStartUtc: window.startUtc,
      windowEndExclusiveUtc: window.endExclusiveUtc,
      windowHours: window.windowHours,
      sourceRunId: flow?.runId ?? null,
      source: "api_collector_alert_state_v1",
      status: unhealthy ? "critical" : warning ? "partial" : "success",
      isStale: sources.some((source) => source.isStale),
      freshnessState: sources.some((source) => source.freshnessState === "critically_stale") ? "critically_stale" : sources.some((source) => source.isStale) ? "stale" : "fresh",
      coverage: flow?.coverageRatio ?? null,
      semantics: "measured_traffic"
    }), etag, cacheControl);
  } catch (error) {
    return apiError(error);
  }
}
