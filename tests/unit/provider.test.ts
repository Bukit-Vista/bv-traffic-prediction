import { describe, expect, it } from "vitest";
import { formatProviderName, formatRoutingAttribution } from "@/lib/provider";

describe("provider formatting", () => {
  it("formats known routing providers", () => {
    expect(formatProviderName("here")).toBe("HERE");
    expect(formatProviderName("tomtom")).toBe("TomTom");
  });

  it("builds attribution from distinct providers", () => {
    expect(formatRoutingAttribution(["here", "HERE"])).toBe(
      "Travel time and distance results are derived from HERE routing data."
    );
    expect(formatRoutingAttribution([])).toBe(
      "Travel time and distance results are derived from routing provider data."
    );
  });
});
