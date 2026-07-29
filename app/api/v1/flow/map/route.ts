import { apiError, apiGeoJson, assertJsonResponseSize } from "@/lib/api/response";
import { enforceRateLimit } from "@/lib/api/access-control";
import { applyConditionalHeaders, cacheControlForAt, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { getFlowMap, resolveFlowResource } from "@/lib/api/data-source";
import { mapQuerySchema, parseQuery } from "@/lib/api/validation";
import { withRedisJsonCache } from "@/lib/cache/redis-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    enforceRateLimit(request, "flow-map", { maximum: 120 });
    const input = parseQuery(mapQuerySchema, request);
    const resource = await resolveFlowResource(input.at);
    const cacheControl = cacheControlForAt(input.at);
    const etag = createResourceEtag("flow-map", {
      runId: resource.selected.id, slotUtc: resource.slotUtc, status: resource.selected.status,
      observations: resource.selected.observation_count, segments: resource.selected.segment_count,
      attempts: resource.selected.attempt_count, finishedAtUtc: resource.selected.finished_at_utc,
      hasError: Boolean(resource.selected.error_json), stale: resource.meta.stale
    }, input);
    const cached = conditionalNotModified(request, etag, cacheControl);
    if (cached) return cached;
    const result = await withRedisJsonCache({
      resource: "flow-map",
      identity: {
        runId: resource.selected.id,
        slotUtc: resource.slotUtc,
        observations: resource.selected.observation_count,
        segments: resource.selected.segment_count
      },
      scope: input,
      freshness: input.at === "latest" ? "latest" : "historical"
    }, () => getFlowMap(input, undefined, resource));
    assertJsonResponseSize(result.collection);
    return applyConditionalHeaders(apiGeoJson(result.collection, {
      ...result.meta,
      truncated: result.truncated
    }), etag, cacheControl);
  } catch (error) {
    return apiError(error);
  }
}
