import { apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import {
  publicTrafficTileSnapshot,
  readTrafficSnapshotPointer
} from "@/lib/snapshot/traffic-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const pointer = await readTrafficSnapshotPointer();
    if (!pointer) {
      return apiJson(
        null,
        {
          source: "traffic_snapshot",
          status: "unavailable",
          disclaimer: "No published dashboard snapshot is available. An authorized manual refresh is required."
        },
        { status: 503 }
      );
    }

    const trafficTiles = publicTrafficTileSnapshot(pointer);
    const etag = createResourceEtag("dashboard-version", {
      versions: pointer.versions,
      trafficTiles
    });
    const cached = conditionalNotModified(request, etag);
    if (cached) return cached;
    return applyConditionalHeaders(apiJson(
      { versions: pointer.versions, trafficTiles },
      {
        source: "here_snapshot_redis",
        sourceRunId: pointer.sourceRunId,
        slotUtc: pointer.slotUtc
      }
    ), etag);
  } catch (error) {
    return apiError(error);
  }
}
