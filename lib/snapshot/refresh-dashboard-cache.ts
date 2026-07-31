import {
  dashboardCacheMatches,
  dashboardSnapshotMatches,
  getMySqlSourceDashboardData
} from "@/lib/api/bootstrap";
import { getDashboardVersionIdentities } from "@/lib/api/data-source";
import {
  getRedisCacheConfig,
  getRedisCacheStore,
  type RedisCacheEnv,
  type RedisCacheStore
} from "@/lib/cache/redis-json";
import { acquireRedisLease, maintainRedisLease } from "@/lib/cache/redis-lease";
import { ApiUnavailableError } from "@/lib/api/core";
import type { SourceDashboardData } from "@/lib/dashboard/types";
import { ensureLatestTrafficSnapshot } from "@/lib/snapshot/ensure-traffic-snapshot";
import {
  readCurrentDashboardSnapshot,
  trafficSnapshotReadiness,
  type TrafficSnapshotEnv
} from "@/lib/snapshot/traffic-snapshot";

export type DashboardCacheRefreshResult = {
  dashboard: SourceDashboardData;
  cacheAction: "reused" | "rebuilt";
};

let inFlight: Promise<DashboardCacheRefreshResult> | null = null;

export const REFRESH_LEASE_SECONDS = 15 * 60;
export const REFRESH_LEASE_RENEWAL_MS = 30_000;

export function manualRefreshLockKey(env: RedisCacheEnv = process.env) {
  return `${getRedisCacheConfig(env).namespace}:locks:dashboard-manual-refresh`;
}

type RefreshDependencies = {
  env?: TrafficSnapshotEnv;
  store?: RedisCacheStore | null;
  readCurrent?: typeof readCurrentDashboardSnapshot;
  readiness?: typeof trafficSnapshotReadiness;
  loadIdentities?: typeof getDashboardVersionIdentities;
  loadLive?: typeof getMySqlSourceDashboardData;
  ensureSnapshot?: typeof ensureLatestTrafficSnapshot;
};

export async function performDashboardRefresh(
  dependencies: RefreshDependencies = {}
): Promise<DashboardCacheRefreshResult> {
  const env = dependencies.env ?? process.env;
  const store = Object.prototype.hasOwnProperty.call(dependencies, "store")
    ? dependencies.store ?? null
    : await getRedisCacheStore(env);
  if (!store) {
    throw new ApiUnavailableError(
      "Redis is required to coordinate a dashboard refresh."
    );
  }
  const readCurrent = dependencies.readCurrent ?? readCurrentDashboardSnapshot;
  const readiness = dependencies.readiness ?? trafficSnapshotReadiness;
  const lease = await acquireRedisLease(
    store,
    manualRefreshLockKey(env),
    REFRESH_LEASE_SECONDS
  );
  if (!lease) {
    const current = await readCurrent(env, store);
    if (current && (await readiness(env, store)).status === "ok") {
      return { dashboard: current, cacheAction: "reused" };
    }
    throw new ApiUnavailableError(
      "A dashboard refresh is already in progress and no complete snapshot is available yet."
    );
  }
  const leaseMaintenance = maintainRedisLease(
    store,
    lease,
    REFRESH_LEASE_RENEWAL_MS
  );

  try {
    const current = await readCurrent(env, store);
    if (
      current &&
      (await readiness(env, store)).status === "ok" &&
      dashboardSnapshotMatches(
        await (dependencies.loadIdentities ?? getDashboardVersionIdentities)(),
        current
      )
    ) {
      return { dashboard: current, cacheAction: "reused" };
    }

    const live = await (dependencies.loadLive ?? getMySqlSourceDashboardData)();
    if (
      current &&
      dashboardCacheMatches(live, current) &&
      (await readiness(env, store)).status === "ok"
    ) {
      return { dashboard: current, cacheAction: "reused" };
    }

    const rebuilt = await (dependencies.ensureSnapshot ?? ensureLatestTrafficSnapshot)(
      live,
      env,
      store,
      leaseMaintenance.assertOwned
    ).catch(() => null);
    if (!rebuilt || !dashboardCacheMatches(live, rebuilt)) {
      throw new ApiUnavailableError(
        "The dashboard refresh did not publish a complete Redis snapshot.",
        current?.generatedAt ?? null
      );
    }
    return { dashboard: rebuilt, cacheAction: "rebuilt" };
  } finally {
    await leaseMaintenance.stop();
  }
}

export function refreshDashboardCache() {
  if (inFlight) return inFlight;
  inFlight = performDashboardRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
