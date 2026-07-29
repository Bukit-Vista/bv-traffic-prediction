import { ApiUnavailableError } from "@/lib/api/core";
import { validatedSqlLimit } from "@/lib/api/spatial";
import { toMysqlDateTime, queryRows, type QueryRows } from "@/lib/db/mysql";
import { parseJson, toIsoUtc } from "@/lib/db/mappers";
import type { CollectionRun, CollectorState, RouteSummary } from "@/lib/dashboard/types";

export type MobilityProductScope = {
  scopeId: number;
  scopeKey: string;
  scopeVersion: string;
  name: string;
  description: string;
  origin: { key: string; label: string; type: string };
  predictionIntervalMinutes: number;
  storageTimezone: string;
  displayTimezone: string;
  outputUnit: string;
  candidateSetSemantics: string;
  disclaimer: string;
  freshnessPolicy: Record<string, unknown>;
  blockingPolicy: Record<string, unknown>;
  featureFlagKey: string;
  predictionEnabled: boolean;
  status: string;
  approvedBy: string | null;
  approvedAtUtc: string | null;
  updatedAtUtc: string;
};

export type AirportDestinationConfig = {
  scopeId: number;
  scopeKey: string;
  scopeVersion: string;
  scopeStatus: string;
  predictionEnabled: boolean;
  destinationKey: string;
  destinationLabel: string;
  routeGroupKey: string;
  displayOrder: number;
  active: boolean;
};

export type AirportRouteDefinition = {
  scopeKey: string;
  scopeVersion: string;
  scopeStatus: string;
  predictionEnabled: boolean;
  displayOrder: number;
  routeId: number;
  slug: string;
  routePurpose: string;
  routeGroupKey: string;
  tourismCenterKey: string;
  routeDirection: "from_airport" | "to_airport" | "other";
  origin: { label: string; latitude: number; longitude: number };
  destination: { label: string; latitude: number; longitude: number };
  category: string;
  active: boolean;
};

export type AirportRouteSlot = {
  collectionSlotUtc: string;
  observedRouteCount: number;
  successfulRouteCount: number;
  unsuccessfulRouteCount: number;
  firstSampledAtUtc: string | null;
  lastSampledAtUtc: string | null;
  minimumRatioVsTypical: number | null;
  maximumRatioVsTypical: number | null;
  averageRatioVsTypical: number | null;
};

export type SourceStatus = {
  dataset: string;
  runId: string;
  runToken: string;
  collectionSlotUtc: string;
  status: "running" | "success" | "partial" | "failed";
  expectedCount: number;
  successfulCount: number;
  failedCount: number;
  recordCount: number;
  coverage: number | null;
  startedAtUtc: string;
  finishedAtUtc: string | null;
  slotAgeMinutes: number | null;
  errorPresent: boolean;
};

type ScopeRow = {
  scope_id: number; scope_key: string; scope_version: string; name: string; description: string;
  origin_key: string; origin_label: string; origin_type: string; prediction_interval_minutes: number;
  storage_timezone: string; display_timezone: string; output_unit: string; candidate_set_semantics: string;
  disclaimer: string; freshness_policy_json: unknown; blocking_policy_json: unknown; feature_flag_key: string;
  prediction_enabled: number; status: string; approved_by: string | null; approved_at_utc: string | null;
  updated_at_utc: string;
};

type DestinationRow = {
  scope_id: number; scope_key: string; scope_version: string; scope_status: string; prediction_enabled: number;
  destination_key: string; destination_label: string; route_group_key: string; display_order: number; active: number;
};

type DefinitionRow = {
  scope_key: string; scope_version: string; scope_status: string; prediction_enabled: number; display_order: number;
  route_id: number; slug: string; route_purpose: string; route_group_key: string | null; tourism_center_key: string | null;
  route_direction: "from_airport" | "to_airport" | "other"; origin_label: string; origin_lat: number; origin_lng: number;
  destination_label: string; destination_lat: number; destination_lng: number; category: string; active: number;
};

type LatestRouteRow = DefinitionRow & {
  route_sample_id: number | null; ingestion_run_id: number | null; collection_slot_utc: string | null;
  sampled_at_utc: string | null; provider: string | null; distance_meters: number | null;
  current_duration_seconds: number | null; typical_duration_seconds: number | null; base_duration_seconds: number | null;
  delay_vs_typical_seconds: number | null; delay_vs_base_seconds: number | null; ratio_vs_typical: number | null;
  ratio_vs_base: number | null; http_status: number | null; slot_age_minutes: number | null;
};

type RouteSlotRow = {
  collection_slot_utc: string; observed_route_count: number; successful_route_count: number;
  unsuccessful_route_count: number; first_sampled_at_utc: string | null; last_sampled_at_utc: string | null;
  minimum_ratio_vs_typical: number | null; maximum_ratio_vs_typical: number | null; average_ratio_vs_typical: number | null;
};

type SourceStatusRow = {
  dataset: string; run_id: number; run_token: string; collection_slot_utc: string; status: string;
  expected_count: number; successful_count: number; failed_count: number; record_count: number;
  started_at_utc: string; finished_at_utc: string | null; slot_age_minutes: number | null; error_json: unknown;
};

type CollectorAlertRow = {
  dataset: string; run_id: number; run_token: string; collection_slot_utc: string;
  status: string; expected_count: number; successful_count: number; failed_count: number;
  record_count: number; coverage_ratio: number | null; retry_count: number; http_429_count: number;
  started_at_utc: string; finished_at_utc: string | null; duration_seconds: number | null;
  slot_age_minutes: number | null; freshness_state: string; health_state: string; alert_code: string | null;
  is_stale: number; is_partial: number; is_failed: number; is_running: number; is_stuck: number;
};

type CollectorRunRow = {
  dataset: string; run_id: number; run_token: string; collection_slot_utc: string;
  status: string; expected_count: number; successful_count: number; failed_count: number;
  coverage_ratio: number | null; record_count: number; retry_count: number; http_429_count: number;
  attempt_count: number; started_at_utc: string; finished_at_utc: string | null;
  duration_seconds: number | null; slot_age_minutes: number | null; is_running: number;
  is_stuck: number; has_error: number; health_state: string;
};

function nullableNumber(value: unknown) {
  return value == null ? null : Number(value);
}

function objectPolicy(value: unknown) {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function sourceStatus(value: string): SourceStatus["status"] {
  if (value === "running" || value === "partial" || value === "failed") return value;
  return "success";
}

function freshnessState(value: string): CollectorState["freshnessState"] {
  if (value === "fresh" || value === "stale" || value === "critically_stale") return value;
  return "unknown";
}

function collectorState(row: CollectorAlertRow): CollectorState {
  return {
    dataset: row.dataset,
    runId: String(row.run_id),
    collectionSlotUtc: toIsoUtc(row.collection_slot_utc) as string,
    status: sourceStatus(row.status),
    expectedCount: Number(row.expected_count),
    successfulCount: Number(row.successful_count),
    failedCount: Number(row.failed_count),
    recordCount: Number(row.record_count),
    coverageRatio: nullableNumber(row.coverage_ratio),
    retryCount: Number(row.retry_count),
    http429Count: Number(row.http_429_count),
    startedAtUtc: toIsoUtc(row.started_at_utc) as string,
    finishedAtUtc: toIsoUtc(row.finished_at_utc),
    durationSeconds: nullableNumber(row.duration_seconds),
    slotAgeMinutes: nullableNumber(row.slot_age_minutes),
    freshnessState: freshnessState(row.freshness_state),
    healthState: row.health_state,
    alertCode: row.alert_code,
    isStale: Boolean(row.is_stale),
    isPartial: Boolean(row.is_partial),
    isFailed: Boolean(row.is_failed),
    isRunning: Boolean(row.is_running),
    isStuck: Boolean(row.is_stuck)
  };
}

function collectorRun(row: CollectorRunRow): CollectionRun {
  return {
    id: Number(row.run_id),
    slotUtc: toIsoUtc(row.collection_slot_utc) as string,
    status: sourceStatus(row.status),
    source: row.dataset === "flow" ? "HERE Flow" : "HERE Routes",
    expectedCount: Number(row.expected_count),
    successCount: Number(row.successful_count),
    failedCount: Number(row.failed_count),
    recordCount: Number(row.record_count),
    durationSeconds: nullableNumber(row.duration_seconds),
    attemptCount: Number(row.attempt_count),
    retryCount: Number(row.retry_count),
    http429Count: Number(row.http_429_count),
    slotAgeMinutes: nullableNumber(row.slot_age_minutes),
    coverage: nullableNumber(row.coverage_ratio),
    finishedAtUtc: toIsoUtc(row.finished_at_utc),
    healthState: row.health_state,
    isRunning: Boolean(row.is_running),
    isStuck: Boolean(row.is_stuck),
    errorMessage: Boolean(row.has_error) ? "Collector reported an error; details are restricted to operations." : null
  };
}

export async function getMobilityProductScope(query: QueryRows = queryRows): Promise<MobilityProductScope> {
  const rows = await query<ScopeRow>("SELECT * FROM api_mobility_scope_v1");
  if (rows.length !== 1) throw new ApiUnavailableError("The mobility product scope is unavailable or ambiguous.");
  const row = rows[0]!;
  return {
    scopeId: Number(row.scope_id), scopeKey: row.scope_key, scopeVersion: row.scope_version,
    name: row.name, description: row.description,
    origin: { key: row.origin_key, label: row.origin_label, type: row.origin_type },
    predictionIntervalMinutes: Number(row.prediction_interval_minutes), storageTimezone: row.storage_timezone,
    displayTimezone: row.display_timezone, outputUnit: row.output_unit,
    candidateSetSemantics: row.candidate_set_semantics, disclaimer: row.disclaimer,
    freshnessPolicy: objectPolicy(row.freshness_policy_json), blockingPolicy: objectPolicy(row.blocking_policy_json),
    featureFlagKey: row.feature_flag_key, predictionEnabled: Boolean(row.prediction_enabled), status: row.status,
    approvedBy: row.approved_by, approvedAtUtc: toIsoUtc(row.approved_at_utc),
    updatedAtUtc: toIsoUtc(row.updated_at_utc) as string
  };
}

export async function getAirportDestinations(query: QueryRows = queryRows): Promise<AirportDestinationConfig[]> {
  const rows = await query<DestinationRow>("SELECT * FROM api_airport_destinations_v1 ORDER BY display_order");
  return rows.map((row) => ({
    scopeId: Number(row.scope_id), scopeKey: row.scope_key, scopeVersion: row.scope_version,
    scopeStatus: row.scope_status, predictionEnabled: Boolean(row.prediction_enabled),
    destinationKey: row.destination_key, destinationLabel: row.destination_label,
    routeGroupKey: row.route_group_key, displayOrder: Number(row.display_order), active: Boolean(row.active)
  }));
}

function routeDefinition(row: DefinitionRow): AirportRouteDefinition {
  if (!row.route_group_key || !row.tourism_center_key) {
    throw new ApiUnavailableError("An airport-tourism route definition is missing required scope metadata.");
  }
  return {
    scopeKey: row.scope_key, scopeVersion: row.scope_version, scopeStatus: row.scope_status,
    predictionEnabled: Boolean(row.prediction_enabled), displayOrder: Number(row.display_order),
    routeId: Number(row.route_id), slug: row.slug, routePurpose: row.route_purpose,
    routeGroupKey: row.route_group_key, tourismCenterKey: row.tourism_center_key,
    routeDirection: row.route_direction,
    origin: { label: row.origin_label, latitude: Number(row.origin_lat), longitude: Number(row.origin_lng) },
    destination: { label: row.destination_label, latitude: Number(row.destination_lat), longitude: Number(row.destination_lng) },
    category: row.category, active: Boolean(row.active)
  };
}

export async function getAirportRouteDefinitions(query: QueryRows = queryRows): Promise<AirportRouteDefinition[]> {
  const rows = await query<DefinitionRow>(
    "SELECT * FROM api_airport_tourism_routes_v1 ORDER BY display_order, route_direction"
  );
  return rows.map(routeDefinition);
}

export async function getLatestAirportRouteMeasurements(query: QueryRows = queryRows): Promise<RouteSummary[]> {
  const rows = await query<LatestRouteRow>(
    `SELECT latest.*, definitions.route_purpose, definitions.category, definitions.active
       FROM api_airport_route_latest_v1 latest
       JOIN api_airport_tourism_routes_v1 definitions ON definitions.route_id = latest.route_id
      ORDER BY latest.display_order, latest.route_direction`
  );
  return rows.map((row) => {
    if (!row.route_group_key || !row.tourism_center_key) {
      throw new ApiUnavailableError("A latest airport-route row is missing required scope metadata.");
    }
    const collectionSlotUtc = toIsoUtc(row.collection_slot_utc);
    const current = nullableNumber(row.current_duration_seconds);
    const typical = nullableNumber(row.typical_duration_seconds);
    const delay = nullableNumber(row.delay_vs_typical_seconds);
    const ratio = nullableNumber(row.ratio_vs_typical);
    const stale = row.slot_age_minutes != null && Number(row.slot_age_minutes) > 90;
    return {
      id: Number(row.route_id), slug: row.slug, name: `${row.origin_label} to ${row.destination_label}`,
      originLabel: row.origin_label, destinationLabel: row.destination_label, category: row.category,
      routePurpose: row.route_purpose, routeGroupKey: row.route_group_key,
      tourismCenterKey: row.tourism_center_key, routeDirection: row.route_direction,
      distanceMeters: nullableNumber(row.distance_meters), currentDurationSeconds: current,
      typicalDurationSeconds: typical, baseDurationSeconds: nullableNumber(row.base_duration_seconds),
      delayVsTypicalSeconds: delay, delayVsBaseSeconds: nullableNumber(row.delay_vs_base_seconds),
      ratioVsTypical: ratio, ratioVsBase: nullableNumber(row.ratio_vs_base),
      collectionSlotUtc, sampledAtUtc: toIsoUtc(row.sampled_at_utc), provider: row.provider,
      typicalSeconds: typical, liveSeconds: current, delaySeconds: delay, congestionRatio: ratio,
      sampleHourUtc: collectionSlotUtc, confidence: null,
      status: collectionSlotUtc == null ? "missing" : stale ? "stale" : "fresh",
      geometryAvailable: row.route_sample_id != null && row.http_status != null && row.http_status >= 200 && row.http_status < 300
    };
  });
}

export async function getAirportRouteSlots(
  input: { from?: string; to?: string; limit: number },
  query: QueryRows = queryRows
): Promise<AirportRouteSlot[]> {
  const limit = validatedSqlLimit(input.limit);
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (input.from && input.to) {
    conditions.push("collection_slot_utc >= ? AND collection_slot_utc < ?");
    values.push(toMysqlDateTime(input.from), toMysqlDateTime(input.to));
  } else if (input.from) {
    conditions.push("collection_slot_utc >= ?");
    values.push(toMysqlDateTime(input.from));
  } else if (input.to) {
    conditions.push("collection_slot_utc <= ?");
    values.push(toMysqlDateTime(input.to));
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await query<RouteSlotRow>(
    `SELECT * FROM api_airport_route_slots_v1 ${where}
      ORDER BY collection_slot_utc DESC LIMIT ${limit}`,
    values
  );
  return rows.map((row) => ({
    collectionSlotUtc: toIsoUtc(row.collection_slot_utc) as string,
    observedRouteCount: Number(row.observed_route_count),
    successfulRouteCount: Number(row.successful_route_count),
    unsuccessfulRouteCount: Number(row.unsuccessful_route_count),
    firstSampledAtUtc: toIsoUtc(row.first_sampled_at_utc), lastSampledAtUtc: toIsoUtc(row.last_sampled_at_utc),
    minimumRatioVsTypical: nullableNumber(row.minimum_ratio_vs_typical),
    maximumRatioVsTypical: nullableNumber(row.maximum_ratio_vs_typical),
    averageRatioVsTypical: nullableNumber(row.average_ratio_vs_typical)
  }));
}

export async function getSourceStatuses(query: QueryRows = queryRows): Promise<SourceStatus[]> {
  const rows = await query<SourceStatusRow>("SELECT * FROM api_source_status_v1 ORDER BY dataset");
  return rows.map((row) => {
    const expected = Number(row.expected_count);
    const successful = Number(row.successful_count);
    return {
      dataset: row.dataset, runId: String(row.run_id), runToken: row.run_token,
      collectionSlotUtc: toIsoUtc(row.collection_slot_utc) as string, status: sourceStatus(row.status),
      expectedCount: expected, successfulCount: successful, failedCount: Number(row.failed_count),
      recordCount: Number(row.record_count), coverage: expected > 0 ? successful / expected : null,
      startedAtUtc: toIsoUtc(row.started_at_utc) as string, finishedAtUtc: toIsoUtc(row.finished_at_utc),
      slotAgeMinutes: nullableNumber(row.slot_age_minutes), errorPresent: row.error_json != null
    };
  });
}

/** Public, redacted collector state. Raw provider/collector errors never leave MySQL. */
export async function getCollectorAlertStates(query: QueryRows = queryRows): Promise<CollectorState[]> {
  const rows = await query<CollectorAlertRow>(
    "SELECT * FROM api_collector_alert_state_v1 WHERE dataset IN ('flow','routes') ORDER BY dataset"
  );
  const states = rows.map(collectorState);
  if (states.length !== 2 || !states.some((state) => state.dataset === "flow") || !states.some((state) => state.dataset === "routes")) {
    throw new ApiUnavailableError("The collector overview must contain exactly one Flow state and one Route state.");
  }
  return states;
}

/** Detailed history is intended only for role-protected operations endpoints. */
export async function getCollectorRunHistory(
  dataset: "flow" | "routes",
  input: { from: string; to: string; limit: number },
  query: QueryRows = queryRows
): Promise<CollectionRun[]> {
  const limit = validatedSqlLimit(input.limit);
  const view = dataset === "flow" ? "api_flow_run_history_v1" : "api_route_run_history_v1";
  const rows = await query<CollectorRunRow>(
    `SELECT * FROM ${view}
      WHERE collection_slot_utc >= ? AND collection_slot_utc < ?
      ORDER BY collection_slot_utc DESC, run_id DESC
      LIMIT ${limit}`,
    [toMysqlDateTime(input.from), toMysqlDateTime(input.to)]
  );
  return rows.map(collectorRun);
}
