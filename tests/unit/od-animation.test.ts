import { describe, expect, it } from "vitest";
import type { FeatureCollection, MobilityFlowProperties } from "@/lib/dashboard/types";
import {
  congestionOdParticleCount,
  createOdEndpointCollection,
  createOdParticleCollection,
  interpolateLineString,
  OD_ANIMATION_FPS,
  OD_ANIMATION_SPEED_MULTIPLIER,
  odRouteCongestionIndex,
  odParticleCount
} from "@/lib/map/od-animation";

const flows: FeatureCollection<MobilityFlowProperties> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "high-flow",
      geometry: { type: "LineString", coordinates: [[115, -8.5], [116, -8.5]] },
      properties: {
        originZoneId: 1,
        destinationZoneId: 2,
        originName: "Origin",
        destinationName: "Destination",
        mobilityScore: 90,
        predictedShare: 0.3,
        travelTimeSeconds: 1_800,
        confidence: 0.8,
        modelVersion: "test",
        metricSemantics: "relative_prediction_not_people_count"
      }
    },
    {
      type: "Feature",
      id: "low-flow",
      geometry: { type: "LineString", coordinates: [[114, -8], [114.5, -8]] },
      properties: {
        originZoneId: 3,
        destinationZoneId: 4,
        originName: "Low origin",
        destinationName: "Low destination",
        mobilityScore: 20,
        predictedShare: 0.05,
        travelTimeSeconds: 3_600,
        confidence: 0.5,
        modelVersion: "test",
        metricSemantics: "relative_prediction_not_people_count"
      }
    }
  ]
};

describe("OD flow animation", () => {
  it("interpolates across every segment in a polyline", () => {
    expect(interpolateLineString([[0, 0], [1, 0], [3, 0]], 0.5)).toEqual([1.5, 0]);
  });

  it("keeps a moving arrow on a multi-segment road path", () => {
    const roadFlow: FeatureCollection<MobilityFlowProperties> = {
      type: "FeatureCollection",
      features: [{
        ...flows.features[0]!,
        id: "road-flow",
        geometry: { type: "LineString", coordinates: [[0, 0], [0, 1], [1, 1]] },
        properties: { ...flows.features[0]!.properties, pathSemantics: "cached_here_road_path" }
      }]
    };
    const particle = createOdParticleCollection(roadFlow, 2_100).features[0]!;
    if (particle.geometry.type !== "Point") throw new Error("Expected a point particle");
    const [longitude, latitude] = particle.geometry.coordinates;
    expect(longitude === 0 || latitude === 1).toBe(true);
  });

  it("uses particle density to communicate the relative mobility score", () => {
    expect(odParticleCount(20)).toBe(1);
    expect(odParticleCount(90)).toBe(4);
    const particles = createOdParticleCollection(flows, 1_000);
    expect(particles.features.filter((feature) => feature.properties.flowId === "high-flow")).toHaveLength(4);
    expect(particles.features.filter((feature) => feature.properties.flowId === "low-flow")).toHaveLength(1);
  });

  it("moves particles from the origin toward the destination and filters low scores", () => {
    const atStart = createOdParticleCollection(flows, 0).features.find((feature) => feature.id === "high-flow-particle-0")!;
    const later = createOdParticleCollection(flows, 800).features.find((feature) => feature.id === "high-flow-particle-0")!;
    if (atStart.geometry.type !== "Point" || later.geometry.type !== "Point") throw new Error("Expected point particles");
    expect(later.geometry.coordinates[0]).toBeGreaterThan(atStart.geometry.coordinates[0]);

    const filtered = createOdParticleCollection(flows, 800, { minimumScore: 50 });
    expect(new Set(filtered.features.map((feature) => feature.properties.flowId))).toEqual(new Set(["high-flow"]));
  });

  it("runs OD movement at half of the previous global speed", () => {
    expect(OD_ANIMATION_FPS).toBe(24);
    expect(OD_ANIMATION_SPEED_MULTIPLIER).toBe(0.5);
    const particle = createOdParticleCollection(flows, 800).features
      .find((feature) => feature.id === "high-flow-particle-0")!;
    if (particle.geometry.type !== "Point") throw new Error("Expected a point particle");
    const previousDurationMs = 3_200 + flows.features[0]!.properties.travelTimeSeconds! * 0.9;
    expect(particle.geometry.coordinates[0]).toBeCloseTo(
      115 + 800 / (previousDurationMs / OD_ANIMATION_SPEED_MULTIPLIER)
    );
  });

  it("uses jam along any traffic-guided OD route for progressively longer arrow trains", () => {
    const jamFlows: FeatureCollection<MobilityFlowProperties> = {
      type: "FeatureCollection",
      features: [1, 5, 9].map((routeWeightedJamFactor, index) => ({
        ...flows.features[0]!,
        id: `jam-${routeWeightedJamFactor}`,
        properties: {
          ...flows.features[0]!.properties,
          flowVisualMode: "general_od",
          routeWeightedJamFactor
        },
        geometry: {
          type: "LineString",
          coordinates: [[115, -8.5 - index * 0.01], [116, -8.5 - index * 0.01]]
        }
      }))
    };
    const particles = createOdParticleCollection(jamFlows, 800);
    expect(particles.features.filter((feature) => feature.properties.flowId === "jam-1")).toHaveLength(1);
    expect(particles.features.filter((feature) => feature.properties.flowId === "jam-5")).toHaveLength(3);
    expect(particles.features.filter((feature) => feature.properties.flowId === "jam-9")).toHaveLength(5);
    expect(odRouteCongestionIndex(jamFlows.features[2]!.properties)).toBeCloseTo(0.9);
    expect(congestionOdParticleCount(jamFlows.features[2]!.properties)).toBe(5);
    expect(createOdEndpointCollection(jamFlows).features[1]?.properties.directionalCongestionIndex)
      .toBeCloseTo(0.1);
  });

  it("keeps strong-flow arrows close together as a moving train", () => {
    const particles = createOdParticleCollection(flows, 2_000).features
      .filter((feature) => feature.properties.flowId === "high-flow");
    const longitudes = particles.map((feature) =>
      feature.geometry.type === "Point" ? feature.geometry.coordinates[0] : 0
    ).sort((left, right) => left - right);
    expect(longitudes).toHaveLength(4);
    for (let index = 1; index < longitudes.length; index += 1) {
      expect(longitudes[index]! - longitudes[index - 1]!).toBeLessThan(0.06);
    }
  });

  it("provides fixed origin and destination cues when motion is reduced", () => {
    const first = createOdParticleCollection(flows, 0, { reducedMotion: true });
    const later = createOdParticleCollection(flows, 5_000, { reducedMotion: true });
    expect(first).toEqual(later);
    expect(first.features).toHaveLength(2);

    const endpoints = createOdEndpointCollection(flows, 50);
    expect(endpoints.features.map((feature) => feature.properties.endpointType)).toEqual(["origin", "destination"]);
    expect(endpoints.features[0]?.geometry).toEqual({ type: "Point", coordinates: [115, -8.5] });
    expect(endpoints.features[1]?.geometry).toEqual({ type: "Point", coordinates: [116, -8.5] });
    expect(endpoints.features[1]?.properties.arrowRotation).toBeCloseTo(0);
  });

  it("keeps asymmetric reverse records separate with destination-only arrow cues", () => {
    const asymmetric: FeatureCollection<MobilityFlowProperties> = {
      type: "FeatureCollection",
      features: [
        {
          ...flows.features[0]!,
          id: "dps-to-denpasar",
          geometry: { type: "LineString", coordinates: [[115.16, -8.74], [115.22, -8.67]] },
          properties: {
            ...flows.features[0]!.properties,
            originName: "DPS Airport Gateway",
            destinationName: "Denpasar Urban",
            mobilityScore: 51.66
          }
        },
        {
          ...flows.features[0]!,
          id: "denpasar-to-dps",
          geometry: { type: "LineString", coordinates: [[115.22, -8.67], [115.16, -8.74]] },
          properties: {
            ...flows.features[0]!.properties,
            originName: "Denpasar Urban",
            destinationName: "DPS Airport Gateway",
            mobilityScore: 7.25
          }
        }
      ]
    };
    const endpoints = createOdEndpointCollection(asymmetric);
    const destinations = endpoints.features.filter(
      (feature) => feature.properties.endpointType === "destination"
    );
    expect(destinations).toHaveLength(2);
    expect(destinations[0]).toMatchObject({
      geometry: { type: "Point", coordinates: [115.22, -8.67] },
      properties: {
        originName: "DPS Airport Gateway",
        destinationName: "Denpasar Urban",
        mobilityScore: 51.66
      }
    });
    expect(destinations[1]).toMatchObject({
      geometry: { type: "Point", coordinates: [115.16, -8.74] },
      properties: {
        originName: "Denpasar Urban",
        destinationName: "DPS Airport Gateway",
        mobilityScore: 7.25
      }
    });
    const particles = createOdParticleCollection(asymmetric, 800);
    expect(new Set(particles.features.map((feature) => feature.properties.mobilityScore)))
      .toEqual(new Set([51.66, 7.25]));
  });
});
