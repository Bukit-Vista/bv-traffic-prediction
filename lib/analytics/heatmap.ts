import type { Route, RouteSample } from "@/lib/db/types";
import { calculateCongestionScore } from "@/lib/analytics/congestion";
import { getLocalHour } from "@/lib/analytics/time";

export const MAX_HEATMAP_RANGE_DAYS = 7;

export type HeatmapCell = {
  hour: number;
  score: number;
  count: number;
  liveCount: number;
  historicalCount: number;
};

export type RouteHeatmapRow = {
  route: Route;
  cells: Array<HeatmapCell | null>;
};

export function buildHeatmap(
  routeRows: Route[],
  samples: RouteSample[],
  timeZone?: string
): RouteHeatmapRow[] {
  const buckets = new Map<
    string,
    { sum: number; count: number; liveCount: number; historicalCount: number }
  >();

  for (const sample of samples) {
    const score = calculateCongestionScore(sample);
    if (score == null) {
      continue;
    }

    const hour = getLocalHour(sample.sampleHour, timeZone);
    const key = `${sample.routeId}:${hour}`;
    const existing = buckets.get(key) ?? {
      sum: 0,
      count: 0,
      liveCount: 0,
      historicalCount: 0
    };
    existing.sum += score;
    existing.count += 1;
    if (sample.trafficSource === "historical") {
      existing.historicalCount += 1;
    } else {
      existing.liveCount += 1;
    }
    buckets.set(key, existing);
  }

  return routeRows.map((route) => ({
    route,
    cells: Array.from({ length: 24 }, (_, hour) => {
      const bucket = buckets.get(`${route.id}:${hour}`);
      if (!bucket) {
        return null;
      }

      return {
        hour,
        score: bucket.sum / bucket.count,
        count: bucket.count,
        liveCount: bucket.liveCount,
        historicalCount: bucket.historicalCount
      };
    })
  }));
}
