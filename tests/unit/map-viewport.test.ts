import { describe, expect, it } from "vitest";
import { clampBaliQueryBbox, expandBbox, formatBbox, parseBbox } from "@/lib/map/viewport";

describe("map viewport", () => {
  it("clamps pitched camera bounds to the supported Bali query envelope", () => {
    expect(clampBaliQueryBbox([114.50726, -9.42252, 116.14669, -7.38554])).toEqual([
      114.50726, -9.4, 116.14669, -7.55
    ]);
  });

  it("expands each axis by ten percent total", () => {
    expect(expandBbox([114, -9, 116, -8], 0.1)).toEqual([113.9, -9.05, 116.1, -7.95]);
  });

  it("parses and formats valid URL bounds", () => {
    expect(parseBbox("114.40000,-8.90000,115.80000,-8.00000")).toEqual([114.4, -8.9, 115.8, -8]);
    expect(formatBbox([114.4, -8.9, 115.8, -8])).toBe("114.40000,-8.90000,115.80000,-8.00000");
  });

  it("rejects invalid or reversed bounds", () => {
    expect(parseBbox("bad")).toBeNull();
    expect(parseBbox("116,-8,114,-9")).toBeNull();
  });
});
