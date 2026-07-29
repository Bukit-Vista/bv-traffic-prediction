import { describe, expect, it } from "vitest";
import { calculateCongestionScore } from "@/lib/analytics/congestion";
import { buildHeatmap } from "@/lib/analytics/heatmap";
import { rankLatestRoutes } from "@/lib/analytics/ranking";
import { getLocalHour } from "@/lib/analytics/time";
import type { Route, RouteSample } from "@/lib/db/types";

function route(id: number, label: string): Route {
  return {
    id,
    slug: label.toLowerCase(),
    originLabel: label,
    originLat: -8,
    originLng: 115,
    destinationLabel: "Destination",
    destinationLat: -8.5,
    destinationLng: 115.5,
    category: "test",
    active: true,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z"
  };
}

function sample(routeId: number, sampleHour: string, score: number): RouteSample {
  return {
    id: routeId * 10,
    routeId,
    sampledAt: sampleHour,
    sampleHour,
    distanceMeters: 1000,
    durationSeconds: 100,
    trafficDurationSeconds: Math.round(score * 100),
    trafficDelaySeconds: Math.round(score * 100) - 100,
    congestionScore: score,
    trafficSource: "live",
    ingestionRunId: null,
    provider: "here",
    apiProduct: "routing_v8_calculate_route",
    httpStatus: 200,
    trackingId: null,
    rawSummaryJson: null
  };
}

describe("analytics", () => {
  it("calculates congestion scores", () => {
    expect(calculateCongestionScore({ durationSeconds: 100, trafficDurationSeconds: 135 })).toBe(
      1.35
    );
    expect(calculateCongestionScore({ durationSeconds: 0, trafficDurationSeconds: 10 })).toBeNull();
  });

  it("ranks fresh routes, then stale routes, then missing routes", () => {
    const now = new Date("2026-07-13T04:30:00.000Z");
    const ranked = rankLatestRoutes(
      [
        { route: route(1, "A"), sample: sample(1, "2026-07-13T04:00:00.000Z", 1.1) },
        { route: route(2, "B"), sample: sample(2, "2026-07-13T04:00:00.000Z", 1.4) },
        { route: route(3, "C"), sample: sample(3, "2026-07-13T01:00:00.000Z", 2.0) },
        { route: route(4, "D"), sample: null }
      ],
      now
    );

    expect(ranked.map((row) => row.route.id)).toEqual([2, 1, 3, 4]);
    expect(ranked.map((row) => row.status)).toEqual(["fresh", "fresh", "stale", "missing"]);
    expect(ranked.map((row) => row.rank)).toEqual([1, 2, null, null]);
  });

  it("groups sample hours in Asia/Makassar", () => {
    expect(getLocalHour("2026-07-12T16:00:00.000Z", "Asia/Makassar")).toBe(0);
    expect(getLocalHour("2026-07-13T15:00:00.000Z", "Asia/Makassar")).toBe(23);
  });

  it("averages sparse heatmap cells and leaves missing cells empty", () => {
    const rows = buildHeatmap(
      [route(1, "A")],
      [
        sample(1, "2026-07-12T16:00:00.000Z", 1.1),
        sample(1, "2026-07-13T16:00:00.000Z", 1.3),
        sample(1, "2026-07-13T17:00:00.000Z", 1.5)
      ],
      "Asia/Makassar"
    );

    expect(rows[0].cells[0]?.score).toBeCloseTo(1.2);
    expect(rows[0].cells[0]?.count).toBe(2);
    expect(rows[0].cells[0]?.liveCount).toBe(2);
    expect(rows[0].cells[0]?.historicalCount).toBe(0);
    expect(rows[0].cells[1]?.score).toBeCloseTo(1.5);
    expect(rows[0].cells[2]).toBeNull();
  });

});
