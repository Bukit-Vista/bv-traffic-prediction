import type {
  FeatureCollection,
  FlowProperties,
  Geometry,
  Position,
  RouteSummary,
  TrafficOverview
} from "@/lib/dashboard/types";
import type { Bbox } from "@/lib/map/viewport";

const geometryBoundsCache = new WeakMap<object, Bbox>();

function geometryPositions(geometry: Geometry): Position[] {
  if (geometry.type === "Point") return [geometry.coordinates];
  if (geometry.type === "LineString") return geometry.coordinates;
  if (geometry.type === "MultiLineString" || geometry.type === "Polygon") return geometry.coordinates.flat();
  return geometry.coordinates.flat(2);
}

function geometryBounds(geometry: Geometry): Bbox {
  const cached = geometryBoundsCache.get(geometry);
  if (cached) return cached;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [longitude, latitude] of geometryPositions(geometry)) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }
  const bounds: Bbox = [west, south, east, north];
  geometryBoundsCache.set(geometry, bounds);
  return bounds;
}

function boundsOverlap([leftWest, leftSouth, leftEast, leftNorth]: Bbox, [rightWest, rightSouth, rightEast, rightNorth]: Bbox) {
  return leftEast >= rightWest && leftWest <= rightEast && leftNorth >= rightSouth && leftSouth <= rightNorth;
}

function pointInside([longitude, latitude]: Position, [west, south, east, north]: Bbox) {
  return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
}

function segmentIntersectsBbox([x0, y0]: Position, [x1, y1]: Position, bbox: Bbox) {
  if (pointInside([x0, y0], bbox) || pointInside([x1, y1], bbox)) return true;
  const [west, south, east, north] = bbox;
  const dx = x1 - x0;
  const dy = y1 - y0;
  let minimum = 0;
  let maximum = 1;
  for (const [p, q] of [[-dx, x0 - west], [dx, east - x0], [-dy, y0 - south], [dy, north - y0]]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return true;
}

function lineIntersectsBbox(coordinates: Position[], bbox: Bbox) {
  if (coordinates.some((coordinate) => pointInside(coordinate, bbox))) return true;
  for (let index = 1; index < coordinates.length; index += 1) {
    if (segmentIntersectsBbox(coordinates[index - 1]!, coordinates[index]!, bbox)) return true;
  }
  return false;
}

export function flowGeometryIntersectsBbox(geometry: Geometry, bbox: Bbox) {
  if (!boundsOverlap(geometryBounds(geometry), bbox)) return false;
  if (geometry.type === "Point") return pointInside(geometry.coordinates, bbox);
  if (geometry.type === "LineString") return lineIntersectsBbox(geometry.coordinates, bbox);
  if (geometry.type === "MultiLineString") return geometry.coordinates.some((line) => lineIntersectsBbox(line, bbox));
  if (geometry.type === "Polygon") return geometry.coordinates.some((ring) => lineIntersectsBbox(ring, bbox));
  return geometry.coordinates.some((polygon) => polygon.some((ring) => lineIntersectsBbox(ring, bbox)));
}

export function calculateViewportTrafficOverview(input: {
  flow: FeatureCollection<FlowProperties>;
  routes: RouteSummary[];
  bbox: Bbox;
  minimumConfidence: number;
  coverage: number | null | undefined;
}): TrafficOverview {
  const visible = input.flow.features.filter((feature) =>
    (feature.properties.confidence ?? 0) >= input.minimumConfidence &&
    flowGeometryIntersectsBbox(feature.geometry, input.bbox)
  );
  return calculateTrafficOverviewForCollection({
    flow: { type: "FeatureCollection", features: visible },
    routes: input.routes,
    coverage: input.coverage
  });
}

export function calculateTrafficOverviewForCollection(input: {
  flow: FeatureCollection<FlowProperties>;
  routes: RouteSummary[];
  coverage: number | null | undefined;
}): TrafficOverview {
  const visible = input.flow.features;
  const usable = visible.filter((feature) =>
    feature.properties.lengthMeters != null && feature.properties.lengthMeters > 0 && feature.properties.jamFactor != null
  );
  const measuredLengthMeters = usable.reduce((sum, feature) => sum + (feature.properties.lengthMeters ?? 0), 0);
  const weightedJamFactor = measuredLengthMeters > 0
    ? usable.reduce((sum, feature) => sum + (feature.properties.jamFactor ?? 0) * (feature.properties.lengthMeters ?? 0), 0) / measuredLengthMeters
    : null;
  const congestedLengthMeters = usable
    .filter((feature) => (feature.properties.jamFactor ?? -1) >= 6)
    .reduce((sum, feature) => sum + (feature.properties.lengthMeters ?? 0), 0);
  const slowestRoute = [...input.routes]
    .filter((route) => route.ratioVsTypical != null)
    .sort((left, right) => (right.ratioVsTypical ?? 0) - (left.ratioVsTypical ?? 0))[0] ?? null;
  return {
    weightedJamFactor,
    congestedRoadShare: measuredLengthMeters > 0 ? congestedLengthMeters / measuredLengthMeters : null,
    measuredLengthMeters,
    closures: visible.filter((feature) => feature.properties.roadClosure).length,
    slowestRoute,
    coverage: input.coverage ?? 0
  };
}
