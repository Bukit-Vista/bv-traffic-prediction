import type { FeatureCollection, FlowProperties, Position } from "@/lib/dashboard/types";

export type TrafficHeatPointProperties = Record<string, unknown> & {
  segmentId: number;
  segmentKey: string;
  roadName: string;
  jamFactor: number;
  confidence: number | null;
  heatWeight: number;
  roadClosure: boolean;
  collectionSlotUtc: string | null;
};

export type TrafficHeatmapLod = "province" | "regional" | "street";

const EARTH_RADIUS_METERS = 6_371_008.8;
const HEARTBEAT_JAM_STOPS = [0, 2, 4, 6, 8, 10] as const;
const DETAIL_ZOOM_SCALES = [[7, 1], [11, 0.82], [15, 0.62], [19, 0.5]] as const;
export const CONGESTED_JAM_FACTOR = 6;
export const PULSE_MIN_JAM_FACTOR = CONGESTED_JAM_FACTOR;
export const TRAFFIC_HEARTBEAT_ENABLED = false;
export const TRAFFIC_HEARTBEAT_FPS = 12;
const HEATMAP_MIN_JAM_FACTOR = 0;
const TRAFFIC_HEATMAP_LOD_CONFIG: Record<TrafficHeatmapLod, { spacingMeters: number; maximumPoints: number }> = {
  province: { spacingMeters: 550, maximumPoints: 4_000 },
  regional: { spacingMeters: 350, maximumPoints: 8_000 },
  street: { spacingMeters: 225, maximumPoints: 15_000 }
};
const TRAFFIC_HEATMAP_CACHE_LIMIT = 6;
const trafficHeatmapCache = new Map<string, {
  source: FeatureCollection<FlowProperties>;
  heatmap: FeatureCollection<TrafficHeatPointProperties>;
}>();
export const TRAFFIC_JAM_LEGEND = [
  { value: "0–2", label: "Free", color: "#2d9b6f" },
  { value: "2–4", label: "Light", color: "#9fba4a" },
  { value: "4–6", label: "Moderate", color: "#e9aa40" },
  { value: "6–8", label: "Congested", color: "#ed693e" },
  { value: "8–10", label: "Severe", color: "#a72e36" },
  { value: "10", label: "Max jam", color: "#35131b" }
] as const;

export function trafficJamColorExpression() {
  return [
    "step", ["coalesce", ["get", "jamFactor"], 0],
    "#2d9b6f",
    2, "#9fba4a",
    4, "#e9aa40",
    CONGESTED_JAM_FACTOR, "#d95345",
    8, "#a72e36",
    10, "#35131b"
  ];
}

export function trafficHeartbeatPeriodMs(jamFactor: number) {
  const severity = Math.max(0, Math.min(10, jamFactor)) / 10;
  return 3_600 - severity * 2_000;
}

export function trafficHeartbeatBeat(elapsedMs: number, jamFactor: number, reducedMotion = false) {
  if (reducedMotion) return 0;
  const period = trafficHeartbeatPeriodMs(jamFactor);
  const phase = ((elapsedMs % period) + period) % period / period;
  const peakPhase = 0.38;
  const smoothstep = (value: number) => {
    const progress = Math.max(0, Math.min(1, value));
    return progress * progress * (3 - 2 * progress);
  };
  if (phase <= peakPhase) return smoothstep(phase / peakPhase);
  return 1 - smoothstep((phase - peakPhase) / (1 - peakPhase));
}

export function trafficHeartbeatMultiplier(elapsedMs: number, jamFactor: number, reducedMotion = false) {
  if (reducedMotion) return 1;
  const severity = Math.max(0, Math.min(10, jamFactor)) / 10;
  const amplitude = 0.02 + severity * 0.34;
  return 1 - amplitude * 0.08 + amplitude * trafficHeartbeatBeat(elapsedMs, jamFactor);
}

export function trafficHeartbeatRadius(elapsedMs: number, jamFactor: number) {
  const severity = Math.max(0, Math.min(10, jamFactor)) / 10;
  const baseRadius = 2.5 + severity * 3.5;
  const pulseExpansion = 0.6 + severity * 3.4;
  return baseRadius + pulseExpansion * trafficHeartbeatBeat(elapsedMs, jamFactor);
}

export function trafficHeartbeatRadiusExpression(elapsedMs: number) {
  return [
    "interpolate", ["linear"], ["zoom"],
    ...DETAIL_ZOOM_SCALES.flatMap(([zoom, scale]) => [
      zoom,
      [
        "interpolate", ["linear"], ["coalesce", ["get", "jamFactor"], 0],
        ...HEARTBEAT_JAM_STOPS.flatMap((jamFactor) => [jamFactor, trafficHeartbeatRadius(elapsedMs, jamFactor) * scale])
      ]
    ])
  ];
}

export function trafficJamPointRadiusExpression() {
  const radii = [1.5, 2, 3, 4, 5, 6] as const;
  return [
    "interpolate", ["linear"], ["zoom"],
    ...DETAIL_ZOOM_SCALES.flatMap(([zoom, scale]) => [
      zoom,
      [
        "interpolate", ["linear"], ["coalesce", ["get", "jamFactor"], 0],
        ...HEARTBEAT_JAM_STOPS.flatMap((jamFactor, index) => [jamFactor, radii[index]! * scale])
      ]
    ])
  ];
}

export function trafficHeartbeatOpacityExpression(elapsedMs: number) {
  return [
    "interpolate", ["linear"], ["coalesce", ["get", "jamFactor"], 0],
    ...HEARTBEAT_JAM_STOPS.flatMap((jamFactor) => {
      const severity = jamFactor / 10;
      const opacity = 0.015 + severity * 0.025 + (0.1 + severity * 0.5) * trafficHeartbeatBeat(elapsedMs, jamFactor);
      return [jamFactor, Math.min(0.68, opacity)];
    })
  ];
}

function radians(value: number) {
  return value * Math.PI / 180;
}

export function distanceMeters([lng1, lat1]: Position, [lng2, lat2]: Position) {
  const latitudeDelta = radians(lat2 - lat1);
  const longitudeDelta = radians(lng2 - lng1);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function sampleLineAtSpacing(coordinates: Position[], spacingMeters = 300) {
  if (coordinates.length === 0) return [];
  if (coordinates.length === 1) return [coordinates[0]!];
  const points: Position[] = [];
  let travelled = 0;
  let nextSample = spacingMeters / 2;

  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1]!;
    const end = coordinates[index]!;
    const length = distanceMeters(start, end);
    if (length <= 0) continue;
    while (nextSample <= travelled + length) {
      const ratio = (nextSample - travelled) / length;
      points.push([
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio
      ]);
      nextSample += spacingMeters;
    }
    travelled += length;
  }

  if (!points.length) {
    const middle = Math.floor(coordinates.length / 2);
    return [coordinates[middle]!];
  }
  return points;
}

function trafficLines(collection: FeatureCollection<FlowProperties>) {
  return collection.features.flatMap((feature) => {
    if (feature.geometry.type === "LineString") return [{ feature, coordinates: feature.geometry.coordinates }];
    if (feature.geometry.type === "MultiLineString") {
      return feature.geometry.coordinates.map((coordinates) => ({ feature, coordinates }));
    }
    return [];
  });
}

function lineLengthMeters(coordinates: Position[]) {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += distanceMeters(coordinates[index - 1]!, coordinates[index]!);
  }
  return length;
}

export function createTrafficHeatmapCollection(
  collection: FeatureCollection<FlowProperties>,
  options: { spacingMeters?: number; maximumPoints?: number } = {}
): FeatureCollection<TrafficHeatPointProperties> {
  const spacingMeters = options.spacingMeters ?? 300;
  const maximumPoints = options.maximumPoints ?? 25_000;
  const features: FeatureCollection<TrafficHeatPointProperties>["features"] = [];
  const candidates = trafficLines(collection).flatMap(({ feature, coordinates }) => {
    const properties = feature.properties;
    const measuredJam = properties.roadClosure ? 10 : properties.jamFactor;
    if (measuredJam == null || measuredJam < HEATMAP_MIN_JAM_FACTOR) return [];
    const jamFactor = Math.max(0, Math.min(10, measuredJam));
    const confidenceMultiplier = properties.confidence == null
      ? 0.5
      : 0.5 + Math.max(0, Math.min(1, properties.confidence)) * 0.5;
    const heatWeight = Math.pow(jamFactor / 10, 1.35) * confidenceMultiplier;
    return [{ feature, coordinates, jamFactor, heatWeight, lengthMeters: lineLengthMeters(coordinates) }];
  });

  let effectiveSpacing = spacingMeters;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const estimatedPoints = candidates.reduce(
      (sum, candidate) => sum + Math.max(1, Math.ceil(candidate.lengthMeters / effectiveSpacing)),
      0
    );
    if (estimatedPoints <= maximumPoints) break;
    effectiveSpacing *= estimatedPoints / maximumPoints * 1.05;
  }

  for (const { feature, coordinates, jamFactor, heatWeight } of candidates) {
    const properties = feature.properties;
    for (const [sampleIndex, point] of sampleLineAtSpacing(coordinates, effectiveSpacing).entries()) {
      features.push({
        type: "Feature",
        id: `${properties.segmentKey}-heat-${sampleIndex}`,
        geometry: { type: "Point", coordinates: point },
        properties: {
          segmentId: properties.segmentId,
          segmentKey: properties.segmentKey,
          roadName: properties.roadName,
          jamFactor,
          confidence: properties.confidence,
          heatWeight,
          roadClosure: properties.roadClosure,
          collectionSlotUtc: properties.collectionSlotUtc ?? null
        }
      });
    }
  }
  if (features.length <= maximumPoints) return { type: "FeatureCollection", features };
  const samplingStep = features.length / maximumPoints;
  return {
    type: "FeatureCollection",
    features: Array.from({ length: maximumPoints }, (_, index) => features[Math.floor(index * samplingStep)]!)
  };
}

export function trafficHeatmapLodForZoom(zoom: number): TrafficHeatmapLod {
  if (zoom < 11) return "province";
  if (zoom < 14) return "regional";
  return "street";
}

function trafficHeatmapCacheKey(flowIdentity: string, lod: TrafficHeatmapLod) {
  return `${flowIdentity}|${lod}`;
}

export function getCachedTrafficHeatmap(
  flowIdentity: string,
  lod: TrafficHeatmapLod,
  collection?: FeatureCollection<FlowProperties>
) {
  const key = trafficHeatmapCacheKey(flowIdentity, lod);
  const cached = trafficHeatmapCache.get(key);
  if (!cached) return null;
  if (collection && cached.source !== collection) {
    trafficHeatmapCache.delete(key);
    return null;
  }
  trafficHeatmapCache.delete(key);
  trafficHeatmapCache.set(key, cached);
  return cached.heatmap;
}

export function getOrCreateTrafficHeatmap(
  flowIdentity: string,
  collection: FeatureCollection<FlowProperties>,
  lod: TrafficHeatmapLod
) {
  const cached = getCachedTrafficHeatmap(flowIdentity, lod, collection);
  if (cached) return cached;
  const created = createTrafficHeatmapCollection(collection, TRAFFIC_HEATMAP_LOD_CONFIG[lod]);
  trafficHeatmapCache.set(trafficHeatmapCacheKey(flowIdentity, lod), { source: collection, heatmap: created });
  while (trafficHeatmapCache.size > TRAFFIC_HEATMAP_CACHE_LIMIT) {
    const oldestKey = trafficHeatmapCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    trafficHeatmapCache.delete(oldestKey);
  }
  return created;
}

export function clearTrafficHeatmapCache() {
  trafficHeatmapCache.clear();
}
