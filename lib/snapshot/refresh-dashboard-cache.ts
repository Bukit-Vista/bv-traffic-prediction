import { dashboardCacheMatches, getMySqlSourceDashboardData } from "@/lib/api/bootstrap";
import {
  getRedisCacheConfig,
  getRedisCacheStore,
  type RedisCacheEnv
} from "@/lib/cache/redis-json";
import { ApiUnavailableError } from "@/lib/api/core";
import type { SourceDashboardData } from "@/lib/dashboard/types";
import { ensureLatestTrafficSnapshot } from "@/lib/snapshot/ensure-traffic-snapshot";
import { readCurrentDashboardSnapshot } from "@/lib/snapshot/traffic-snapshot";

export type DashboardCacheRefreshResult = {
  dashboard: SourceDashboardData;
  cacheAction: "reused" | "rebuilt" | "live_fallback";
};

let inFlight: Promise<DashboardCacheRefreshResult> | null = null;

export const MANUAL_REFRESH_COOLDOWN_SECONDS = 120;

export function manualRefreshLockKey(env: RedisCacheEnv = process.env) {
  return `${getRedisCacheConfig(env).namespace}:locks:dashboard-manual-refresh`;
}

async function performRefresh(): Promise<DashboardCacheRefreshResult> {
  const store = await getRedisCacheStore();
  if (!store) {
    throw new ApiUnavailableError(
      "Redis is required to coordinate a manual dashboard refresh."
    );
  }
  const acquired = await store.set(
    manualRefreshLockKey(),
    new Date().toISOString(),
    {
      EX: MANUAL_REFRESH_COOLDOWN_SECONDS,
      NX: true
    }
  );
  if (acquired !== "OK") {
    const current = await readCurrentDashboardSnapshot();
    if (current) return { dashboard: current, cacheAction: "reused" };
    throw new ApiUnavailableError(
      "A dashboard refresh is already in progress. Retry after the cooldown."
    );
  }

  const live = await getMySqlSourceDashboardData();
  const current = await readCurrentDashboardSnapshot();
  if (current && dashboardCacheMatches(live, current)) {
    return { dashboard: current, cacheAction: "reused" };
  }
  try {
    const rebuilt = await ensureLatestTrafficSnapshot(live);
    if (!rebuilt || !dashboardCacheMatches(live, rebuilt)) {
      throw new Error("The rebuilt snapshot identity does not match the live source.");
    }
    return { dashboard: rebuilt, cacheAction: "rebuilt" };
  } catch {
    return { dashboard: { ...live, trafficTiles: null }, cacheAction: "live_fallback" };
  }
}

export function refreshDashboardCache() {
  if (inFlight) return inFlight;
  inFlight = performRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
