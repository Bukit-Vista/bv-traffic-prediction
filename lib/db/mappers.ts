import type {
  IngestionRun,
  Route,
  RouteSample,
  TrafficIncident,
  TrafficSource
} from "@/lib/db/types";

export type RouteRow = {
  id: number;
  slug: string;
  origin_label: string;
  origin_lat: number;
  origin_lng: number;
  destination_label: string;
  destination_lat: number;
  destination_lng: number;
  category: string;
  active: number | boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

export type RouteSampleRow = {
  id: number;
  route_id: number;
  ingestion_run_id: number | null;
  sample_hour_utc: string | Date;
  sampled_at_utc: string | Date;
  provider: string;
  api_product: string;
  traffic_source: string;
  distance_meters: number;
  duration_seconds: number;
  traffic_duration_seconds: number;
  traffic_delay_seconds: number;
  congestion_score: number | string;
  http_status: number | null;
  tracking_id: string | null;
  raw_summary_json: unknown;
};

export type IngestionRunRow = {
  id: number;
  source: string;
  sample_hour_utc: string | Date;
  started_at_utc: string | Date;
  finished_at_utc: string | Date | null;
  status: string;
  route_expected_count: number;
  route_success_count: number;
  route_failure_count: number;
  incident_success: number | boolean;
  flow_tile_expected_count: number;
  flow_tile_success_count: number;
  error_json: unknown;
};

export type TrafficIncidentRow = {
  id: number;
  snapshot_id: number;
  provider_incident_id: string | null;
  icon_category: string | null;
  magnitude_of_delay: string | null;
  start_time_utc: string | Date | null;
  end_time_utc: string | Date | null;
  from_label: string | null;
  to_label: string | null;
  length_meters: number | null;
  delay_seconds: number | null;
  geometry_geojson: unknown;
  raw_incident_json: unknown;
};

export function toIsoUtc(value: string | Date | null) {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = value.includes("T")
    ? value
    : value.trim().replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const date = new Date(withZone);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid UTC datetime from MySQL: ${value}`);
  }

  return date.toISOString();
}

export function parseJson(value: unknown) {
  if (value == null || typeof value !== "string") {
    return value ?? null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function trafficSource(value: string): TrafficSource {
  return value === "historical" ? "historical" : "live";
}

function ingestionStatus(value: string): IngestionRun["status"] {
  if (value === "running" || value === "partial" || value === "failed") {
    return value;
  }
  return "success";
}

export function mapRoute(row: RouteRow): Route {
  return {
    id: Number(row.id),
    slug: row.slug,
    originLabel: row.origin_label,
    originLat: Number(row.origin_lat),
    originLng: Number(row.origin_lng),
    destinationLabel: row.destination_label,
    destinationLat: Number(row.destination_lat),
    destinationLng: Number(row.destination_lng),
    category: row.category,
    active: Boolean(row.active),
    createdAt: toIsoUtc(row.created_at) as string,
    updatedAt: toIsoUtc(row.updated_at) as string
  };
}

export function mapRouteSample(row: RouteSampleRow): RouteSample {
  return {
    id: Number(row.id),
    routeId: Number(row.route_id),
    ingestionRunId: row.ingestion_run_id == null ? null : Number(row.ingestion_run_id),
    sampleHour: toIsoUtc(row.sample_hour_utc) as string,
    sampledAt: toIsoUtc(row.sampled_at_utc) as string,
    provider: row.provider,
    apiProduct: row.api_product,
    trafficSource: trafficSource(row.traffic_source),
    distanceMeters: Number(row.distance_meters),
    durationSeconds: Number(row.duration_seconds),
    trafficDurationSeconds: Number(row.traffic_duration_seconds),
    trafficDelaySeconds: Number(row.traffic_delay_seconds),
    congestionScore: Number(row.congestion_score),
    httpStatus: row.http_status == null ? null : Number(row.http_status),
    trackingId: row.tracking_id,
    rawSummaryJson: parseJson(row.raw_summary_json)
  };
}

export function mapIngestionRun(row: IngestionRunRow): IngestionRun {
  return {
    id: Number(row.id),
    source: row.source,
    sampleHour: toIsoUtc(row.sample_hour_utc) as string,
    startedAt: toIsoUtc(row.started_at_utc) as string,
    finishedAt: toIsoUtc(row.finished_at_utc),
    status: ingestionStatus(row.status),
    routeExpectedCount: Number(row.route_expected_count),
    routeSuccessCount: Number(row.route_success_count),
    routeFailureCount: Number(row.route_failure_count),
    incidentSuccess: Boolean(row.incident_success),
    flowTileExpectedCount: Number(row.flow_tile_expected_count),
    flowTileSuccessCount: Number(row.flow_tile_success_count),
    errorJson: parseJson(row.error_json)
  };
}

export function mapTrafficIncident(row: TrafficIncidentRow): TrafficIncident {
  return {
    id: Number(row.id),
    snapshotId: Number(row.snapshot_id),
    providerIncidentId: row.provider_incident_id,
    iconCategory: row.icon_category,
    magnitudeOfDelay: row.magnitude_of_delay,
    startTime: toIsoUtc(row.start_time_utc),
    endTime: toIsoUtc(row.end_time_utc),
    fromLabel: row.from_label,
    toLabel: row.to_label,
    lengthMeters: row.length_meters == null ? null : Number(row.length_meters),
    delaySeconds: row.delay_seconds == null ? null : Number(row.delay_seconds),
    geometryGeoJson: parseJson(row.geometry_geojson),
    rawIncidentJson: parseJson(row.raw_incident_json)
  };
}
