import { apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { readCurrentDashboardSnapshot } from "@/lib/snapshot/traffic-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const snapshot = await readCurrentDashboardSnapshot();
    if (!snapshot?.trafficTiles) return apiJson(null, { status: "unavailable", source: "traffic_snapshot" }, { status: 503 });
    const etag = createResourceEtag("traffic-snapshot", snapshot.trafficTiles.version);
    const cached = conditionalNotModified(request, etag);
    if (cached) return cached;
    return applyConditionalHeaders(apiJson(snapshot, {
      ...snapshot.meta,
      source: "here_snapshot_redis"
    }), etag);
  } catch (error) {
    return apiError(error);
  }
}
