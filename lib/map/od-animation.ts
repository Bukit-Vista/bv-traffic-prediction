import type {
  FeatureCollection,
  MobilityFlowProperties,
  Position
} from "@/lib/dashboard/types";

export type OdParticleProperties = Record<string, unknown> & {
  flowId: string;
  particleIndex: number;
  mobilityScore: number;
  confidence: number;
  particleOpacity: number;
  arrowRotation: number;
  originName: string;
  destinationName: string;
  flowVisualMode: "general_od";
  routeWeightedJamFactor: number | null;
  directionalCongestionIndex: number | null;
  arrowTrainCount: number;
};

export type OdEndpointProperties = Record<string, unknown> & {
  flowId: string;
  endpointType: "origin" | "destination";
  mobilityScore: number;
  confidence: number;
  arrowRotation: number;
  originName: string;
  destinationName: string;
  flowVisualMode: "general_od";
  routeWeightedJamFactor: number | null;
  directionalCongestionIndex: number | null;
};

const EMPTY_PARTICLES: FeatureCollection<OdParticleProperties> = {
  type: "FeatureCollection",
  features: []
};

export const OD_ANIMATION_SPEED_MULTIPLIER = 0.5;
export const OD_ANIMATION_FPS = 24;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function segmentLength([fromLongitude, fromLatitude]: Position, [toLongitude, toLatitude]: Position) {
  const meanLatitudeRadians = ((fromLatitude + toLatitude) / 2) * Math.PI / 180;
  const longitudeDistance = (toLongitude - fromLongitude) * Math.cos(meanLatitudeRadians);
  const latitudeDistance = toLatitude - fromLatitude;
  return Math.hypot(longitudeDistance, latitudeDistance);
}

function arrowRotation(from: Position, to: Position) {
  return Math.atan2(-(to[1] - from[1]), to[0] - from[0]) * 180 / Math.PI;
}

export function interpolateLineString(coordinates: Position[], rawProgress: number): Position {
  if (coordinates.length === 0) return [0, 0];
  if (coordinates.length === 1) return coordinates[0]!;

  const progress = clamp(rawProgress, 0, 1);
  const lengths = coordinates.slice(1).map((coordinate, index) => segmentLength(coordinates[index]!, coordinate));
  const totalLength = lengths.reduce((total, length) => total + length, 0);
  if (totalLength === 0) return coordinates[0]!;

  let targetDistance = totalLength * progress;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (targetDistance <= length || index === lengths.length - 1) {
      const localProgress = length === 0 ? 0 : targetDistance / length;
      const [fromLongitude, fromLatitude] = coordinates[index]!;
      const [toLongitude, toLatitude] = coordinates[index + 1]!;
      return [
        fromLongitude + (toLongitude - fromLongitude) * localProgress,
        fromLatitude + (toLatitude - fromLatitude) * localProgress
      ];
    }
    targetDistance -= length;
  }

  return coordinates.at(-1)!;
}

export function odParticleCount(mobilityScore: number) {
  return clamp(Math.ceil(mobilityScore / 25), 1, 4);
}

export function odRouteCongestionIndex(
  flow: Pick<MobilityFlowProperties, "routeWeightedJamFactor">
) {
  const routeJam = flow.routeWeightedJamFactor == null
    ? null
    : Number(flow.routeWeightedJamFactor);
  if (routeJam != null && Number.isFinite(routeJam)) {
    return clamp(routeJam / 10, 0, 1);
  }
  return null;
}

export function congestionOdParticleCount(
  flow: Pick<MobilityFlowProperties, "routeWeightedJamFactor">
) {
  const congestionIndex = odRouteCongestionIndex(flow);
  if (congestionIndex == null) return 1;
  return clamp(1 + Math.floor(congestionIndex * 5), 1, 5);
}

function animationDurationMs(travelTimeSeconds: number | null) {
  const travelTime = travelTimeSeconds == null || !Number.isFinite(travelTimeSeconds)
    ? 3_000
    : travelTimeSeconds;
  return clamp(3_200 + travelTime * 0.9, 4_200, 8_200);
}

function edgeOpacity(progress: number) {
  return clamp(Math.min(progress / 0.08, (1 - progress) / 0.08), 0, 1);
}

export function createOdParticleCollection(
  flows: FeatureCollection<MobilityFlowProperties>,
  elapsedMs: number,
  options: {
    reducedMotion?: boolean;
    minimumScore?: number;
  } = {}
): FeatureCollection<OdParticleProperties> {
  if (flows.features.length === 0) return EMPTY_PARTICLES;
  const minimumScore = options.minimumScore ?? 0;

  return {
    type: "FeatureCollection",
    features: flows.features.flatMap((flow) => {
      if (flow.geometry.type !== "LineString" || flow.properties.mobilityScore < minimumScore) return [];
      const coordinates = flow.geometry.coordinates;
      const directionalCongestionIndex = odRouteCongestionIndex(flow.properties);
      const count = directionalCongestionIndex != null
        ? congestionOdParticleCount(flow.properties)
        : options.reducedMotion
          ? 1
          : odParticleCount(flow.properties.mobilityScore);
      const duration = animationDurationMs(flow.properties.travelTimeSeconds) /
        OD_ANIMATION_SPEED_MULTIPLIER;

      return Array.from({ length: count }, (_, particleIndex) => {
        // Keep arrows in a compact train (>>>>), rather than distributing
        // them evenly along the entire OD line. General OD uses score for
        // train length.
        // Every arrow still moves in the authoritative OD direction.
        const trainGap = 0.04;
        const movingProgress = ((elapsedMs / duration) - particleIndex * trainGap + 1) % 1;
        const progress = options.reducedMotion
          ? clamp(0.72 - particleIndex * trainGap, 0.05, 0.95)
          : movingProgress;
        const position = interpolateLineString(coordinates, progress);
        const comparisonProgress = progress > 0.995
          ? Math.max(0, progress - 0.005)
          : Math.min(1, progress + 0.005);
        const comparison = interpolateLineString(coordinates, comparisonProgress);
        const from = progress > 0.995 ? comparison : position;
        const to = progress > 0.995 ? position : comparison;
        return {
          type: "Feature" as const,
          id: `${String(flow.id)}-particle-${particleIndex}`,
          geometry: {
            type: "Point" as const,
            coordinates: position
          },
          properties: {
            flowId: String(flow.id),
            particleIndex,
            mobilityScore: flow.properties.mobilityScore,
            confidence: flow.properties.confidence,
            // Confidence remains encoded, but keep model markers legible on
            // the dark choropleth. Only the short endpoint fade may reduce
            // them below this base visibility.
            particleOpacity: (0.68 + flow.properties.confidence * 0.32) * edgeOpacity(progress),
            arrowRotation: arrowRotation(from, to),
            originName: flow.properties.originName,
            destinationName: flow.properties.destinationName,
            flowVisualMode: "general_od",
            routeWeightedJamFactor: flow.properties.routeWeightedJamFactor ?? null,
            directionalCongestionIndex,
            arrowTrainCount: count
          }
        };
      });
    })
  };
}

export function createOdEndpointCollection(
  flows: FeatureCollection<MobilityFlowProperties>,
  minimumScore = 0
): FeatureCollection<OdEndpointProperties> {
  return {
    type: "FeatureCollection",
    features: flows.features.flatMap((flow) => {
      if (flow.geometry.type !== "LineString" || flow.properties.mobilityScore < minimumScore) return [];
      const origin = flow.geometry.coordinates[0];
      const destination = flow.geometry.coordinates.at(-1);
      const beforeDestination = flow.geometry.coordinates.at(-2);
      if (!origin || !destination || !beforeDestination) return [];
      const directionalCongestionIndex = odRouteCongestionIndex(flow.properties);
      const common = {
        flowId: String(flow.id),
        mobilityScore: flow.properties.mobilityScore,
        confidence: flow.properties.confidence,
        arrowRotation: arrowRotation(beforeDestination, destination),
        originName: flow.properties.originName,
        destinationName: flow.properties.destinationName,
        flowVisualMode: "general_od" as const,
        routeWeightedJamFactor: flow.properties.routeWeightedJamFactor ?? null,
        directionalCongestionIndex
      };
      return [
        {
          type: "Feature" as const,
          id: `${String(flow.id)}-origin`,
          geometry: { type: "Point" as const, coordinates: origin },
          properties: { ...common, endpointType: "origin" as const }
        },
        {
          type: "Feature" as const,
          id: `${String(flow.id)}-destination`,
          geometry: { type: "Point" as const, coordinates: destination },
          properties: { ...common, endpointType: "destination" as const }
        }
      ];
    })
  };
}
