import type { RedisCacheStore } from "@/lib/cache/redis-json";
import type { SourceDashboardData } from "@/lib/dashboard/types";
import { buildTrafficSnapshot } from "@/lib/snapshot/build-traffic-snapshot";
import {
  readCurrentDashboardSnapshot,
  trafficSnapshotReadiness,
  trafficSnapshotMode,
  trafficSnapshotPointerKey,
  type TrafficSnapshotEnv
} from "@/lib/snapshot/traffic-snapshot";

const inFlightBuilds = new Map<string, Promise<SourceDashboardData | null>>();

function snapshotMatchesDashboard(snapshot: SourceDashboardData, dashboard: SourceDashboardData) {
  const snapshotVersions = snapshot.versions;
  const dashboardVersions = dashboard.versions;
  return snapshot.meta.sourceRunId === dashboard.meta.sourceRunId &&
    snapshot.meta.slotUtc === dashboard.meta.slotUtc &&
    Boolean(snapshotVersions && dashboardVersions) &&
    snapshotVersions!.flow === dashboardVersions!.flow &&
    snapshotVersions!.routes === dashboardVersions!.routes &&
    snapshotVersions!.flowHealth === dashboardVersions!.flowHealth &&
    snapshotVersions!.routeHealth === dashboardVersions!.routeHealth;
}

export async function ensureLatestTrafficSnapshot(
  dashboard: SourceDashboardData,
  env: TrafficSnapshotEnv = process.env,
  suppliedStore?: RedisCacheStore | null,
  beforeActivate?: () => Promise<void>
) {
  if (trafficSnapshotMode(env) === "off") return null;

  const current = await readCurrentDashboardSnapshot(env, suppliedStore);
  if (
    current &&
    snapshotMatchesDashboard(current, dashboard) &&
    (await trafficSnapshotReadiness(env, suppliedStore)).status === "ok"
  ) {
    return current;
  }

  const identity = trafficSnapshotPointerKey(env);
  const inFlight = inFlightBuilds.get(identity);
  if (inFlight) return inFlight;

  const build = Promise.resolve().then(async () => {
    const refreshed = await readCurrentDashboardSnapshot(env, suppliedStore);
    if (
      refreshed &&
      snapshotMatchesDashboard(refreshed, dashboard) &&
      (await trafficSnapshotReadiness(env, suppliedStore)).status === "ok"
    ) {
      return refreshed;
    }

    await buildTrafficSnapshot(dashboard, {
      env,
      store: suppliedStore,
      beforeActivate
    });
    const materialized = await readCurrentDashboardSnapshot(env, suppliedStore);
    if (!materialized || !snapshotMatchesDashboard(materialized, dashboard)) {
      throw new Error("The Redis traffic cache does not match the latest MySQL dashboard data.");
    }
    return materialized;
  }).finally(() => {
    inFlightBuilds.delete(identity);
  });

  inFlightBuilds.set(identity, build);
  return build;
}
