import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDashboardFixture } from "@/lib/dashboard/demo";
import type { Position } from "@/lib/dashboard/types";

type PolygonCoordinates = Position[][][];

function pointInRing([longitude, latitude]: Position, ring: Position[]) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[index]!;
    const [x2, y2] = ring[previous]!;
    if ((y1 > latitude) !== (y2 > latitude) && longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

function onBaliLand(point: Position, polygons: PolygonCoordinates) {
  return polygons.some((polygon) => pointInRing(point, polygon[0]!) && !polygon.slice(1).some((hole) => pointInRing(point, hole)));
}

describe("real demo geography", () => {
  it("uses real regency polygons and sourced OSM road/POI coordinates", async () => {
    const geography = path.join(process.cwd(), "public/geography");
    const boundary = JSON.parse(await readFile(path.join(geography, "bali-province.geojson"), "utf8"));
    const regencies = JSON.parse(await readFile(path.join(geography, "bali-regencies.geojson"), "utf8"));
    const roads = JSON.parse(await readFile(path.join(geography, "bali-osm-roads.geojson"), "utf8"));
    const centers = JSON.parse(await readFile(path.join(geography, "bali-osm-activity-centers.geojson"), "utf8"));
    const land = boundary.features[0].geometry.coordinates as PolygonCoordinates;

    expect(regencies.features).toHaveLength(9);
    expect(regencies.features.every((feature: { geometry: { type: string } }) => feature.geometry.type === "MultiPolygon")).toBe(true);
    for (const feature of regencies.features) {
      for (const polygon of feature.geometry.coordinates as PolygonCoordinates) {
        for (const ring of polygon) expect(ring[0]).toEqual(ring.at(-1));
      }
      expect(onBaliLand(feature.properties.center, land)).toBe(true);
    }

    expect(roads.features).toHaveLength(8);
    const roadPoints = roads.features.flatMap((feature: { properties: { source: string }; geometry: { type: string; coordinates: Position[][] } }) => {
      expect(feature.properties.source).toBe("OpenStreetMap");
      expect(feature.geometry.type).toBe("MultiLineString");
      return feature.geometry.coordinates.flat();
    });
    expect(roadPoints.filter((point: Position) => onBaliLand(point, land)).length / roadPoints.length).toBeGreaterThan(0.998);

    expect(centers.features).toHaveLength(6);
    expect(centers.features.every((feature: { properties: { osmId: number }; geometry: { coordinates: Position } }) => feature.properties.osmId > 0 && onBaliLand(feature.geometry.coordinates, land))).toBe(true);
  });

  it("derives incident markers from OSM road vertices and OD endpoints from real zone centers", () => {
    const fixture = createDashboardFixture(new Date("2026-07-16T04:00:00Z"));
    const roadVertices = new Set(fixture.flow.features.flatMap((feature) => feature.geometry.type === "MultiLineString" ? feature.geometry.coordinates.flat() : []).map((point) => point.join(",")));
    expect(fixture.incidents.features.every((feature) => feature.geometry.type === "Point" && roadVertices.has(feature.geometry.coordinates.join(",")))).toBe(true);

    const zoneCenters = new Set(fixture.zones.features.map((feature) => {
      const coordinates = (feature.properties as { center?: Position }).center;
      return coordinates?.join(",");
    }).filter(Boolean));
    for (const flow of fixture.mobilityFlows.features) {
      if (flow.geometry.type !== "LineString") throw new Error("OD geometry must be a LineString");
      expect(zoneCenters.has(flow.geometry.coordinates[0]!.join(","))).toBe(true);
      expect(zoneCenters.has(flow.geometry.coordinates.at(-1)!.join(","))).toBe(true);
    }
  });
});
