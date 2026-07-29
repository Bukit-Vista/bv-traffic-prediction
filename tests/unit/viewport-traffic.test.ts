import { describe, expect, it } from "vitest";
import type { FeatureCollection, FlowProperties, RouteSummary } from "@/lib/dashboard/types";
import { calculateViewportTrafficOverview, flowGeometryIntersectsBbox } from "@/lib/map/viewport-traffic";

function segment(input: {
  id: number;
  coordinates: [[number, number], [number, number]];
  jamFactor: number;
  confidence: number;
  lengthMeters: number;
  roadClosure?: boolean;
}) {
  return {
    type: "Feature" as const,
    id: input.id,
    geometry: { type: "LineString" as const, coordinates: input.coordinates },
    properties: {
      segmentId: input.id, segmentKey: `segment-${input.id}`, roadName: `Road ${input.id}`,
      functionalClass: 2, lengthMeters: input.lengthMeters, speedKph: 20, freeFlowKph: 40,
      relativeSpeed: 0.5, jamFactor: input.jamFactor, jamTendency: 0,
      confidence: input.confidence, traversability: "open", roadClosure: input.roadClosure ?? false
    }
  };
}

const route = {
  id: 1, slug: "airport-canggu", name: "Airport to Canggu", originLabel: "Airport", destinationLabel: "Canggu",
  category: "airport", routePurpose: "airport_tourism", routeGroupKey: "canggu", tourismCenterKey: "canggu",
  routeDirection: "from_airport", distanceMeters: 20_000, typicalSeconds: 1000, liveSeconds: 1200,
  delaySeconds: 200, congestionRatio: 1.2, sampleHourUtc: "2026-07-19T00:00:00.000Z",
  confidence: null, status: "fresh", geometryAvailable: true, ratioVsTypical: 1.2
} satisfies RouteSummary;

describe("cached province Flow viewport calculations", () => {
  it("detects a road crossing the viewport even when both endpoints are outside", () => {
    expect(flowGeometryIntersectsBbox(
      { type: "LineString", coordinates: [[114.9, -8.5], [115.2, -8.5]] },
      [115, -8.6, 115.1, -8.4]
    )).toBe(true);
  });

  it("derives cards locally using viewport and confidence without another source query", () => {
    const flow: FeatureCollection<FlowProperties> = {
      type: "FeatureCollection",
      features: [
        segment({ id: 1, coordinates: [[115, -8.5], [115.01, -8.5]], jamFactor: 8, confidence: 0.9, lengthMeters: 1000, roadClosure: true }),
        segment({ id: 2, coordinates: [[115.01, -8.5], [115.02, -8.5]], jamFactor: 2, confidence: 0.8, lengthMeters: 3000 }),
        segment({ id: 3, coordinates: [[115.01, -8.51], [115.02, -8.51]], jamFactor: 10, confidence: 0.2, lengthMeters: 5000 }),
        segment({ id: 4, coordinates: [[115.5, -8.8], [115.51, -8.8]], jamFactor: 10, confidence: 1, lengthMeters: 9000 })
      ]
    };
    const overview = calculateViewportTrafficOverview({
      flow, routes: [route], bbox: [114.99, -8.6, 115.1, -8.4], minimumConfidence: 0.5, coverage: 1
    });
    expect(overview.measuredLengthMeters).toBe(4000);
    expect(overview.weightedJamFactor).toBe(3.5);
    expect(overview.congestedRoadShare).toBe(0.25);
    expect(overview.closures).toBe(1);
    expect(overview.slowestRoute?.id).toBe(1);
  });
});
