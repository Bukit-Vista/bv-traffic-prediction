import { describe, expect, it } from "vitest";
import { combineFlexiblePolylineSections, decodeFlexiblePolyline } from "@/lib/here/flexible-polyline";

describe("HERE flexible polyline", () => {
  it("decodes longitude/latitude in GeoJSON order", () => {
    const result = decodeFlexiblePolyline("BFoz5xJ67i1B1B7PzIhaxL7Y");
    expect(result.precision).toBe(5);
    expect(result.coordinates).toEqual([
      [8.69821, 50.10228],
      [8.69567, 50.10201],
      [8.6915, 50.10063],
      [8.68752, 50.09878]
    ]);
  });

  it("combines travel-ordered sections", () => {
    const encoded = "BFoz5xJ67i1B1B7PzIhaxL7Y";
    const geometry = combineFlexiblePolylineSections([encoded, encoded]);
    expect(geometry.type).toBe("LineString");
    expect(geometry.coordinates).toHaveLength(8);
  });
});
