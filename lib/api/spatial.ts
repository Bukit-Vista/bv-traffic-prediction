import { BALI_QUERY_BBOX, type Bbox } from "@/lib/map/viewport";

export type { Bbox };
export const BALI_QUERY_BOUNDS: Bbox = BALI_QUERY_BBOX;
export const MAX_BALI_VIEWPORT_AREA = 4.5;

export function bboxToWkt([west, south, east, north]: Bbox) {
  return `POLYGON((${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south}))`;
}

export function isBaliViewport([west, south, east, north]: Bbox) {
  const [minWest, minSouth, maxEast, maxNorth] = BALI_QUERY_BOUNDS;
  return west >= minWest && south >= minSouth && east <= maxEast && north <= maxNorth &&
    (east - west) * (north - south) <= MAX_BALI_VIEWPORT_AREA;
}

export function validatedSqlLimit(value: number, maximum = 5000) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`SQL limit must be an integer from 1 to ${maximum}`);
  }
  return value;
}
