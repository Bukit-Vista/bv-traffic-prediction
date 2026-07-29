import { describe, expect, it } from "vitest";
import { normalizeHeatmapRange } from "@/lib/data/heatmap-range";

describe("heatmap range", () => {
  it("defaults to the current WITA day", () => {
    expect(
      normalizeHeatmapRange({ now: new Date("2026-07-12T16:30:00.000Z") })
    ).toMatchObject({
      startDate: "2026-07-13",
      endDate: "2026-07-13",
      days: 1
    });
  });

  it("allows a 7-day inclusive range", () => {
    expect(
      normalizeHeatmapRange({
        startDate: "2026-07-01",
        endDate: "2026-07-07"
      }).days
    ).toBe(7);
  });

  it("rejects ranges longer than 7 days", () => {
    expect(() =>
      normalizeHeatmapRange({
        startDate: "2026-07-01",
        endDate: "2026-07-08"
      })
    ).toThrow("range cannot exceed 7 days");
  });
});
