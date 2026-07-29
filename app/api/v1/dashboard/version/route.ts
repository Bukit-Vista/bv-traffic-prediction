import { apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { getDashboardVersionIdentities } from "@/lib/api/data-source";
import { dashboardResourceVersions, dashboardSnapshotMatches, flowSnapshotMatches } from "@/lib/api/bootstrap";
import {
  publicTrafficTileSnapshot,
  readCurrentDashboardSnapshot,
  readTrafficSnapshotPointer
} from "@/lib/snapshot/traffic-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const pointer = await readTrafficSnapshotPointer();
    if (pointer) {
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
    }

    const snapshot = await readCurrentDashboardSnapshot();
    const identities = await getDashboardVersionIdentities();
    const versions = dashboardResourceVersions(identities);
    const fullSnapshotCurrent = Boolean(snapshot && dashboardSnapshotMatches(identities, snapshot));
    const flowSnapshotCurrent = Boolean(snapshot && flowSnapshotMatches(identities, snapshot));
    const trafficTiles = flowSnapshotCurrent ? snapshot?.trafficTiles ?? null : null;
    const etag = createResourceEtag("dashboard-version", { versions, trafficTiles });
    const cached = conditionalNotModified(request, etag);
    if (cached) return cached;
    return applyConditionalHeaders(apiJson(
      { versions, trafficTiles },
      fullSnapshotCurrent && snapshot
        ? { source: "here_snapshot_redis", sourceRunId: snapshot.meta.sourceRunId, slotUtc: snapshot.meta.slotUtc }
        : { source: "here_mysql_identity", sourceRunId: String(identities.flow.id), slotUtc: identities.flow.slotUtc }
    ), etag);
  } catch (error) {
    return apiError(error);
  }
}
