import { createHash } from "node:crypto";
import { withRedisJsonCache } from "@/lib/cache/redis-json";
import { toIsoUtc } from "@/lib/db/mappers";
import { queryRows, type QueryRows } from "@/lib/db/mysql";
import type {
  CenterProperties,
  FeatureCollection,
  MobilityFlowProperties,
  MobilityZoneProperties
} from "@/lib/dashboard/types";

export const CATCHMENT_PREVIEW_FLAG_KEY = "mobility_catchment_shadow_ui_enabled";
export const CATCHMENT_PUBLIC_FLAG_KEY = "mobility_catchment_v2_public_enabled";
export const CATCHMENT_MODEL_VERSION = "gravity-here-v2";
export const CATCHMENT_DISCLAIMER =
  "Relative predicted mobility indices only; never people, visitors, vehicles, or actual trip counts.";
export const CATCHMENT_SEMANTICS = "predicted_relative_mobility" as const;

type PreviewEnv = {
  [key: string]: string | undefined;
  MOBILITY_CATCHMENT_SHADOW_UI_ENABLED?: string;
  MOBILITY_CATCHMENT_SHADOW_UI_FLAG_ACTOR?: string;
  MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED?: string;
  MOBILITY_CATCHMENT_V2_PUBLIC_FLAG_ACTOR?: string;
};

let lastLoggedFlagValue: boolean | null = null;
let lastLoggedPublicFlagValue: boolean | null = null;

export function catchmentPreviewFlagEnabled(env: PreviewEnv = process.env, logChange = true) {
  const enabled = env.MOBILITY_CATCHMENT_SHADOW_UI_ENABLED === "true";
  if (logChange && enabled !== lastLoggedFlagValue) {
    const actor = env.MOBILITY_CATCHMENT_SHADOW_UI_FLAG_ACTOR?.trim() || "deployment-environment";
    console.info(JSON.stringify({
      event: "feature_flag_evaluated_value_changed",
      featureFlagKey: CATCHMENT_PREVIEW_FLAG_KEY,
      enabled,
      actor,
      timestamp: new Date().toISOString()
    }));
    lastLoggedFlagValue = enabled;
  }
  return enabled;
}

export function catchmentPublicFlagEnabled(env: PreviewEnv = process.env, logChange = true) {
  const enabled = env.MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED === "true";
  if (logChange && enabled !== lastLoggedPublicFlagValue) {
    const actor = env.MOBILITY_CATCHMENT_V2_PUBLIC_FLAG_ACTOR?.trim() || "deployment-environment";
    console.info(JSON.stringify({
      event: "feature_flag_evaluated_value_changed",
      featureFlagKey: CATCHMENT_PUBLIC_FLAG_KEY,
      enabled,
      actor,
      timestamp: new Date().toISOString()
    }));
    lastLoggedPublicFlagValue = enabled;
  }
  return enabled;
}

export type CatchmentServingMode = "internal" | "public";

type LatestRunRow = {
  model_run_id: number;
  flow_run_id: number;
  model_version: string;
  prediction_for_utc: string;
  completed_at_utc: string | null;
  status: string;
  model_active: number | boolean;
  zone_count: number;
  od_count: number;
  input_coverage: number | null;
  freshness_seconds: number;
  semantics: string;
  disclaimer: string;
  feature_flag_key: string;
  internal_preview_enabled: number | boolean;
  public_serving_enabled: number | boolean;
  error_json: unknown | null;
};

export type CatchmentPreviewMeta = {
  modelRunId: number;
  flowRunId: number;
  sourceRunId: number;
  modelVersion: string;
  predictionForUtc: string;
  slotUtc: string;
  completedAtUtc: string | null;
  status: "success";
  zoneCount: 21;
  odCount: 420;
  inputCoverage: number;
  coverage: number | null;
  freshnessSeconds: number;
  stale: boolean;
  semantics: typeof CATCHMENT_SEMANTICS;
  disclaimer: string;
  featureFlagKey: typeof CATCHMENT_PREVIEW_FLAG_KEY | typeof CATCHMENT_PUBLIC_FLAG_KEY;
  internalPreview: boolean;
  publicServing: boolean;
  servingMode: CatchmentServingMode;
};

export class CatchmentPreviewUnavailableError extends Error {
  constructor(readonly reason: "unavailable" | "misconfigured", message: string) {
    super(message);
    this.name = "CatchmentPreviewUnavailableError";
  }
}

const LATEST_RUN_SQL = `SELECT
  latest.model_run_id,
  latest.flow_run_id,
  latest.model_version,
  latest.prediction_for_utc,
  latest.completed_at_utc,
  latest.status,
  versions.active AS model_active,
  latest.zone_count,
  latest.od_count,
  latest.input_coverage,
  latest.freshness_seconds,
  latest.semantics,
  latest.disclaimer,
  latest.feature_flag_key,
  latest.internal_preview_enabled,
  latest.public_serving_enabled,
  runs.error_json
FROM api_internal_mobility_catchment_latest_run_v1 latest
JOIN mobility_model_runs runs
  ON runs.id = latest.model_run_id
JOIN mobility_model_versions versions
  ON versions.id = runs.model_version_id
  AND versions.version = latest.model_version`;

function flag(value: number | boolean) {
  return value === true || Number(value) === 1;
}

function validateLatestRun(row: LatestRunRow, servingMode: CatchmentServingMode) {
  const modelRunId = Number(row.model_run_id);
  const flowRunId = Number(row.flow_run_id);
  const inputCoverage = Number(row.input_coverage);
  const freshnessSeconds = Number(row.freshness_seconds);
  const accessValid = servingMode === "public"
    ? flag(row.public_serving_enabled) &&
      flag(row.model_active) &&
      row.error_json == null &&
      inputCoverage >= 0.90
    : flag(row.internal_preview_enabled);
  const valid = row.model_version === CATCHMENT_MODEL_VERSION &&
    row.status === "success" &&
    accessValid &&
    row.feature_flag_key === CATCHMENT_PREVIEW_FLAG_KEY &&
    row.semantics === CATCHMENT_SEMANTICS &&
    Number(row.zone_count) === 21 &&
    Number(row.od_count) === 420 &&
    Number.isInteger(modelRunId) && modelRunId > 0 &&
    Number.isInteger(flowRunId) && flowRunId > 0 &&
    row.input_coverage != null &&
    Number.isFinite(inputCoverage) && inputCoverage >= 0 && inputCoverage <= 1 &&
    Number.isFinite(freshnessSeconds) && freshnessSeconds >= 0;
  if (!valid) {
    throw new CatchmentPreviewUnavailableError(
      "misconfigured",
      servingMode === "public"
        ? "The gravity-here-v2 public serving contract is not ready."
        : "The internal catchment preview serving contract is not enabled."
    );
  }
}

function mapMeta(row: LatestRunRow, servingMode: CatchmentServingMode): CatchmentPreviewMeta {
  const predictionForUtc = toIsoUtc(row.prediction_for_utc) as string;
  const freshnessSeconds = Math.max(0, Number(row.freshness_seconds));
  const inputCoverage = Number(row.input_coverage);
  return {
    modelRunId: Number(row.model_run_id),
    flowRunId: Number(row.flow_run_id),
    sourceRunId: Number(row.flow_run_id),
    modelVersion: row.model_version,
    predictionForUtc,
    slotUtc: predictionForUtc,
    completedAtUtc: toIsoUtc(row.completed_at_utc),
    status: "success",
    zoneCount: 21,
    odCount: 420,
    inputCoverage,
    coverage: inputCoverage,
    freshnessSeconds,
    stale: freshnessSeconds > 3600,
    semantics: CATCHMENT_SEMANTICS,
    disclaimer: row.disclaimer || CATCHMENT_DISCLAIMER,
    featureFlagKey: servingMode === "public" ? CATCHMENT_PUBLIC_FLAG_KEY : CATCHMENT_PREVIEW_FLAG_KEY,
    internalPreview: flag(row.internal_preview_enabled),
    publicServing: flag(row.public_serving_enabled),
    servingMode
  };
}

export async function readCatchmentLatestRun(
  query: QueryRows = queryRows,
  now = Date.now(),
  servingMode: CatchmentServingMode = "internal"
) {
  const load = async () => {
    const rows = await query<LatestRunRow>(LATEST_RUN_SQL);
    if (!rows[0]) {
      throw new CatchmentPreviewUnavailableError(
        "unavailable",
        "No complete successful internal catchment preview run is available."
      );
    }
    validateLatestRun(rows[0], servingMode);
    return { row: rows[0], meta: mapMeta(rows[0], servingMode) };
  };
  if (query !== queryRows) return load();
  return withRedisJsonCache(
    { resource: `catchment-${servingMode}-latest-run`, identity: "latest", ttlSeconds: 30 },
    load
  );
}

type ZoneRow = {
  model_run_id: number;
  prediction_for_utc: string;
  display_order: number;
  zone_id: number;
  catchment_key: string;
  name: string;
  model_eligible: number | boolean;
  display_only: number | boolean;
  matrix_status: string | null;
  matrix_coverage_scope: string | null;
  matrix_excluded_area_label: string | null;
  has_prediction: number | boolean;
  presence_score: number | null;
  inbound_score: number | null;
  outbound_score: number | null;
  hotspot_rank: number | null;
  confidence: number | null;
  longitude: number;
  latitude: number;
  geometry_geojson: string | object;
};

const ZONES_SQL = `SELECT
  model_run_id,
  prediction_for_utc,
  display_order,
  zone_id,
  catchment_key,
  name,
  model_eligible,
  display_only,
  matrix_status,
  matrix_coverage_scope,
  matrix_excluded_area_label,
  has_prediction,
  presence_score,
  inbound_score,
  outbound_score,
  hotspot_rank,
  confidence,
  longitude,
  latitude,
  geometry_geojson
FROM api_internal_mobility_catchments_v1`;

export type CatchmentZoneProperties = MobilityZoneProperties & {
  catchmentKey: string;
  displayOrder: number;
  modelEligible: boolean;
  displayOnly: boolean;
  hasPrediction: boolean;
  matrixStatus: string | null;
  matrixCoverageScope: string | null;
  matrixExcludedAreaLabel: string | null;
  longitude: number;
  latitude: number;
};

export type CatchmentZonesResult = {
  collection: FeatureCollection<CatchmentZoneProperties>;
  meta: CatchmentPreviewMeta;
};

function geometry(value: string | object) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function loadCatchmentZones(
  latest: Awaited<ReturnType<typeof readCatchmentLatestRun>>,
  query: QueryRows
): Promise<CatchmentZonesResult> {
  const rows = (await query<ZoneRow>(ZONES_SQL))
    .sort((left, right) => Number(left.display_order) - Number(right.display_order));
  if (rows.length !== 22 || new Set(rows.map((row) => row.catchment_key)).size !== 22) {
    throw new CatchmentPreviewUnavailableError("misconfigured", "The catchment preview did not return the approved 22 unique display polygons.");
  }
  const predicted = rows.filter((row) => flag(row.has_prediction));
  const displayOnly = rows.filter((row) => flag(row.display_only));
  const displayOnlyRow = displayOnly[0];
  if (predicted.length !== 21 || displayOnly.length !== 1 ||
      displayOnlyRow?.catchment_key !== "nusa-penida-display" ||
      flag(displayOnlyRow?.model_eligible ?? false) ||
      flag(displayOnlyRow?.has_prediction ?? false) ||
      displayOnlyRow?.presence_score != null ||
      displayOnlyRow?.inbound_score != null ||
      displayOnlyRow?.outbound_score != null ||
      displayOnlyRow?.hotspot_rank != null ||
      displayOnlyRow?.confidence != null ||
      predicted.some((row) => !flag(row.model_eligible) || flag(row.display_only)) ||
      rows.some((row) =>
        Number(row.model_run_id) !== latest.meta.modelRunId ||
        toIsoUtc(row.prediction_for_utc) !== latest.meta.predictionForUtc
      )) {
    throw new CatchmentPreviewUnavailableError("misconfigured", "The catchment preview prediction/display-only split is invalid.");
  }
  if (predicted.some((row) => {
    const scores = [row.presence_score, row.inbound_score, row.outbound_score];
    const confidence = Number(row.confidence);
    return scores.some((score) => score == null || !Number.isFinite(Number(score)) || Number(score) < 0 || Number(score) > 100) ||
      !Number.isFinite(confidence) || confidence < 0 || confidence > 1;
  })) {
    throw new CatchmentPreviewUnavailableError("misconfigured", "A modeled catchment has an invalid score or confidence.");
  }
  const collection: FeatureCollection<CatchmentZoneProperties> = {
    type: "FeatureCollection",
    features: rows.map((row) => {
      const hasPrediction = flag(row.has_prediction);
      return {
        type: "Feature",
        id: Number(row.zone_id),
        geometry: geometry(row.geometry_geojson) as never,
        properties: {
          zoneId: Number(row.zone_id),
          zoneKey: row.catchment_key,
          catchmentKey: row.catchment_key,
          name: row.name,
          regencyName: null,
          displayOrder: Number(row.display_order),
          modelEligible: flag(row.model_eligible),
          displayOnly: flag(row.display_only),
          hasPrediction,
          matrixStatus: row.matrix_status,
          matrixCoverageScope: row.matrix_coverage_scope,
          matrixExcludedAreaLabel: row.matrix_excluded_area_label,
          longitude: Number(row.longitude),
          latitude: Number(row.latitude),
          timeBucketUtc: latest.meta.slotUtc,
          timeBucketLocal: latest.meta.slotUtc,
          presenceScore: hasPrediction && row.presence_score != null ? Number(row.presence_score) : null,
          inboundScore: hasPrediction && row.inbound_score != null ? Number(row.inbound_score) : null,
          outboundScore: hasPrediction && row.outbound_score != null ? Number(row.outbound_score) : null,
          attractionScore: undefined as never,
          hotspotRank: hasPrediction && row.hotspot_rank != null ? Number(row.hotspot_rank) : null,
          confidence: hasPrediction && row.confidence != null ? Number(row.confidence) : null,
          meanJamFactor: null,
          meanSpeedKph: null,
          modelVersion: latest.meta.modelVersion,
          runStatus: "success",
          isStale: latest.meta.stale
        } as CatchmentZoneProperties
      };
    })
  };
  return { collection, meta: latest.meta };
}

export async function readCatchmentZones(
  query: QueryRows = queryRows,
  servingMode: CatchmentServingMode = "internal"
) {
  const latest = await readCatchmentLatestRun(query, Date.now(), servingMode);
  if (query !== queryRows) return loadCatchmentZones(latest, query);
  return withRedisJsonCache(
    { resource: `catchment-${servingMode}-zones`, identity: latest.meta.modelRunId, freshness: "historical" },
    () => loadCatchmentZones(latest, query)
  );
}

type FlowRow = {
  model_run_id: number;
  prediction_for_utc: string;
  origin_display_order: number;
  destination_display_order: number;
  origin_zone_id: number;
  origin_catchment_key: string;
  origin_name: string;
  origin_longitude: number;
  origin_latitude: number;
  destination_zone_id: number;
  destination_catchment_key: string;
  destination_name: string;
  destination_longitude: number;
  destination_latitude: number;
  mobility_score: number;
  predicted_share: number;
  duration_seconds: number | null;
  distance_meters: number | null;
  confidence: number;
  semantics: string;
  disclaimer: string;
  feature_flag_key: string;
  internal_preview_enabled: number | boolean;
  public_serving_enabled: number | boolean;
};

const FLOWS_SQL = `SELECT
  model_run_id,
  prediction_for_utc,
  origin_display_order,
  destination_display_order,
  origin_zone_id,
  origin_catchment_key,
  origin_name,
  origin_longitude,
  origin_latitude,
  destination_zone_id,
  destination_catchment_key,
  destination_name,
  destination_longitude,
  destination_latitude,
  mobility_score,
  predicted_share,
  duration_seconds,
  distance_meters,
  confidence,
  semantics,
  disclaimer,
  feature_flag_key,
  internal_preview_enabled,
  public_serving_enabled
FROM api_internal_mobility_catchment_flows_v1
WHERE (? IS NULL OR origin_catchment_key = ?)
  AND (? IS NULL OR destination_catchment_key = ?)
  AND mobility_score >= ?
ORDER BY mobility_score DESC, origin_display_order, destination_display_order
LIMIT ?`;

export type CatchmentFlow = MobilityFlowProperties & {
  originDisplayOrder: number;
  destinationDisplayOrder: number;
  originCatchmentKey: string;
  destinationCatchmentKey: string;
  originLongitude: number;
  originLatitude: number;
  destinationLongitude: number;
  destinationLatitude: number;
};

export type CatchmentFlowsResult = {
  flows: CatchmentFlow[];
  collection: FeatureCollection<CatchmentFlow>;
  meta: CatchmentPreviewMeta;
  originCatchmentKey: string | null;
  destinationCatchmentKey: string | null;
  minScore: number;
  totalAvailablePairCount: number;
  returnedPairCount: number;
};

export function validateCatchmentFlowFilters(input: {
  origin?: string | null;
  destination?: string | null;
  minScore?: number;
  limit?: number;
}) {
  const origin = input.origin?.trim() || null;
  const destination = input.destination?.trim() || null;
  const minScore = input.minScore ?? 0;
  const limit = input.limit ?? (origin || destination ? 20 : 420);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) {
    throw new RangeError("minScore must be finite and between 0 and 100.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 420) {
    throw new RangeError("limit must be an integer between 1 and 420.");
  }
  return { origin, destination, minScore, limit };
}

async function loadCatchmentFlows(
  filters: ReturnType<typeof validateCatchmentFlowFilters>,
  latest: Awaited<ReturnType<typeof readCatchmentLatestRun>>,
  query: QueryRows
): Promise<CatchmentFlowsResult> {
  const zones = await readCatchmentZones(query, latest.meta.servingMode);
  const modeledKeys = new Set(
    zones.collection.features
      .filter((feature) => feature.properties.modelEligible && feature.properties.hasPrediction)
      .map((feature) => feature.properties.catchmentKey)
  );
  if (filters.origin && !modeledKeys.has(filters.origin)) {
    throw new RangeError("origin must be one of the modeled catchment keys.");
  }
  if (filters.destination && !modeledKeys.has(filters.destination)) {
    throw new RangeError("destination must be one of the modeled catchment keys.");
  }
  const rows = await query<FlowRow>(FLOWS_SQL, [
    filters.origin,
    filters.origin,
    filters.destination,
    filters.destination,
    filters.minScore,
    // mysql2 encodes JavaScript numbers as DOUBLE for prepared statements.
    // This server requires an integer-compatible string for a bound LIMIT.
    String(filters.limit)
  ]);
  const flows = rows.map((row): CatchmentFlow => ({
    originDisplayOrder: Number(row.origin_display_order),
    destinationDisplayOrder: Number(row.destination_display_order),
    originZoneId: Number(row.origin_zone_id),
    originZoneKey: row.origin_catchment_key,
    originCatchmentKey: row.origin_catchment_key,
    destinationZoneId: Number(row.destination_zone_id),
    destinationZoneKey: row.destination_catchment_key,
    destinationCatchmentKey: row.destination_catchment_key,
    originName: row.origin_name,
    destinationName: row.destination_name,
    originLongitude: Number(row.origin_longitude),
    originLatitude: Number(row.origin_latitude),
    destinationLongitude: Number(row.destination_longitude),
    destinationLatitude: Number(row.destination_latitude),
    mobilityScore: Number(row.mobility_score),
    predictedShare: Number(row.predicted_share),
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    travelTimeSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    distanceMeters: row.distance_meters == null ? null : Number(row.distance_meters),
    confidence: Number(row.confidence),
    modelVersion: latest.meta.modelVersion,
    predictionForUtc: toIsoUtc(row.prediction_for_utc) as string,
    semantics: CATCHMENT_SEMANTICS,
    disclaimer: row.disclaimer || latest.meta.disclaimer,
    pathSemantics: "zone_centroid_fallback",
    metricSemantics: "relative_prediction_not_people_count"
  }));
  if (flows.some((flow) =>
    flow.originZoneId === flow.destinationZoneId ||
    flow.originCatchmentKey === flow.destinationCatchmentKey ||
    !modeledKeys.has(flow.originCatchmentKey) ||
    !modeledKeys.has(flow.destinationCatchmentKey) ||
    !Number.isFinite(flow.originLongitude) || flow.originLongitude < -180 || flow.originLongitude > 180 ||
    !Number.isFinite(flow.originLatitude) || flow.originLatitude < -90 || flow.originLatitude > 90 ||
    !Number.isFinite(flow.destinationLongitude) || flow.destinationLongitude < -180 || flow.destinationLongitude > 180 ||
    !Number.isFinite(flow.destinationLatitude) || flow.destinationLatitude < -90 || flow.destinationLatitude > 90 ||
    !Number.isFinite(flow.mobilityScore) || flow.mobilityScore < 0 || flow.mobilityScore > 100 ||
    !Number.isFinite(flow.predictedShare) || flow.predictedShare < 0 || flow.predictedShare > 1 ||
    (flow.durationSeconds != null && (!Number.isFinite(flow.durationSeconds) || flow.durationSeconds < 0)) ||
    (flow.distanceMeters != null && (!Number.isFinite(flow.distanceMeters) || flow.distanceMeters < 0)) ||
    !Number.isFinite(flow.confidence) || flow.confidence < 0 || flow.confidence > 1 ||
    flow.predictionForUtc !== latest.meta.predictionForUtc
  )) {
    throw new CatchmentPreviewUnavailableError("misconfigured", "The catchment flow view returned an ineligible or diagonal pair.");
  }
  if (rows.some((row) => Number(row.model_run_id) !== latest.meta.modelRunId)) {
    throw new CatchmentPreviewUnavailableError("misconfigured", "The catchment flow view returned rows from a different model run.");
  }
  if (rows.some((row) =>
    row.semantics !== CATCHMENT_SEMANTICS ||
    row.feature_flag_key !== CATCHMENT_PREVIEW_FLAG_KEY ||
    flag(row.internal_preview_enabled) !== latest.meta.internalPreview ||
    flag(row.public_serving_enabled) !== latest.meta.publicServing
  )) {
    throw new CatchmentPreviewUnavailableError("misconfigured", "The catchment flow rows do not match the latest serving state.");
  }
  if (new Set(flows.map((flow) => `${flow.originCatchmentKey}|${flow.destinationCatchmentKey}`)).size !== flows.length) {
    throw new CatchmentPreviewUnavailableError("misconfigured", "The catchment flow view returned a duplicate directed pair.");
  }
  if (filters.origin && filters.minScore === 0 && filters.limit >= 20) {
    const shareTotal = flows.reduce((sum, flow) => sum + flow.predictedShare, 0);
    if (flows.length !== 20 ||
        flows.some((flow) => flow.originCatchmentKey !== filters.origin) ||
        new Set(flows.map((flow) => flow.destinationCatchmentKey)).size !== 20 ||
        Math.abs(shareTotal - 1) > 0.00001) {
      throw new CatchmentPreviewUnavailableError("misconfigured", "The selected origin does not have 20 reconciled destination shares.");
    }
  }
  if (filters.destination && filters.minScore === 0 && filters.limit >= 20) {
    if (flows.length !== 20 ||
        flows.some((flow) => flow.destinationCatchmentKey !== filters.destination) ||
        new Set(flows.map((flow) => flow.originCatchmentKey)).size !== 20) {
      throw new CatchmentPreviewUnavailableError("misconfigured", "The selected destination does not have 20 unique directed origins.");
    }
  }
  if (!filters.origin && !filters.destination && filters.minScore === 0 && filters.limit === latest.meta.odCount) {
    const pairs = new Set(flows.map((flow) => `${flow.originCatchmentKey}|${flow.destinationCatchmentKey}`));
    const origins = new Set(flows.map((flow) => flow.originCatchmentKey));
    const destinations = new Set(flows.map((flow) => flow.destinationCatchmentKey));
    if (flows.length !== latest.meta.odCount ||
        pairs.size !== latest.meta.odCount ||
        origins.size !== latest.meta.zoneCount ||
        destinations.size !== latest.meta.zoneCount) {
      throw new CatchmentPreviewUnavailableError("misconfigured", "The complete catchment flow matrix is not 21 × 20 directed pairs.");
    }
    for (const origin of origins) {
      const originFlows = flows.filter((flow) => flow.originCatchmentKey === origin);
      const shareTotal = originFlows.reduce((sum, flow) => sum + flow.predictedShare, 0);
      if (originFlows.length !== 20 || Math.abs(shareTotal - 1) > 0.00001) {
        throw new CatchmentPreviewUnavailableError("misconfigured", "A complete-matrix origin does not have 20 reconciled destination shares.");
      }
    }
    for (const destination of destinations) {
      const destinationFlows = flows.filter((flow) => flow.destinationCatchmentKey === destination);
      if (destinationFlows.length !== 20 ||
          new Set(destinationFlows.map((flow) => flow.originCatchmentKey)).size !== 20) {
        throw new CatchmentPreviewUnavailableError("misconfigured", "A complete-matrix destination does not have 20 unique directed origins.");
      }
    }
  }
  const collection: FeatureCollection<CatchmentFlow> = {
    type: "FeatureCollection",
    features: flows.map((flow) => ({
      type: "Feature",
      id: `catchment-od-${flow.originZoneId}-${flow.destinationZoneId}`,
      geometry: {
        type: "LineString",
        coordinates: [
          [flow.originLongitude, flow.originLatitude],
          [flow.destinationLongitude, flow.destinationLatitude]
        ]
      },
      properties: flow
    }))
  };
  return {
    flows,
    collection,
    meta: latest.meta,
    originCatchmentKey: filters.origin,
    destinationCatchmentKey: filters.destination,
    minScore: filters.minScore,
    totalAvailablePairCount: latest.meta.odCount,
    returnedPairCount: flows.length
  };
}

export async function readCatchmentFlows(
  input: { origin?: string | null; destination?: string | null; minScore?: number; limit?: number },
  query: QueryRows = queryRows,
  servingMode: CatchmentServingMode = "internal"
) {
  const filters = validateCatchmentFlowFilters(input);
  const latest = await readCatchmentLatestRun(query, Date.now(), servingMode);
  if (query !== queryRows) return loadCatchmentFlows(filters, latest, query);
  return withRedisJsonCache(
    {
      resource: `catchment-${servingMode}-flows`,
      identity: latest.meta.modelRunId,
      scope: filters,
      freshness: "historical"
    },
    () => loadCatchmentFlows(filters, latest, query)
  );
}

type CenterRow = {
  display_order: number;
  zone_id: number;
  catchment_key: string;
  name: string;
  model_category: string;
  center_count: number;
  base_attraction_weight: number;
  mean_longitude: number;
  mean_latitude: number;
};

const CENTERS_SQL = `SELECT
  display_order,
  zone_id,
  catchment_key,
  name,
  model_category,
  center_count,
  base_attraction_weight,
  mean_longitude,
  mean_latitude
FROM api_internal_mobility_catchment_center_summary_v1
WHERE (? IS NULL OR model_category = ?)
ORDER BY display_order, model_category`;

export type CatchmentCenterSummary = CenterProperties & {
  catchmentKey: string;
  displayOrder: number;
  modelCategory: string;
  baseAttractionWeight: number;
  meanLongitude: number;
  meanLatitude: number;
};

export type CatchmentCentersResult = {
  summaries: CatchmentCenterSummary[];
  collection: FeatureCollection<CatchmentCenterSummary>;
  category: string | null;
  meta: CatchmentPreviewMeta;
};

export function validateCenterCategory(category?: string | null) {
  const value = category?.trim() || null;
  if (value && (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value))) {
    throw new RangeError("category must be a short model category key.");
  }
  return value;
}

async function loadCatchmentCenters(
  category: string | null,
  latest: Awaited<ReturnType<typeof readCatchmentLatestRun>>,
  query: QueryRows
): Promise<CatchmentCentersResult> {
  const rows = await query<CenterRow>(CENTERS_SQL, [category, category]);
  if (!category && new Set(rows.map((row) => row.catchment_key)).size !== 21) {
    throw new CatchmentPreviewUnavailableError("misconfigured", "Center summaries do not cover all 21 modeled catchments.");
  }
  const summaries = rows.map((row, index): CatchmentCenterSummary => ({
    centerId: Number(`${row.zone_id}${String(index).padStart(3, "0")}`),
    zoneId: Number(row.zone_id),
    zoneKey: row.catchment_key,
    catchmentKey: row.catchment_key,
    displayOrder: Number(row.display_order),
    modelCategory: row.model_category,
    name: row.name,
    category: row.model_category,
    attractionScore: Number(row.base_attraction_weight),
    baseAttractionWeight: Number(row.base_attraction_weight),
    centerCount: Number(row.center_count),
    meanLongitude: Number(row.mean_longitude),
    meanLatitude: Number(row.mean_latitude),
    source: "aggregated_activity_center_context"
  }));
  const collection: FeatureCollection<CatchmentCenterSummary> = {
    type: "FeatureCollection",
    features: summaries.map((summary) => ({
      type: "Feature",
      id: `catchment-center-${summary.zoneId}-${summary.category}`,
      geometry: { type: "Point", coordinates: [summary.meanLongitude, summary.meanLatitude] },
      properties: summary
    }))
  };
  return { summaries, collection, category, meta: latest.meta };
}

export async function readCatchmentCenters(
  categoryInput?: string | null,
  query: QueryRows = queryRows,
  servingMode: CatchmentServingMode = "internal"
) {
  const category = validateCenterCategory(categoryInput);
  const latest = await readCatchmentLatestRun(query, Date.now(), servingMode);
  if (query !== queryRows) return loadCatchmentCenters(category, latest, query);
  return withRedisJsonCache(
    {
      resource: `catchment-${servingMode}-centers`,
      identity: latest.meta.modelRunId,
      scope: { category },
      freshness: "historical"
    },
    () => loadCatchmentCenters(category, latest, query)
  );
}

export async function readCatchmentOverview(
  query: QueryRows = queryRows,
  servingMode: CatchmentServingMode = "internal"
) {
  const zones = await readCatchmentZones(query, servingMode);
  const displayed = zones.collection.features.length;
  const modeled = zones.collection.features.filter((feature) => feature.properties.hasPrediction).length;
  const displayOnlyKeys = zones.collection.features
    .filter((feature) => feature.properties.displayOnly)
    .map((feature) => feature.properties.catchmentKey);
  return {
    meta: zones.meta,
    data: {
      displayedCatchmentCount: displayed,
      modeledCatchmentCount: modeled,
      displayOnlyCatchmentCount: displayed - modeled,
      odPairCount: zones.meta.odCount,
      availableMetrics: ["presence", "inbound", "outbound"],
      displayOnlyCatchmentKeys: displayOnlyKeys
    }
  };
}

export function catchmentPreviewEtag(meta: CatchmentPreviewMeta, filters: Record<string, unknown> = {}) {
  const filterHash = createHash("sha256").update(JSON.stringify(filters)).digest("base64url").slice(0, 12);
  return `"catchment-${meta.modelRunId}-${filterHash}"`;
}

export function clearCatchmentPreviewCachesForTests() {
  lastLoggedFlagValue = null;
  lastLoggedPublicFlagValue = null;
}
