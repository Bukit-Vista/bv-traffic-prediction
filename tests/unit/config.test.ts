import { describe, expect, it } from "vitest";
import { getRetentionDays } from "@/lib/config";

describe("config", () => {
  it("uses a 90-day default retention window", () => {
    expect(getRetentionDays({})).toBe(90);
  });

  it("allows retention days to be configured", () => {
    expect(getRetentionDays({ RETENTION_DAYS: "180" })).toBe(180);
  });

  it("falls back to default for invalid retention values", () => {
    expect(getRetentionDays({ RETENTION_DAYS: "0" })).toBe(90);
    expect(getRetentionDays({ RETENTION_DAYS: "not-a-number" })).toBe(90);
  });
});
