import { describe, expect, it } from "vitest";
import { formatCongestedRoadShare } from "@/lib/map/traffic-summary";

describe("traffic overview formatting", () => {
  it("does not round a real small congested share down to zero", () => {
    expect(formatCongestedRoadShare(0)).toBe("0%");
    expect(formatCongestedRoadShare(0.0005)).toBe("<0.1%");
    expect(formatCongestedRoadShare(0.001184)).toBe("0.1%");
    expect(formatCongestedRoadShare(0.126)).toBe("13%");
  });
});
