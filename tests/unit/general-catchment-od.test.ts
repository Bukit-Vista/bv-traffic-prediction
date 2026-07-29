import { describe, expect, it } from "vitest";
import {
  GENERAL_OD_MINIMUM_PREDICTED_SHARE,
  isGeneralOdPair,
  selectGeneralOdFlows
} from "@/lib/map/general-catchment-od";

const flows = [
  { originCatchmentKey: "sanur", destinationCatchmentKey: "kuta-legian", predictedShare: 0.12, confidence: 0.8 },
  { originCatchmentKey: "kuta-legian", destinationCatchmentKey: "sanur", predictedShare: 0.08, confidence: 0.9 },
  { originCatchmentKey: "sanur", destinationCatchmentKey: "ubud-central", predictedShare: 0.03, confidence: 0.9 },
  { originCatchmentKey: "sanur", destinationCatchmentKey: "dps-airport-gateway", predictedShare: 0.4, confidence: 0.9 },
  { originCatchmentKey: "dps-airport-gateway", destinationCatchmentKey: "sanur", predictedShare: 0.3, confidence: 0.9 }
];

describe("general catchment OD selection", () => {
  it("includes DPS Airport Gateway at both ends of general OD", () => {
    const generalPairs = flows.filter(isGeneralOdPair);
    expect(generalPairs).toHaveLength(5);
    expect(generalPairs.some((flow) =>
      flow.originCatchmentKey === "dps-airport-gateway" ||
      flow.destinationCatchmentKey === "dps-airport-gateway"
    )).toBe(true);
  });

  it("keeps selected inbound and outbound flows above the 1% display threshold", () => {
    expect(GENERAL_OD_MINIMUM_PREDICTED_SHARE).toBe(0.01);
    expect(selectGeneralOdFlows(flows, {
      focusCatchmentKey: "sanur",
      direction: "both",
      minimumPredictedShare: GENERAL_OD_MINIMUM_PREDICTED_SHARE,
      minimumConfidence: 0
    })).toEqual(flows);
  });

  it("applies direction and confidence while retaining airport pairs", () => {
    expect(selectGeneralOdFlows(flows, {
      focusCatchmentKey: "sanur",
      direction: "outbound",
      minimumPredictedShare: GENERAL_OD_MINIMUM_PREDICTED_SHARE,
      minimumConfidence: 0.85
    })).toEqual([flows[2], flows[3]]);
    expect(selectGeneralOdFlows(flows, {
      focusCatchmentKey: "sanur",
      direction: "inbound",
      minimumPredictedShare: GENERAL_OD_MINIMUM_PREDICTED_SHARE,
      minimumConfidence: 0.85
    })).toEqual([flows[1], flows[4]]);
  });
});
