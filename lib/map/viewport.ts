export type Bbox = [number, number, number, number];

export const DEFAULT_BALI_BBOX: Bbox = [114.34, -8.9, 115.78, -8.03];
export const BALI_QUERY_BBOX: Bbox = [113.9, -9.4, 116.3, -7.55];

export function clampBaliQueryBbox([west, south, east, north]: Bbox): Bbox {
  const [minimumWest, minimumSouth, maximumEast, maximumNorth] = BALI_QUERY_BBOX;
  const clamped: Bbox = [
    Math.max(minimumWest, Math.min(maximumEast, west)),
    Math.max(minimumSouth, Math.min(maximumNorth, south)),
    Math.max(minimumWest, Math.min(maximumEast, east)),
    Math.max(minimumSouth, Math.min(maximumNorth, north))
  ];
  return clamped[0] < clamped[2] && clamped[1] < clamped[3] ? clamped : BALI_QUERY_BBOX;
}

export function expandBbox([west, south, east, north]: Bbox, ratio = 0.1): Bbox {
  const longitudePadding = (east - west) * ratio / 2;
  const latitudePadding = (north - south) * ratio / 2;
  return [
    Math.max(113.9, west - longitudePadding),
    Math.max(-9.4, south - latitudePadding),
    Math.min(116.3, east + longitudePadding),
    Math.min(-7.55, north + latitudePadding)
  ];
}

export function parseBbox(value: string | null): Bbox | null {
  if (!value) return null;
  const coordinates = value.split(",").map(Number);
  if (coordinates.length !== 4 || coordinates.some((coordinate) => !Number.isFinite(coordinate))) return null;
  const [west, south, east, north] = coordinates;
  if (west! >= east! || south! >= north! || west! < -180 || east! > 180 || south! < -90 || north! > 90) return null;
  return coordinates as Bbox;
}

export function formatBbox(bbox: Bbox) {
  return bbox.map((coordinate) => coordinate.toFixed(5)).join(",");
}
