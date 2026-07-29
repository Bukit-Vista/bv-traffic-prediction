import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BaliBoundaryProperties, FeatureCollection, Position } from "@/lib/dashboard/types";

describe("Bali boundary snapshot", () => {
  it("is a closed WGS84 MultiPolygon with the province islands and provenance", async () => {
    const file = await readFile(path.join(process.cwd(), "public/geography/bali-province.geojson"), "utf8");
    const collection = JSON.parse(file) as FeatureCollection<BaliBoundaryProperties>;
    expect(collection.features).toHaveLength(1);
    const feature = collection.features[0]!;
    expect(feature.geometry.type).toBe("MultiPolygon");
    if (feature.geometry.type !== "MultiPolygon") return;
    expect(feature.geometry.coordinates.length).toBeGreaterThanOrEqual(3);
    expect(feature.properties.osmRelationId).toBe(1615621);
    expect(feature.properties.osmRelationUrl).toBe("https://www.openstreetmap.org/relation/1615621");
    expect(feature.properties.importedAt).toBeTruthy();
    expect(feature.properties.sourceUrl).toMatch(/^https:/);
    expect(feature.properties.bbox[0]).toBeLessThan(114.5);
    expect(feature.properties.bbox[1]).toBeLessThan(-8.8);
    expect(feature.properties.bbox[2]).toBeGreaterThan(115.65);
    expect(feature.properties.bbox[3]).toBeGreaterThan(-8.15);
    for (const polygon of feature.geometry.coordinates) {
      for (const ring of polygon) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring.at(-1));
        for (const [longitude, latitude] of ring as Position[]) {
          expect(longitude).toBeGreaterThanOrEqual(-180);
          expect(longitude).toBeLessThanOrEqual(180);
          expect(latitude).toBeGreaterThanOrEqual(-90);
          expect(latitude).toBeLessThanOrEqual(90);
        }
      }
    }
  });
});
