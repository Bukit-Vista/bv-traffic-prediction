import { createDashboardFixture } from "@/lib/dashboard/demo";
import type { FeatureCollection, Geometry, Position } from "@/lib/dashboard/types";

export function useDemoSource() {
  const enabled = process.env.DASHBOARD_DEMO_MODE === "true";
  if (enabled && process.env.NODE_ENV === "production") {
    throw new Error("DASHBOARD_DEMO_MODE is forbidden in production");
  }
  return enabled;
}

function positions(geometry: Geometry): Position[] {
  if (geometry.type === "Point") return [geometry.coordinates];
  if (geometry.type === "LineString") return geometry.coordinates;
  if (geometry.type === "MultiLineString") return geometry.coordinates.flat();
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2);
  return geometry.coordinates.flat();
}

export function intersectsBbox(
  geometry: Geometry,
  [west, south, east, north]: [number, number, number, number]
) {
  return positions(geometry).some(
    ([lng, lat]) => lng >= west && lng <= east && lat >= south && lat <= north
  );
}

export function filterCollection<P extends Record<string, unknown>>(
  collection: FeatureCollection<P>,
  bbox: [number, number, number, number],
  limit: number,
  predicate: (properties: P) => boolean = () => true
) {
  return {
    type: "FeatureCollection" as const,
    features: collection.features
      .filter((feature) => intersectsBbox(feature.geometry, bbox) && predicate(feature.properties))
      .slice(0, limit)
  };
}

export function fixtureForSlot(at: string) {
  const date = at === "latest" ? new Date() : new Date(at);
  return createDashboardFixture(date);
}
