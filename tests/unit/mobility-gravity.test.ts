import { describe, expect, it } from "vitest";
import config from "@/config/mobility-model.gravity-v1.json";
import { runGravityModel, type GravityZone } from "@/lib/mobility/gravity";

const zones: GravityZone[] = [
  { id: 1, populationPotential: .9, departureFactor: .8, attractionScore: .5, arrivalFactor: .8, trafficActivityScore: .7, incidentPenalty: .1, trafficConfidence: .9, inputCoverage: .95, poiCompleteness: .8 },
  { id: 2, populationPotential: .6, departureFactor: .7, attractionScore: .95, arrivalFactor: 1, trafficActivityScore: .8, incidentPenalty: .05, trafficConfidence: .8, inputCoverage: .9, poiCompleteness: .95 },
  { id: 3, populationPotential: .4, departureFactor: .6, attractionScore: .45, arrivalFactor: .7, trafficActivityScore: .4, incidentPenalty: .2, trafficConfidence: .7, inputCoverage: .8, poiCompleteness: .7 }
];

const candidates = [
  { originZoneId: 1, destinationZoneId: 2, travelTimeMinutes: 20, travelTimeFreshness: .9 },
  { originZoneId: 1, destinationZoneId: 3, travelTimeMinutes: 30, travelTimeFreshness: .8 },
  { originZoneId: 2, destinationZoneId: 1, travelTimeMinutes: 20, travelTimeFreshness: .9 },
  { originZoneId: 2, destinationZoneId: 3, travelTimeMinutes: 18, travelTimeFreshness: .7 },
  { originZoneId: 3, destinationZoneId: 2, travelTimeMinutes: 18, travelTimeFreshness: .7 }
];

describe("deterministic gravity mobility model", () => {
  it("is reproducible and bounds normalized outputs", () => {
    const first = runGravityModel(zones, candidates, config);
    const second = runGravityModel(zones, candidates, config);
    expect(second).toEqual(first);
    expect(first.odPredictions.every((item) => item.mobilityScore >= 0 && item.mobilityScore <= 100 && item.confidence >= 0 && item.confidence <= 1)).toBe(true);
    expect(first.zonePredictions.every((item) => item.presenceScore >= 0 && item.presenceScore <= 100 && item.inboundScore <= 100 && item.outboundScore <= 100)).toBe(true);
  });

  it("reconciles retained destination shares per origin", () => {
    const result = runGravityModel(zones, candidates, config);
    for (const origin of new Set(result.odPredictions.map((item) => item.originZoneId))) {
      const total = result.odPredictions.filter((item) => item.originZoneId === origin).reduce((sum, item) => sum + item.predictedShare, 0);
      expect(total).toBeCloseTo(1, 7);
    }
  });

  it("caps candidate fan-out from configuration", () => {
    const result = runGravityModel(zones, candidates, { ...config, maximumDestinationsPerOrigin: 1 });
    expect(result.odPredictions.filter((item) => item.originZoneId === 1)).toHaveLength(1);
    expect(result.suppressedCandidateCount).toBe(2);
  });
});

