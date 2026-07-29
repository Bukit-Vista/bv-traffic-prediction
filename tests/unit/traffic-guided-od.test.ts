import { describe, expect, it } from "vitest";
import type {
  FeatureCollection,
  FlowProperties,
  MobilityFlowProperties,
  Position
} from "@/lib/dashboard/types";
import { guideOdFlowsByTraffic } from "@/lib/map/traffic-guided-od";

function trafficFeature(id: number, coordinates: Position[], jamFactor: number) {
  return {
    type: "Feature" as const,
    id,
    geometry: { type: "LineString" as const, coordinates },
    properties: {
      segmentId: id,
      segmentKey: `segment-${id}`,
      roadName: `Road ${id}`,
      functionalClass: 2,
      speedKph: 20,
      freeFlowKph: 50,
      relativeSpeed: 0.4,
      jamFactor,
      jamTendency: 0,
      confidence: 1,
      traversability: "open",
      roadClosure: false
    } satisfies FlowProperties
  };
}

function odFlow(): FeatureCollection<MobilityFlowProperties> {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      id: "od-1-2",
      geometry: { type: "LineString", coordinates: [[0, 0], [0.02, 0]] },
      properties: {
        originZoneId: 1,
        destinationZoneId: 2,
        originName: "Origin",
        destinationName: "Destination",
        mobilityScore: 80,
        predictedShare: 0.4,
        travelTimeSeconds: 100,
        confidence: 1,
        modelVersion: "test",
        metricSemantics: "relative_prediction_not_people_count"
      }
    }]
  };
}

describe("traffic-guided OD routing", () => {
  it("prefers a slightly longer heavily jammed path over an uncongested direct path", () => {
    const traffic: FeatureCollection<FlowProperties> = {
      type: "FeatureCollection",
      features: [
        trafficFeature(1, [[0, 0], [0.01, 0], [0.02, 0]], 0),
        trafficFeature(2, [[0, 0], [0.01, 0.004], [0.02, 0]], 10)
      ]
    };
    const routed = guideOdFlowsByTraffic(odFlow(), traffic);
    expect(routed.features[0]?.geometry).toEqual({
      type: "LineString",
      coordinates: [[0, 0], [0.01, 0.004], [0.02, 0]]
    });
    expect(routed.features[0]?.properties.pathSemantics).toBe("traffic_network_guided");
    expect(routed.features[0]?.properties.routeWeightedJamFactor).toBeCloseTo(10);
  });

  it("does not take a very long detour solely to seek congestion", () => {
    const traffic: FeatureCollection<FlowProperties> = {
      type: "FeatureCollection",
      features: [
        trafficFeature(1, [[0, 0], [0.01, 0], [0.02, 0]], 0),
        trafficFeature(2, [[0, 0], [0.01, 0.02], [0.02, 0]], 10)
      ]
    };
    const routed = guideOdFlowsByTraffic(odFlow(), traffic);
    expect(routed.features[0]?.geometry).toEqual({
      type: "LineString",
      coordinates: [[0, 0], [0.02, 0]]
    });
    expect(routed.features[0]?.properties.routeWeightedJamFactor).toBeCloseTo(0);
  });

  it("keeps authoritative OD coordinates when the traffic route snaps to nearby nodes", () => {
    const traffic: FeatureCollection<FlowProperties> = {
      type: "FeatureCollection",
      features: [
        trafficFeature(1, [[0.001, 0], [0.01, 0.003], [0.019, 0]], 8)
      ]
    };
    const routed = guideOdFlowsByTraffic(odFlow(), traffic);
    expect(routed.features[0]?.geometry).toEqual({
      type: "LineString",
      coordinates: [[0, 0], [0.001, 0], [0.01, 0.003], [0.019, 0], [0.02, 0]]
    });
    expect(routed.features[0]?.properties).toMatchObject({
      originName: "Origin",
      destinationName: "Destination",
      mobilityScore: 80,
      routeWeightedJamFactor: 8
    });
  });
});
