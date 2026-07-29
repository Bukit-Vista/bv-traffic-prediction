import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  CONGESTED_JAM_FACTOR,
  PULSE_MIN_JAM_FACTOR,
  TRAFFIC_JAM_LEGEND,
  createTrafficHeatmapCollection,
  distanceMeters,
  sampleLineAtSpacing,
  trafficHeartbeatBeat,
  trafficHeartbeatMultiplier,
  trafficHeartbeatOpacityExpression,
  trafficHeartbeatPeriodMs,
  trafficHeartbeatRadius,
  trafficHeartbeatRadiusExpression,
  TRAFFIC_HEARTBEAT_ENABLED,
  TRAFFIC_HEARTBEAT_FPS,
  trafficJamColorExpression,
  trafficJamPointRadiusExpression
} from "@/lib/map/traffic-heatmap";
import type { FeatureCollection, FlowProperties } from "@/lib/dashboard/types";

function flow(jamFactor: number | null, roadClosure = false): FeatureCollection<FlowProperties> {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature", id: "segment-1",
      geometry: { type: "LineString", coordinates: [[115, -8.5], [115.01, -8.5]] },
      properties: {
        segmentId: 1, segmentKey: "segment-1", roadName: "Test Road", functionalClass: 2,
        speedKph: 20, freeFlowKph: 40, relativeSpeed: .5, jamFactor, jamTendency: 0,
        confidence: .8, traversability: "open", roadClosure
      }
    }]
  };
}

describe("HERE traffic heatmap", () => {
  it("samples long road geometry at consistent real-world intervals", () => {
    const points = sampleLineAtSpacing([[115, -8.5], [115.01, -8.5]], 300);
    expect(points.length).toBeGreaterThanOrEqual(3);
    expect(distanceMeters(points[0]!, points[1]!)).toBeCloseTo(300, -1);
  });

  it("uses measured jam factor and confidence without inventing locations", () => {
    const result = createTrafficHeatmapCollection(flow(8), { spacingMeters: 300 });
    expect(result.features.length).toBeGreaterThan(0);
    expect(result.features[0]?.geometry.type).toBe("Point");
    expect(result.features[0]?.properties).toMatchObject({ segmentId: 1, jamFactor: 8, confidence: .8 });
    expect(result.features[0]?.properties.heatWeight).toBeGreaterThan(.5);
    expect(createTrafficHeatmapCollection(flow(8), { spacingMeters: 150 }).features.length).toBeGreaterThan(result.features.length);
    expect(createTrafficHeatmapCollection(flow(8), { spacingMeters: 1, maximumPoints: 100 }).features.length).toBeLessThanOrEqual(100);
    expect(createTrafficHeatmapCollection(flow(0)).features[0]?.properties.jamFactor).toBe(0);
  });

  it("omits unmeasured non-closure segments and treats measured closures as maximum jam", () => {
    expect(createTrafficHeatmapCollection(flow(null)).features).toHaveLength(0);
    expect(createTrafficHeatmapCollection(flow(null, true)).features[0]?.properties.jamFactor).toBe(10);
  });

  it("pulses high jam faster and more strongly while supporting reduced motion", () => {
    expect(trafficHeartbeatPeriodMs(10)).toBeLessThan(trafficHeartbeatPeriodMs(2));
    expect(trafficHeartbeatPeriodMs(10)).toBe(1600);
    expect(trafficHeartbeatPeriodMs(6)).toBe(2400);
    const lowSamples = Array.from({ length: 240 }, (_, index) => trafficHeartbeatMultiplier(index * 25, 2));
    const highSamples = Array.from({ length: 240 }, (_, index) => trafficHeartbeatMultiplier(index * 25, 10));
    expect(Math.max(...highSamples) - Math.min(...highSamples)).toBeGreaterThan(Math.max(...lowSamples) - Math.min(...lowSamples));
    const highPeriod = trafficHeartbeatPeriodMs(10);
    const smoothCycle = Array.from({ length: Math.ceil(highPeriod / 25) + 1 }, (_, index) => trafficHeartbeatBeat(index * 25, 10));
    const frameChanges = smoothCycle.slice(1).map((value, index) => Math.abs(value - smoothCycle[index]!));
    expect(Math.max(...smoothCycle)).toBeGreaterThan(0.99);
    expect(Math.max(...frameChanges)).toBeLessThan(0.15);
    expect(trafficHeartbeatBeat(0, 10)).toBe(0);
    expect(trafficHeartbeatRadius(highPeriod * 0.38, 10)).toBeCloseTo(10, 1);
    expect(trafficHeartbeatRadius(trafficHeartbeatPeriodMs(0) * 0.38, 0)).toBeGreaterThan(trafficHeartbeatRadius(0, 0));
    expect(trafficHeartbeatMultiplier(100, 10, true)).toBe(1);
    expect(CONGESTED_JAM_FACTOR).toBe(6);
    expect(PULSE_MIN_JAM_FACTOR).toBe(6);
    expect(TRAFFIC_HEARTBEAT_ENABLED).toBe(false);
    expect(TRAFFIC_HEARTBEAT_FPS).toBe(12);
    expect(TRAFFIC_JAM_LEGEND.map((stop) => stop.label)).toEqual(["Free", "Light", "Moderate", "Congested", "Severe", "Max jam"]);
    expect(trafficJamColorExpression()).toEqual(["step", ["coalesce", ["get", "jamFactor"], 0], "#2d9b6f", 2, "#9fba4a", 4, "#e9aa40", 6, "#d95345", 8, "#a72e36", 10, "#35131b"]);
    expect(trafficHeartbeatRadiusExpression(300)).toContain("interpolate");
    expect(trafficHeartbeatOpacityExpression(300)).toContain("interpolate");
    expect(JSON.stringify(trafficJamPointRadiusExpression())).toContain("zoom");
  });

  it("produces valid zoom-adaptive MapLibre point styles", () => {
    const errors = validateStyleMin({
      version: 8,
      sources: { heat: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      layers: [{
        id: "jam-points", type: "circle", source: "heat",
        paint: {
          "circle-color": trafficJamColorExpression() as never,
          "circle-radius": trafficJamPointRadiusExpression() as never,
          "circle-blur": ["interpolate", ["linear"], ["zoom"], 7, 0.82, 11, 0.55, 15, 0.28, 19, 0.08]
        }
      }]
    });
    expect(errors.map((error) => error.message)).toEqual([]);
  });
});
