import { dashboardCacheMatches, getMySqlSourceDashboardData } from "@/lib/api/bootstrap";
import type { SourceDashboardData } from "@/lib/dashboard/types";
import { ensureLatestTrafficSnapshot } from "@/lib/snapshot/ensure-traffic-snapshot";
import { readCurrentDashboardSnapshot } from "@/lib/snapshot/traffic-snapshot";

export type DashboardCacheRefreshResult = {
  dashboard: SourceDashboardData;
  cacheAction: "reused" | "rebuilt" | "live_fallback";
};

let inFlight: Promise<DashboardCacheRefreshResult> | null = null;

async function performRefresh(): Promise<DashboardCacheRefreshResult> {
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
