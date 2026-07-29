import type { Route, RouteSample } from "@/lib/db/types";
import { calculateCongestionScore } from "@/lib/analytics/congestion";

export type LatestRouteInput = {
  route: Route;
  sample: RouteSample | null;
};

export type RankedRoute = LatestRouteInput & {
  score: number | null;
  status: "fresh" | "stale" | "missing";
  rank: number | null;
};

export function rankLatestRoutes(
  input: LatestRouteInput[],
  now = new Date(),
  staleAfterHours = 2
): RankedRoute[] {
  const staleCutoffMs = now.getTime() - staleAfterHours * 60 * 60 * 1000;
  const mapped = input.map((item) => {
    const score = item.sample ? calculateCongestionScore(item.sample) : null;
    const status = !item.sample
      ? "missing"
      : new Date(item.sample.sampleHour).getTime() < staleCutoffMs
        ? "stale"
        : "fresh";

    return {
      ...item,
      score,
      status,
      rank: null
    } satisfies RankedRoute;
  });

  const fresh = mapped
    .filter((item) => item.status === "fresh")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((item, index) => ({ ...item, rank: index + 1 }));

  const stale = mapped
    .filter((item) => item.status === "stale")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const missing = mapped
    .filter((item) => item.status === "missing")
    .sort((a, b) => a.route.originLabel.localeCompare(b.route.originLabel));

  return [...fresh, ...stale, ...missing];
}
