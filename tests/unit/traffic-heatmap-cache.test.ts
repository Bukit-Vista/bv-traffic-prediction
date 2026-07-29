import { beforeEach, describe, expect, it } from "vitest";
import type { FeatureCollection, FlowProperties } from "@/lib/dashboard/types";
import {
  clearTrafficHeatmapCache,
  getCachedTrafficHeatmap,
  getOrCreateTrafficHeatmap,
  trafficHeatmapLodForZoom
} from "@/lib/map/traffic-heatmap";

function flow(): FeatureCollection<FlowProperties> {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      id: "cached-segment",
      geometry: { type: "LineString", coordinates: [[115, -8.5], [115.1, -8.5]] },
      properties: {
        segmentId: 1,
        segmentKey: "cached-segment",
        roadName: "Cache Road",
        functionalClass: 2,
        speedKph: 20,
        freeFlowKph: 40,
        relativeSpeed: 0.5,
        jamFactor: 7,
        jamTendency: 0,
        confidence: 0.9,
        traversability: "open",
        roadClosure: false
      }
    }]
  };
}

describe("traffic heatmap level-of-detail cache", () => {
  beforeEach(() => clearTrafficHeatmapCache());

  it("selects stable province, regional, and street zoom buckets", () => {
    expect(trafficHeatmapLodForZoom(8.5)).toBe("province");
    expect(trafficHeatmapLodForZoom(11)).toBe("regional");
    expect(trafficHeatmapLodForZoom(14)).toBe("street");
  });

  it("reuses derived geometry for the same source object and version", () => {
    const source = flow();
    const first = getOrCreateTrafficHeatmap("run-1", source, "province");
    const second = getOrCreateTrafficHeatmap("run-1", source, "province");
    expect(second).toBe(first);
    expect(getCachedTrafficHeatmap("run-1", "province", source)).toBe(first);
  });

  it("invalidates a cache entry when the source payload changes under the same version", () => {
    const firstSource = flow();
    const secondSource = flow();
    const first = getOrCreateTrafficHeatmap("run-1", firstSource, "province");
    const second = getOrCreateTrafficHeatmap("run-1", secondSource, "province");
    expect(second).not.toBe(first);
  });

  it("adds detail progressively without changing real source geometry", () => {
    const source = flow();
    const province = getOrCreateTrafficHeatmap("run-1", source, "province");
    const regional = getOrCreateTrafficHeatmap("run-1", source, "regional");
    const street = getOrCreateTrafficHeatmap("run-1", source, "street");
    expect(regional.features.length).toBeGreaterThan(province.features.length);
    expect(street.features.length).toBeGreaterThan(regional.features.length);
    expect(street.features[0]?.properties.segmentId).toBe(1);
  });
});
