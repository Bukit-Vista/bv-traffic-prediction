import { toMysqlDateTime, queryRows, type QueryRows } from "@/lib/db/mysql";
import { toIsoUtc } from "@/lib/db/mappers";
import { fixtureForSlot, filterCollection, useDemoSource } from "@/lib/api/demo-source";
import { ApiNotFoundError, ApiUnavailableError } from "@/lib/api/core";
import { requireMobilityPredictionReady } from "@/lib/api/mobility-readiness";
import { bboxToWkt, validatedSqlLimit } from "@/lib/api/spatial";
import { calculateTrafficOverviewForCollection } from "@/lib/map/viewport-traffic";
import {
  getAirportRouteDefinitions,
  getAirportRouteSlots,
  getCollectorRunHistory,
  getLatestAirportRouteMeasurements
} from "@/lib/api/database-serving-contract";
import { completedUtcHourWindow, coverageForSlots, expectedSlots, MVP_ROUTES_PER_SLOT, type MvpUtcWindow } from "@/lib/api/mvp-window";
import type {
  CenterProperties,
  CollectionRun,
  FeatureCollection,
  FlowProperties,
  IncidentProperties,
  MobilityFlowProperties,
  MobilityZoneProperties,
  RouteHistoryPoint,
  RouteIdentity,
  RouteSummary,
  TrafficOverview,
  FlowSlot,
  ApiMeta,
  MvpWindowStatus
} from "@/lib/dashboard/types";

type MapInput = {
  bbox: [number, number, number, number];
  at: string;
  limit: number;
  minConfidence?: number;
  functionalClass?: number;
};

type GeometryRow = { geometry_json: string | object };

type FlowRunRow = {
  id: number;
  collection_slot_utc: string;
  started_at_utc: string;
  finished_at_utc: string | null;
  status: "running" | "success" | "partial" | "failed";
  attempt_count: number;
  area_expected_count: number;
  area_success_count: number;
  segment_count: number;
  observation_count: number;
  error_json: string | null;
};

function parseGeometry(value: string | object) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function selectedDate(at: string) {
  return at === "latest" ? null : toMysqlDateTime(at);
}

function nullableNumber(value: unknown) {
  return value == null ? null : Number(value);
}

function missingReadView(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  return code === "ER_NO_SUCH_TABLE" || /api_airport_route_(history|geometry)_v1/i.test(message);
}

function routeReadFallbackEnabled() {
  return process.env.ROUTE_READ_CONTRACT_FALLBACK_ENABLED !== "false";
}

async function getRouteDefinition(routeId: number, query: QueryRows): Promise<RouteIdentity> {
  const definition = (await getAirportRouteDefinitions(query)).find((route) => route.routeId === routeId && route.active);
  if (!definition) throw new ApiNotFoundError("ROUTE_NOT_FOUND", "The requested route is not an active airport-tourism route.");
  return {
    id: definition.routeId,
    slug: definition.slug,
    name: `${definition.origin.label} to ${definition.destination.label}`,
    originLabel: definition.origin.label,
    destinationLabel: definition.destination.label,
    category: definition.category,
    routePurpose: definition.routePurpose,
    routeGroupKey: definition.routeGroupKey,
    tourismCenterKey: definition.tourismCenterKey,
    routeDirection: definition.routeDirection
  };
}

type RouteIdentityRow = {
  id: number;
  slug: string;
  origin_label: string;
  destination_label: string;
  category: string;
  route_purpose: string;
  route_group_key: string | null;
  tourism_center_key: string | null;
  route_direction: "from_airport" | "to_airport" | "other";
};

function mapRouteIdentity(row: RouteIdentityRow): RouteIdentity {
  if (row.route_purpose !== "airport_tourism" || !row.route_group_key || !row.tourism_center_key || !row.route_direction) {
    throw new ApiUnavailableError("An airport-tourism route definition is missing required corridor metadata.");
  }
  return {
    id: Number(row.id), slug: row.slug, name: `${row.origin_label} to ${row.destination_label}`,
    originLabel: row.origin_label, destinationLabel: row.destination_label, category: row.category,
    routePurpose: row.route_purpose, routeGroupKey: row.route_group_key,
    tourismCenterKey: row.tourism_center_key, routeDirection: row.route_direction
  };
}

function runCoverage(run: Pick<FlowRunRow, "area_expected_count" | "area_success_count">) {
  return run.area_expected_count > 0 ? Number(run.area_success_count) / Number(run.area_expected_count) : null;
}

export async function resolveFlowResource(at: string, query: QueryRows = queryRows) {
  const exact = selectedDate(at);
  const selectedRows = await query<FlowRunRow>(
    exact
      ? `SELECT * FROM traffic_flow_collection_runs
          WHERE collection_slot_utc = ? AND status IN ('success','partial') AND observation_count > 0
          ORDER BY id DESC LIMIT 1`
      : `SELECT * FROM traffic_flow_collection_runs
          WHERE status IN ('success','partial') AND observation_count > 0
          ORDER BY collection_slot_utc DESC, id DESC LIMIT 1`,
    exact ? [exact] : []
  );
  const selected = selectedRows[0];
  if (!selected) {
    throw new ApiUnavailableError(exact ? "No Flow data exists for the requested exact collection slot." : "No eligible Flow collection is available.");
  }
  const newest = (await query<FlowRunRow>(
    `SELECT * FROM traffic_flow_collection_runs ORDER BY collection_slot_utc DESC, id DESC LIMIT 1`
  ))[0];
  const slotUtc = toIsoUtc(selected.collection_slot_utc) as string;
  const freshnessSeconds = Math.max(0, Math.floor((Date.now() - new Date(slotUtc).getTime()) / 1000));
  const newerRunFailed = Boolean(newest && newest.status === "failed" && new Date(newest.collection_slot_utc).getTime() > new Date(selected.collection_slot_utc).getTime());
  const window = completedUtcHourWindow();
  return {
    selected,
    newest: newest ?? null,
    slotUtc,
    meta: {
      selectedSlot: slotUtc,
      slotUtc,
      requestedSlotUtc: at,
      actualSlotUtc: slotUtc,
      windowStartUtc: window.startUtc,
      windowEndExclusiveUtc: window.endExclusiveUtc,
      windowHours: window.windowHours,
      source: "here_flow_mysql",
      sourceRunId: String(selected.id),
      status: selected.status,
      stale: at === "latest" && (newerRunFailed || freshnessSeconds > 90 * 60),
      isFallback: at === "latest" && newerRunFailed,
      fallbackSlotUtc: newerRunFailed ? slotUtc : null,
      freshnessSeconds,
      coverage: runCoverage(selected),
      confidence: null,
      semantics: "measured_traffic",
      disclaimer: "Measured HERE traffic for the selected collection slot; this is not a people count."
    } satisfies Partial<ApiMeta>
  };
}

function localTimestamp(iso: string) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Makassar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(new Date(iso));
  return `${parts.replace(" ", "T")}+08:00`;
}

export async function getFlowMap(
  input: MapInput,
  query: QueryRows = queryRows,
  resolvedFlow?: Awaited<ReturnType<typeof resolveFlowResource>>
): Promise<{ collection: FeatureCollection<FlowProperties>; selectedSlot: string; source: string; truncated: boolean; meta: Partial<ApiMeta> }> {
  const run = resolvedFlow ?? await resolveFlowResource(input.at, query);
  const limit = validatedSqlLimit(input.limit);
  const values: unknown[] = [bboxToWkt(input.bbox)];
  if (input.at !== "latest") values.push(toMysqlDateTime(run.slotUtc));
  values.push(input.minConfidence ?? 0);
  const functionalFilter = input.functionalClass == null ? "" : "AND s.functional_class = ?";
  if (input.functionalClass != null) values.push(input.functionalClass);
  const timeJoin = `JOIN traffic_flow_observations o ON o.segment_id = s.id AND o.collection_slot_utc = ?`;

  type Row = GeometryRow & {
    segment_id: number; provider: string; segment_key: string; provider_reference: string | null; reference_type: string;
    observation_id: number; road_name: string | null; functional_class: number | null; length_meters: number | null;
    collection_slot_utc: string; source_updated_utc: string | null; fetched_at_utc: string; observed_at_utc: string;
    speed_kph: number | null; speed_uncapped_kph: number | null; free_flow_kph: number | null; relative_speed: number | null;
    jam_factor: number | null; jam_tendency: number | null; confidence: number | null; traversability: string | null; road_closure: number;
  };
  const rows = input.at === "latest" ? await query<Row>(
    `SELECT f.segment_id, f.provider, f.segment_key, f.provider_reference, f.reference_type,
            f.observation_id, f.road_name, f.functional_class, f.length_meters,
            f.geometry_geojson AS geometry_json, f.collection_slot_utc, f.source_updated_utc,
            f.fetched_at_utc, f.collection_slot_utc AS observed_at_utc,
            f.speed_kph, f.speed_uncapped_kph, f.free_flow_kph, f.relative_speed,
            f.jam_factor, f.jam_tendency, f.confidence, f.traversability, f.road_closure,
            f.slot_age_minutes
       FROM api_traffic_flow_latest_v1 f
       JOIN (SELECT ST_GeomFromText(?, 4326, 'axis-order=long-lat') AS viewport) viewport
      WHERE MBRIntersects(ST_GeomFromGeoJSON(f.geometry_geojson), viewport.viewport)
        AND ST_Intersects(ST_GeomFromGeoJSON(f.geometry_geojson), viewport.viewport)
        AND COALESCE(f.confidence, 0) >= ?
        ${functionalFilter.replaceAll("s.", "f.")}
      ORDER BY f.jam_factor IS NULL, f.jam_factor DESC, f.segment_id
      LIMIT ${limit + 1}`,
    values
  ) : await query<Row>(
    `SELECT s.id AS segment_id, s.provider, s.segment_key, s.provider_reference, s.reference_type,
            o.id AS observation_id, s.road_name, s.functional_class,
            s.length_meters, ST_AsGeoJSON(s.geometry) AS geometry_json,
            o.collection_slot_utc, o.source_updated_utc, o.fetched_at_utc, o.observed_at_utc,
            o.speed_kph, o.speed_uncapped_kph, o.free_flow_kph, o.relative_speed, o.jam_factor, o.jam_tendency, o.confidence,
            o.traversability, o.road_closure
       FROM traffic_road_segments s
       JOIN (SELECT ST_GeomFromText(?, 4326, 'axis-order=long-lat') AS viewport) viewport
       ${timeJoin}
      WHERE MBRIntersects(s.geometry, viewport.viewport)
        AND ST_Intersects(s.geometry, viewport.viewport)
        AND COALESCE(o.confidence, 0) >= ?
        ${functionalFilter}
      ORDER BY o.jam_factor IS NULL, o.jam_factor DESC, s.id
      LIMIT ${limit + 1}`,
    values
  );
  const truncated = rows.length > limit;
  const selectedRows = rows.slice(0, limit);
  const collection: FeatureCollection<FlowProperties> = {
    type: "FeatureCollection",
    features: selectedRows.map((row) => ({
      type: "Feature",
      id: row.segment_key,
      geometry: parseGeometry(row.geometry_json) as never,
      properties: {
        segmentId: Number(row.segment_id), segmentKey: row.segment_key, provider: row.provider,
        providerReference: row.provider_reference, referenceType: row.reference_type,
        observationId: Number(row.observation_id),
        roadName: row.road_name ?? "Unnamed road", functionalClass: nullableNumber(row.functional_class),
        lengthMeters: nullableNumber(row.length_meters), collectionSlotUtc: toIsoUtc(row.collection_slot_utc) as string,
        sourceUpdatedUtc: toIsoUtc(row.source_updated_utc), fetchedAtUtc: toIsoUtc(row.fetched_at_utc) as string,
        observedAt: toIsoUtc(row.observed_at_utc) as string,
        speedKph: nullableNumber(row.speed_kph), speedUncappedKph: nullableNumber(row.speed_uncapped_kph),
        freeFlowKph: nullableNumber(row.free_flow_kph),
        relativeSpeed: nullableNumber(row.relative_speed), jamFactor: nullableNumber(row.jam_factor),
        jamTendency: nullableNumber(row.jam_tendency), confidence: nullableNumber(row.confidence),
        traversability: row.traversability, roadClosure: Boolean(row.road_closure),
        slotAgeMinutes: nullableNumber((row as Row & { slot_age_minutes?: number | null }).slot_age_minutes)
      }
    }))
  };
  const source = input.at === "latest" ? "api_traffic_flow_latest_v1" : "here_flow_mysql_exact_slot";
  return { collection, selectedSlot: run.slotUtc, source, truncated, meta: { ...run.meta, source } };
}

export async function getIncidentMap(
  input: Pick<MapInput, "bbox" | "at" | "limit">,
  query: QueryRows = queryRows
): Promise<{ collection: FeatureCollection<IncidentProperties>; selectedSlot: string | null; source: string }> {
  if (useDemoSource()) {
    const fixture = fixtureForSlot(input.at);
    return { collection: filterCollection(fixture.incidents, input.bbox, input.limit), selectedSlot: fixture.selectedSlot, source: "demo_fixture" };
  }
  const [west, south, east, north] = input.bbox;
  const at = selectedDate(input.at);
  type Row = GeometryRow & {
    id: number; icon_category: string | null; magnitude_of_delay: string | null;
    start_time_utc: string; end_time_utc: string | null; from_label: string | null;
    to_label: string | null; length_meters: number | null; snapshot_time: string;
    road_closure: number | null;
  };
  const rows = await query<Row>(
    `SELECT i.id, i.icon_category, i.magnitude_of_delay, i.start_time_utc,
            i.end_time_utc, i.from_label, i.to_label, i.length_meters,
            s.sample_hour_utc AS snapshot_time,
            JSON_EXTRACT(i.raw_incident_json, '$.criticality') = 'closure' AS road_closure,
            ST_AsGeoJSON(g.geometry) AS geometry_json
       FROM traffic_incident_snapshots s
       JOIN traffic_incidents i ON i.snapshot_id = s.id
       JOIN traffic_incident_geometries g ON g.incident_id = i.id
      WHERE s.sample_hour_utc = COALESCE(?, (
              SELECT MAX(sample_hour_utc) FROM traffic_incident_snapshots WHERE incident_count >= 0
            ))
        AND MBRIntersects(
              g.geometry,
              ST_MakeEnvelope(ST_SRID(POINT(?, ?), 4326), ST_SRID(POINT(?, ?), 4326))
            )
      ORDER BY i.id LIMIT ?`,
    [at, west, south, east, north, input.limit]
  );
  const collection: FeatureCollection<IncidentProperties> = {
    type: "FeatureCollection",
    features: rows.map((row) => ({
      type: "Feature", id: row.id, geometry: parseGeometry(row.geometry_json) as never,
      properties: {
        incidentId: Number(row.id), category: row.icon_category ?? "other",
        severity: row.magnitude_of_delay ?? "unknown",
        description: [row.from_label, row.to_label].filter(Boolean).join(" → ") || "Traffic incident",
        startTime: toIsoUtc(row.start_time_utc) as string, endTime: toIsoUtc(row.end_time_utc),
        roadClosure: Boolean(row.road_closure), lengthMeters: row.length_meters == null ? null : Number(row.length_meters),
        sourceTimestamp: toIsoUtc(row.snapshot_time) as string
      }
    }))
  };
  return { collection, selectedSlot: collection.features[0]?.properties.sourceTimestamp ?? null, source: "here_mysql" };
}

export async function getRoutes(at = "latest", query: QueryRows = queryRows): Promise<RouteSummary[]> {
  if (at === "latest") return getLatestAirportRouteMeasurements(query);
  const exact = selectedDate(at);
  type Row = RouteIdentityRow & {
    distance_meters: number | null; current_duration_seconds: number | null; typical_duration_seconds: number | null;
    base_duration_seconds: number | null; delay_vs_typical_seconds: number | null; delay_vs_base_seconds: number | null;
    ratio_vs_typical: number | null; ratio_vs_base: number | null; collection_slot_utc: string | null;
    sampled_at_utc: string | null; provider: string | null; geometry_available: number;
  };
  const rows = await query<Row>(
    `SELECT r.id, r.slug, r.origin_label, r.destination_label, r.category,
            r.route_purpose, r.route_group_key, r.tourism_center_key, r.route_direction,
            rs.distance_meters, rs.current_duration_seconds, rs.typical_duration_seconds,
            rs.base_duration_seconds, rs.delay_vs_typical_seconds, rs.delay_vs_base_seconds,
            rs.ratio_vs_typical, rs.ratio_vs_base, rs.collection_slot_utc,
            rs.sampled_at_utc, rs.provider,
            EXISTS(SELECT 1 FROM route_sample_geometries g WHERE g.route_sample_id = rs.id) AS geometry_available
       FROM routes r
       LEFT JOIN route_samples rs ON rs.id = (
          SELECT rs2.id FROM route_samples rs2
           WHERE rs2.route_id = r.id AND rs2.provider = 'here'
             AND (? IS NULL OR rs2.collection_slot_utc = ?)
           ORDER BY rs2.collection_slot_utc DESC, rs2.sampled_at_utc DESC, rs2.id DESC LIMIT 1
       )
      WHERE r.active = 1 AND r.route_purpose = 'airport_tourism'
      ORDER BY r.route_group_key, r.route_direction`,
    [exact, exact]
  );
  const mapped: RouteSummary[] = rows.map((row) => ({
    ...mapRouteIdentity(row),
    distanceMeters: row.distance_meters == null ? null : Number(row.distance_meters),
    currentDurationSeconds: nullableNumber(row.current_duration_seconds), typicalDurationSeconds: nullableNumber(row.typical_duration_seconds),
    baseDurationSeconds: nullableNumber(row.base_duration_seconds), delayVsTypicalSeconds: nullableNumber(row.delay_vs_typical_seconds),
    delayVsBaseSeconds: nullableNumber(row.delay_vs_base_seconds), ratioVsTypical: nullableNumber(row.ratio_vs_typical), ratioVsBase: nullableNumber(row.ratio_vs_base),
    collectionSlotUtc: toIsoUtc(row.collection_slot_utc), sampledAtUtc: toIsoUtc(row.sampled_at_utc), provider: row.provider,
    typicalSeconds: nullableNumber(row.typical_duration_seconds), liveSeconds: nullableNumber(row.current_duration_seconds),
    delaySeconds: nullableNumber(row.delay_vs_typical_seconds), congestionRatio: nullableNumber(row.ratio_vs_typical),
    sampleHourUtc: toIsoUtc(row.collection_slot_utc), confidence: null,
    status: row.collection_slot_utc == null ? "missing" : Date.now() - new Date(toIsoUtc(row.collection_slot_utc)!).getTime() > 90 * 60_000 ? "stale" : "fresh",
    geometryAvailable: Boolean(row.geometry_available)
  }));
  if (exact && mapped.every((route) => route.collectionSlotUtc == null)) {
    throw new ApiUnavailableError("No Route data exists for the requested exact collection slot.");
  }
  return mapped;
}

export async function getRouteResourceIdentity(at = "latest", query: QueryRows = queryRows) {
  const exact = selectedDate(at);
  type Row = RouteIdentityRow & {
    sample_id: number | null;
    collection_slot_utc: string | null;
    sampled_at_utc: string | null;
    distance_meters: number | null;
    current_duration_seconds: number | null;
    typical_duration_seconds: number | null;
    base_duration_seconds: number | null;
    delay_vs_typical_seconds: number | null;
    delay_vs_base_seconds: number | null;
    ratio_vs_typical: number | null;
    ratio_vs_base: number | null;
    provider: string | null;
    geometry_count: number;
  };
  const rows = await query<Row>(
    `SELECT r.id, r.slug, r.origin_label, r.destination_label, r.category,
            r.route_purpose, r.route_group_key, r.tourism_center_key, r.route_direction,
            rs.id AS sample_id, rs.collection_slot_utc, rs.sampled_at_utc,
            rs.distance_meters, rs.current_duration_seconds, rs.typical_duration_seconds,
            rs.base_duration_seconds, rs.delay_vs_typical_seconds, rs.delay_vs_base_seconds,
            rs.ratio_vs_typical, rs.ratio_vs_base, rs.provider,
            (SELECT COUNT(*) FROM route_sample_geometries g WHERE g.route_sample_id = rs.id) AS geometry_count
       FROM routes r
       LEFT JOIN route_samples rs ON rs.id = (
          SELECT rs2.id FROM route_samples rs2
           WHERE rs2.route_id = r.id AND rs2.provider = 'here'
             AND (? IS NULL OR rs2.collection_slot_utc = ?)
           ORDER BY rs2.collection_slot_utc DESC, rs2.sampled_at_utc DESC, rs2.id DESC LIMIT 1
       )
      WHERE r.active = 1 AND r.route_purpose = 'airport_tourism'
      ORDER BY r.route_group_key, r.route_direction`,
    [exact, exact]
  );
  const now = Date.now();
  const routeStatus = (slot: string | null) => slot == null
    ? "missing"
    : at === "latest" && now - new Date(slot).getTime() > 90 * 60_000 ? "stale" : "fresh";
  const routeIdentities = rows.map((row) => {
    const collectionSlotUtc = toIsoUtc(row.collection_slot_utc);
    return {
      id: Number(row.id), slug: row.slug, originLabel: row.origin_label, destinationLabel: row.destination_label,
      category: row.category, routePurpose: row.route_purpose, routeGroupKey: row.route_group_key,
      tourismCenterKey: row.tourism_center_key, routeDirection: row.route_direction,
      sampleId: row.sample_id == null ? null : Number(row.sample_id),
      collectionSlotUtc, sampledAtUtc: toIsoUtc(row.sampled_at_utc),
      distanceMeters: nullableNumber(row.distance_meters),
      currentDurationSeconds: nullableNumber(row.current_duration_seconds),
      typicalDurationSeconds: nullableNumber(row.typical_duration_seconds),
      baseDurationSeconds: nullableNumber(row.base_duration_seconds),
      delayVsTypicalSeconds: nullableNumber(row.delay_vs_typical_seconds),
      delayVsBaseSeconds: nullableNumber(row.delay_vs_base_seconds),
      ratioVsTypical: nullableNumber(row.ratio_vs_typical),
      ratioVsBase: nullableNumber(row.ratio_vs_base),
      provider: row.provider ?? null,
      status: routeStatus(collectionSlotUtc),
      geometryCount: Number(row.geometry_count)
    };
  });
  return {
    stale: routeIdentities.some((route) => route.status === "stale"),
    routes: routeIdentities
  };
}

export async function getDashboardVersionIdentities(query: QueryRows = queryRows) {
  type RouteRunRow = {
    id: number; collection_slot_utc: string; status: string; attempt_count: number;
    route_expected_count: number; route_success_count: number; route_failure_count: number;
    finished_at_utc: string | null; error_json: string | null;
  };
  const [flowResource, routeIdentity, routeRunRows] = await Promise.all([
    resolveFlowResource("latest", query),
    getRouteResourceIdentity("latest", query),
    query<RouteRunRow>(
      `SELECT id, collection_slot_utc, status, attempt_count, route_expected_count,
              route_success_count, route_failure_count, finished_at_utc, error_json
         FROM ingestion_runs WHERE source = 'n8n-here-routes'
        ORDER BY collection_slot_utc DESC, id DESC LIMIT 1`
    )
  ]);
  const selected = flowResource.selected;
  const newest = flowResource.newest ?? selected;
  const routeRun = routeRunRows[0] ?? null;
  return {
    flow: {
      id: Number(selected.id), slotUtc: flowResource.slotUtc, status: selected.status,
      observationCount: Number(selected.observation_count), segmentCount: Number(selected.segment_count),
      expectedAreas: Number(selected.area_expected_count), successfulAreas: Number(selected.area_success_count),
      attempts: Number(selected.attempt_count), finishedAtUtc: toIsoUtc(selected.finished_at_utc),
      hasError: Boolean(selected.error_json),
      stale: Boolean(flowResource.meta.stale)
    },
    routes: routeIdentity,
    flowHealth: {
      id: Number(newest.id), slotUtc: toIsoUtc(newest.collection_slot_utc), status: newest.status,
      attempts: Number(newest.attempt_count), observations: Number(newest.observation_count),
      expectedAreas: Number(newest.area_expected_count), successfulAreas: Number(newest.area_success_count),
      finishedAtUtc: toIsoUtc(newest.finished_at_utc), hasError: Boolean(newest.error_json)
    },
    routeHealth: routeRun ? {
      id: Number(routeRun.id), slotUtc: toIsoUtc(routeRun.collection_slot_utc), status: routeRun.status,
      attempts: Number(routeRun.attempt_count), expected: Number(routeRun.route_expected_count),
      successful: Number(routeRun.route_success_count), failed: Number(routeRun.route_failure_count),
      finishedAtUtc: toIsoUtc(routeRun.finished_at_utc), hasError: Boolean(routeRun.error_json)
    } : null
  };
}

export async function getMobilityZones(
  input: Pick<MapInput, "bbox" | "at" | "limit">,
  query: QueryRows = queryRows
): Promise<{ collection: FeatureCollection<MobilityZoneProperties>; selectedSlot: string | null; source: string; status: string }> {
  if (useDemoSource()) {
    const fixture = fixtureForSlot(input.at);
    return { collection: filterCollection(fixture.zones, input.bbox, input.limit), selectedSlot: fixture.selectedSlot, source: "demo_fixture", status: fixture.mobilityOverview.runStatus };
  }
  await requireMobilityPredictionReady(query);
  const [west, south, east, north] = input.bbox;
  const at = selectedDate(input.at);
  type Row = GeometryRow & {
    zone_id: number; zone_key: string; name: string | null; regency_name: string | null;
    time_bucket_utc: string; presence_score: number; inbound_score: number; outbound_score: number;
    attraction_score: number; hotspot_rank: number | null; confidence: number; mean_jam_factor: number | null;
    mean_speed_kph: number | null; version: string; status: "success" | "partial";
  };
  const rows = await query<Row>(
    `SELECT z.id AS zone_id, z.zone_key, z.name, z.regency_name,
            p.time_bucket_utc, p.presence_score, p.inbound_score, p.outbound_score,
            f.attraction_score, p.hotspot_rank, p.confidence, f.mean_jam_factor,
            f.mean_speed_kph, v.version, r.status, ST_AsGeoJSON(z.geometry) AS geometry_json
       FROM mobility_model_runs r
       JOIN mobility_model_versions v ON v.id = r.model_version_id
       JOIN mobility_zone_predictions p ON p.model_run_id = r.id
       JOIN mobility_zone_features f ON f.model_run_id = r.id AND f.zone_id = p.zone_id
       JOIN mobility_zones z ON z.id = p.zone_id
      WHERE r.id = (
          SELECT r2.id
            FROM mobility_model_runs r2
            JOIN mobility_model_versions v2 ON v2.id = r2.model_version_id
           WHERE r2.status IN ('success','partial') AND v2.active = 1
             AND (? IS NULL OR r2.prediction_for_utc = ?)
           ORDER BY r2.prediction_for_utc DESC, r2.id DESC LIMIT 1
        )
        AND z.active = 1
        AND MBRIntersects(
          z.geometry,
          ST_MakeEnvelope(ST_SRID(POINT(?, ?), 4326), ST_SRID(POINT(?, ?), 4326))
        )
      ORDER BY p.presence_score DESC LIMIT ?`,
    [at, at, west, south, east, north, input.limit]
  );
  const collection: FeatureCollection<MobilityZoneProperties> = {
    type: "FeatureCollection",
    features: rows.map((row) => {
      const bucket = toIsoUtc(row.time_bucket_utc) as string;
      return {
        type: "Feature", id: row.zone_id, geometry: parseGeometry(row.geometry_json) as never,
        properties: {
          zoneId: Number(row.zone_id), zoneKey: row.zone_key, name: row.name ?? row.zone_key,
          regencyName: row.regency_name, timeBucketUtc: bucket, timeBucketLocal: localTimestamp(bucket),
          presenceScore: Number(row.presence_score), inboundScore: Number(row.inbound_score),
          outboundScore: Number(row.outbound_score), attractionScore: Number(row.attraction_score),
          hotspotRank: row.hotspot_rank == null ? null : Number(row.hotspot_rank), confidence: Number(row.confidence),
          meanJamFactor: row.mean_jam_factor == null ? null : Number(row.mean_jam_factor),
          meanSpeedKph: row.mean_speed_kph == null ? null : Number(row.mean_speed_kph),
          modelVersion: row.version, runStatus: row.status, isStale: Date.now() - new Date(bucket).getTime() > 90 * 60_000
        }
      };
    })
  };
  return { collection, selectedSlot: collection.features[0]?.properties.timeBucketUtc ?? null, source: "mobility_mysql", status: collection.features[0]?.properties.runStatus ?? "unavailable" };
}

export async function getMobilityFlows(
  input: Pick<MapInput, "bbox" | "at" | "limit"> & { minScore: number; originZoneId?: number; destinationZoneId?: number },
  query: QueryRows = queryRows
): Promise<{ collection: FeatureCollection<MobilityFlowProperties>; selectedSlot: string | null; source: string }> {
  if (useDemoSource()) {
    const fixture = fixtureForSlot(input.at);
    const collection = filterCollection(fixture.mobilityFlows, input.bbox, input.limit, (p) =>
      p.mobilityScore >= input.minScore &&
      (input.originZoneId == null || p.originZoneId === input.originZoneId) &&
      (input.destinationZoneId == null || p.destinationZoneId === input.destinationZoneId)
    );
    return { collection, selectedSlot: fixture.selectedSlot, source: "demo_fixture" };
  }
  await requireMobilityPredictionReady(query);
  const [west, south, east, north] = input.bbox;
  const at = selectedDate(input.at);
  type Row = { origin_zone_id: number; destination_zone_id: number; origin_name: string; destination_name: string; origin_lng: number; origin_lat: number; destination_lng: number; destination_lat: number; time_bucket_utc: string; mobility_score: number; predicted_share: number; travel_time_seconds: number | null; confidence: number; version: string };
  const rows = await query<Row>(
    `SELECT od.origin_zone_id, od.destination_zone_id, zo.name AS origin_name,
            zd.name AS destination_name, ST_X(zo.centroid) AS origin_lng,
            ST_Y(zo.centroid) AS origin_lat, ST_X(zd.centroid) AS destination_lng,
            ST_Y(zd.centroid) AS destination_lat, od.time_bucket_utc,
            od.mobility_score, od.predicted_share, od.travel_time_seconds,
            od.confidence, v.version
       FROM mobility_model_runs r
       JOIN mobility_model_versions v ON v.id = r.model_version_id
       JOIN mobility_od_predictions od ON od.model_run_id = r.id
       JOIN mobility_zones zo ON zo.id = od.origin_zone_id
       JOIN mobility_zones zd ON zd.id = od.destination_zone_id
      WHERE r.id = (
          SELECT r2.id
            FROM mobility_model_runs r2
            JOIN mobility_model_versions v2 ON v2.id = r2.model_version_id
           WHERE r2.status IN ('success','partial') AND v2.active = 1
             AND (? IS NULL OR r2.prediction_for_utc = ?)
           ORDER BY r2.prediction_for_utc DESC, r2.id DESC LIMIT 1
        )
        AND od.mobility_score >= ?
        AND (? IS NULL OR od.origin_zone_id = ?)
        AND (? IS NULL OR od.destination_zone_id = ?)
        AND (MBRContains(ST_MakeEnvelope(ST_SRID(POINT(?, ?), 4326), ST_SRID(POINT(?, ?), 4326)), zo.centroid)
          OR MBRContains(ST_MakeEnvelope(ST_SRID(POINT(?, ?), 4326), ST_SRID(POINT(?, ?), 4326)), zd.centroid))
      ORDER BY od.mobility_score DESC LIMIT ?`,
    [at, at, input.minScore, input.originZoneId ?? null, input.originZoneId ?? null,
      input.destinationZoneId ?? null, input.destinationZoneId ?? null,
      west, south, east, north, west, south, east, north, input.limit]
  );
  const collection: FeatureCollection<MobilityFlowProperties> = {
    type: "FeatureCollection",
    features: rows.map((row, index) => ({
      type: "Feature", id: `od-${row.origin_zone_id}-${row.destination_zone_id}-${index}`,
      geometry: { type: "LineString", coordinates: [[Number(row.origin_lng), Number(row.origin_lat)], [Number(row.destination_lng), Number(row.destination_lat)]] },
      properties: {
        originZoneId: Number(row.origin_zone_id), destinationZoneId: Number(row.destination_zone_id),
        originName: row.origin_name, destinationName: row.destination_name,
        mobilityScore: Number(row.mobility_score), predictedShare: Number(row.predicted_share),
        travelTimeSeconds: row.travel_time_seconds == null ? null : Number(row.travel_time_seconds),
        confidence: Number(row.confidence), modelVersion: row.version,
        metricSemantics: "relative_prediction_not_people_count"
      }
    }))
  };
  return { collection, selectedSlot: rows[0] ? toIsoUtc(rows[0].time_bucket_utc) : null, source: "mobility_mysql" };
}

export async function getCenters(
  input: Pick<MapInput, "bbox" | "at" | "limit"> & { category?: string },
  query: QueryRows = queryRows
): Promise<{ collection: FeatureCollection<CenterProperties>; selectedSlot: string | null; source: string }> {
  if (useDemoSource()) {
    const fixture = fixtureForSlot(input.at);
    return { collection: filterCollection(fixture.centers, input.bbox, input.limit, (p) => !input.category || p.category === input.category), selectedSlot: fixture.selectedSlot, source: "demo_fixture" };
  }
  await requireMobilityPredictionReady(query);
  const [west, south, east, north] = input.bbox;
  type Row = { id: number; zone_id: number; name: string; category: string; source: string; base_attraction_weight: number; lng: number; lat: number };
  const rows = await query<Row>(
    `SELECT c.id, c.zone_id, c.name, c.category, c.source, c.base_attraction_weight,
            ST_X(c.location) AS lng, ST_Y(c.location) AS lat
       FROM activity_centers c
      WHERE c.active = 1 AND (? IS NULL OR c.category = ?)
        AND MBRContains(ST_MakeEnvelope(ST_SRID(POINT(?, ?), 4326), ST_SRID(POINT(?, ?), 4326)), c.location)
      ORDER BY c.base_attraction_weight DESC LIMIT ?`,
    [input.category ?? null, input.category ?? null, west, south, east, north, input.limit]
  );
  return {
    collection: { type: "FeatureCollection", features: rows.map((row) => ({
      type: "Feature", id: row.id, geometry: { type: "Point", coordinates: [Number(row.lng), Number(row.lat)] },
      properties: { centerId: Number(row.id), zoneId: Number(row.zone_id), name: row.name, category: row.category, attractionScore: Number(row.base_attraction_weight), source: row.source }
    })) },
    selectedSlot: input.at === "latest" ? null : input.at, source: "mobility_mysql"
  };
}

export async function getSlots(kind: "flow" | "mobility", from?: string, to?: string, query: QueryRows = queryRows) {
  if (useDemoSource()) return fixtureForSlot("latest").slots.filter((slot) => (!from || slot >= from) && (!to || slot <= to));
  if (kind === "mobility") await requireMobilityPredictionReady(query);
  const table = kind === "flow" ? "traffic_flow_collection_runs" : "mobility_model_runs";
  const column = kind === "flow" ? "collection_slot_utc" : "prediction_for_utc";
  const rows = await query<{ slot_utc: string }>(
    `SELECT DISTINCT ${column} AS slot_utc FROM ${table}
      WHERE status IN ('success','partial')
        AND (? IS NULL OR ${column} >= ?)
        AND (? IS NULL OR ${column} <= ?)
      ORDER BY ${column} DESC LIMIT 500`,
    [from ? toMysqlDateTime(from) : null, from ? toMysqlDateTime(from) : null, to ? toMysqlDateTime(to) : null, to ? toMysqlDateTime(to) : null]
  );
  return rows.map((row) => toIsoUtc(row.slot_utc) as string);
}

export async function getFlowSlots(from?: string, to?: string, query: QueryRows = queryRows): Promise<FlowSlot[]> {
  type Row = Pick<FlowRunRow, "id" | "collection_slot_utc" | "status" | "area_expected_count" | "area_success_count">;
  const rows = await query<Row>(
    `SELECT id, collection_slot_utc, status, area_expected_count, area_success_count
       FROM traffic_flow_collection_runs
      WHERE status IN ('success','partial') AND observation_count > 0
        AND (? IS NULL OR collection_slot_utc >= ?)
        AND (? IS NULL OR collection_slot_utc < ?)
      ORDER BY collection_slot_utc DESC, id DESC LIMIT 500`,
    [from ? toMysqlDateTime(from) : null, from ? toMysqlDateTime(from) : null,
      to ? toMysqlDateTime(to) : null, to ? toMysqlDateTime(to) : null]
  );
  const slots = rows.map((row) => ({
    slotUtc: toIsoUtc(row.collection_slot_utc) as string,
    sourceRunId: String(row.id),
    status: row.status as "success" | "partial",
    coverage: runCoverage(row)
  }));
  return [...new Map(slots.map((slot) => [slot.slotUtc, slot])).values()];
}

export async function getRuns(kind: "flow" | "hourly", query: QueryRows = queryRows): Promise<CollectionRun[]> {
  if (kind === "flow") {
    const rows = await query<FlowRunRow>(
      `SELECT * FROM traffic_flow_collection_runs ORDER BY collection_slot_utc DESC, id DESC LIMIT 100`
    );
    return rows.map((row) => ({
      id: Number(row.id), slotUtc: toIsoUtc(row.collection_slot_utc) as string, status: row.status,
      source: "HERE Flow", expectedCount: Number(row.area_expected_count), successCount: Number(row.area_success_count),
      failedCount: Math.max(0, Number(row.area_expected_count) - Number(row.area_success_count)), recordCount: Number(row.observation_count),
      durationSeconds: row.finished_at_utc ? Math.max(0, (new Date(toIsoUtc(row.finished_at_utc)!).getTime() - new Date(toIsoUtc(row.started_at_utc)!).getTime()) / 1000) : null,
      attemptCount: Number(row.attempt_count), coverage: runCoverage(row), finishedAtUtc: toIsoUtc(row.finished_at_utc),
      errorMessage: row.error_json ? "Collector reported an error; provider details are available to administrators." : null
    }));
  }
  type HourlyRow = { id: number; collection_slot_utc: string; started_at_utc: string; finished_at_utc: string | null; status: CollectionRun["status"]; attempt_count: number; route_expected_count: number; route_success_count: number; route_failure_count: number; error_json: string | null };
  const rows = await query<HourlyRow>(
    `SELECT id, collection_slot_utc, started_at_utc, finished_at_utc, status, attempt_count,
            route_expected_count, route_success_count, route_failure_count, error_json
       FROM ingestion_runs WHERE source = 'n8n-here-routes'
      ORDER BY collection_slot_utc DESC, id DESC LIMIT 100`
  );
  return rows.map((row) => ({
    id: Number(row.id), slotUtc: toIsoUtc(row.collection_slot_utc) as string, status: row.status, source: "n8n-here-routes",
    expectedCount: Number(row.route_expected_count), successCount: Number(row.route_success_count), failedCount: Number(row.route_failure_count),
    recordCount: Number(row.route_success_count),
    durationSeconds: row.finished_at_utc ? Math.max(0, (new Date(toIsoUtc(row.finished_at_utc)!).getTime() - new Date(toIsoUtc(row.started_at_utc)!).getTime()) / 1000) : null,
    attemptCount: Number(row.attempt_count),
    coverage: Number(row.route_expected_count) > 0 ? Number(row.route_success_count) / Number(row.route_expected_count) : null,
    finishedAtUtc: toIsoUtc(row.finished_at_utc),
    errorMessage: row.error_json ? "Collector reported an error; provider details are available to administrators." : null
  }));
}

export async function getTrafficOverview(
  input: MapInput,
  query: QueryRows = queryRows,
  resolvedFlow?: Awaited<ReturnType<typeof resolveFlowResource>>
): Promise<{ overview: TrafficOverview; meta: Partial<ApiMeta> }> {
  const [flow, routes] = await Promise.all([getFlowMap(input, query, resolvedFlow), getRoutes(input.at, query)]);
  return {
    overview: calculateTrafficOverviewForCollection({ flow: flow.collection, routes, coverage: flow.meta.coverage }),
    meta: flow.meta
  };
}

export async function getRouteHistory(
  routeId: number,
  input: { from?: string; to?: string; limit: number },
  query: QueryRows = queryRows
): Promise<{ route: RouteIdentity; points: RouteHistoryPoint[]; source: string }> {
  const limit = validatedSqlLimit(input.limit);
  const route = await getRouteDefinition(routeId, query);
  type Row = {
    collection_slot_utc: string; sampled_at_utc: string; current_duration_seconds: number;
    typical_duration_seconds: number; base_duration_seconds: number | null;
    delay_vs_typical_seconds: number | null; delay_vs_base_seconds: number | null;
    ratio_vs_typical: number | null; ratio_vs_base: number | null;
  };
  const values = [routeId, input.from ? toMysqlDateTime(input.from) : null, input.to ? toMysqlDateTime(input.to) : null];
  let source = "api_airport_route_history_v1";
  let rows: Row[];
  try {
    rows = await query<Row>(
      `SELECT collection_slot_utc, sampled_at_utc, current_duration_seconds,
              typical_duration_seconds, base_duration_seconds, delay_vs_typical_seconds,
              delay_vs_base_seconds, ratio_vs_typical, ratio_vs_base
         FROM api_airport_route_history_v1
        WHERE route_id = ? AND collection_slot_utc >= ? AND collection_slot_utc < ?
        ORDER BY collection_slot_utc ASC
        LIMIT ${limit}`,
      values
    );
  } catch (error) {
    if (!routeReadFallbackEnabled() || !missingReadView(error)) throw error;
    source = "legacy_route_tables_fallback";
    rows = await query<Row>(
      `SELECT rs.collection_slot_utc, rs.sampled_at_utc, rs.current_duration_seconds,
              rs.typical_duration_seconds, rs.base_duration_seconds, rs.delay_vs_typical_seconds,
              rs.delay_vs_base_seconds, rs.ratio_vs_typical, rs.ratio_vs_base
         FROM route_samples rs
        WHERE rs.route_id = ? AND rs.provider = 'here'
          AND rs.collection_slot_utc >= ? AND rs.collection_slot_utc < ?
        ORDER BY rs.collection_slot_utc ASC
        LIMIT ${limit}`,
      values
    );
  }
  const points = rows.map((row) => ({
    collectionSlotUtc: toIsoUtc(row.collection_slot_utc) as string,
    sampledAtUtc: toIsoUtc(row.sampled_at_utc) as string,
    currentDurationSeconds: nullableNumber(row.current_duration_seconds),
    typicalDurationSeconds: nullableNumber(row.typical_duration_seconds),
    baseDurationSeconds: nullableNumber(row.base_duration_seconds),
    delayVsTypicalSeconds: nullableNumber(row.delay_vs_typical_seconds),
    delayVsBaseSeconds: nullableNumber(row.delay_vs_base_seconds),
    ratioVsTypical: nullableNumber(row.ratio_vs_typical),
    ratioVsBase: nullableNumber(row.ratio_vs_base)
  }));
  return { route, points, source };
}

export async function getMvpWindowStatus(
  window: MvpUtcWindow,
  query: QueryRows = queryRows
): Promise<MvpWindowStatus> {
  const [flowRuns, routeRuns, routeSlots] = await Promise.all([
    getCollectorRunHistory("flow", { from: window.startUtc, to: window.endExclusiveUtc, limit: 500 }, query),
    getCollectorRunHistory("routes", { from: window.startUtc, to: window.endExclusiveUtc, limit: 500 }, query),
    getAirportRouteSlots({ from: window.startUtc, to: window.endExclusiveUtc, limit: 500 }, query)
  ]);
  const latestBySlot = (runs: CollectionRun[]) => {
    const result = new Map<string, CollectionRun>();
    for (const run of runs) if (!result.has(run.slotUtc)) result.set(run.slotUtc, run);
    return result;
  };
  const flowBySlot = latestBySlot(flowRuns);
  const routeRunsBySlot = latestBySlot(routeRuns);
  const routeSlotByUtc = new Map(routeSlots.map((slot) => [slot.collectionSlotUtc, slot]));
  const flowExpected = expectedSlots(window, 30);
  const routeExpected = expectedSlots(window, 60);
  const flowCoverage = coverageForSlots(flowExpected, flowBySlot.keys());
  const routeCoverage = coverageForSlots(routeExpected, routeSlotByUtc.keys());
  const flowPassedSlots = flowExpected.filter((slot) => {
    const run = flowBySlot.get(slot);
    return run?.status === "success" && run.expectedCount > 0 && run.successCount === run.expectedCount && !run.isStuck;
  }).length;
  const routePassedSlots = routeExpected.filter((slot) => {
    const run = routeRunsBySlot.get(slot);
    const measurements = routeSlotByUtc.get(slot);
    return run?.status === "success" && !run.isStuck && measurements?.successfulRouteCount === MVP_ROUTES_PER_SLOT;
  }).length;
  const presentSamples = routeExpected.reduce((total, slot) => total + (routeSlotByUtc.get(slot)?.successfulRouteCount ?? 0), 0);
  const flowPartialSlotsUtc = flowExpected.filter((slot) => {
    const run = flowBySlot.get(slot);
    return Boolean(run && (run.status === "partial" || (run.status === "success" && run.successCount < run.expectedCount)));
  });
  const flowFailedSlotsUtc = flowExpected.filter((slot) => flowBySlot.get(slot)?.status === "failed");
  const flowStuckSlotsUtc = flowExpected.filter((slot) => Boolean(flowBySlot.get(slot)?.isStuck));
  const routePartialSlotsUtc = routeExpected.filter((slot) => {
    const run = routeRunsBySlot.get(slot);
    const measurements = routeSlotByUtc.get(slot);
    return Boolean((run && (run.status === "partial" || (run.status === "success" && run.successCount < run.expectedCount))) ||
      (measurements && measurements.successfulRouteCount < MVP_ROUTES_PER_SLOT));
  });
  const routeFailedSlotsUtc = routeExpected.filter((slot) => routeRunsBySlot.get(slot)?.status === "failed");
  const routeStuckSlotsUtc = routeExpected.filter((slot) => Boolean(routeRunsBySlot.get(slot)?.isStuck));

  type GeometryCountRow = { collection_slot_utc: string; geometry_route_count: number };
  let geometryRows: GeometryCountRow[];
  const values = [toMysqlDateTime(window.startUtc), toMysqlDateTime(window.endExclusiveUtc)];
  try {
    geometryRows = await query<GeometryCountRow>(
      `SELECT collection_slot_utc, COUNT(DISTINCT route_id) AS geometry_route_count
         FROM api_airport_route_geometry_v1
        WHERE collection_slot_utc >= ? AND collection_slot_utc < ?
        GROUP BY collection_slot_utc`,
      values
    );
  } catch (error) {
    if (!routeReadFallbackEnabled() || !missingReadView(error)) throw error;
    geometryRows = await query<GeometryCountRow>(
      `SELECT rs.collection_slot_utc, COUNT(DISTINCT rs.route_id) AS geometry_route_count
         FROM route_samples rs
        WHERE rs.provider = 'here' AND rs.collection_slot_utc >= ? AND rs.collection_slot_utc < ?
          AND EXISTS (SELECT 1 FROM route_sample_geometries g WHERE g.route_sample_id = rs.id)
        GROUP BY rs.collection_slot_utc`,
      values
    );
  }
  const geometryBySlot = new Map(geometryRows.map((row) => [toIsoUtc(row.collection_slot_utc) as string, Number(row.geometry_route_count)]));
  const missingGeometrySlotsUtc = routeExpected.filter((slot) => (geometryBySlot.get(slot) ?? 0) < MVP_ROUTES_PER_SLOT);
  const presentGeometries = routeExpected.reduce((total, slot) => total + Math.min(MVP_ROUTES_PER_SLOT, geometryBySlot.get(slot) ?? 0), 0);
  const expectedSamples = routeExpected.length * MVP_ROUTES_PER_SLOT;
  const complete = flowCoverage.presentSlots === flowExpected.length && flowPassedSlots === flowExpected.length &&
    routeCoverage.presentSlots === routeExpected.length && routePassedSlots === routeExpected.length &&
    presentSamples === expectedSamples && presentGeometries === expectedSamples;
  return {
    ...window,
    status: complete ? "complete" : "partial",
    flow: {
      ...flowCoverage, passedSlots: flowPassedSlots,
      partialSlotsUtc: flowPartialSlotsUtc, failedSlotsUtc: flowFailedSlotsUtc, stuckSlotsUtc: flowStuckSlotsUtc
    },
    routes: {
      ...routeCoverage,
      passedSlots: routePassedSlots,
      partialSlotsUtc: routePartialSlotsUtc,
      failedSlotsUtc: routeFailedSlotsUtc,
      stuckSlotsUtc: routeStuckSlotsUtc,
      expectedRoutesPerSlot: MVP_ROUTES_PER_SLOT,
      expectedSamples,
      presentSamples,
      expectedGeometries: expectedSamples,
      presentGeometries,
      missingGeometrySlotsUtc
    }
  };
}

export async function getRouteGeometry(routeId: number, at = "latest", query: QueryRows = queryRows) {
  const route = await getRouteDefinition(routeId, query);
  const exact = selectedDate(at);
  type ViewRow = { route_sample_id: number; collection_slot_utc: string; section_index: number; geometry_geojson: string | object };
  try {
    const rows = await query<ViewRow>(exact
      ? `SELECT route_sample_id, collection_slot_utc, section_index, geometry_geojson
           FROM api_airport_route_geometry_v1
          WHERE route_id = ? AND collection_slot_utc = ?
          ORDER BY section_index ASC`
      : `SELECT route_sample_id, collection_slot_utc, section_index, geometry_geojson
           FROM api_airport_route_geometry_v1
          WHERE route_id = ? AND collection_slot_utc = (
            SELECT MAX(collection_slot_utc) FROM api_airport_route_geometry_v1 WHERE route_id = ?
          )
          ORDER BY section_index ASC`, exact ? [routeId, exact] : [routeId, routeId]);
    if (!rows.length) throw new ApiNotFoundError("SLOT_NOT_FOUND", "No HERE route geometry exists for the requested collection slot.", exact ? at : null);
    const slotUtc = toIsoUtc(rows[0]!.collection_slot_utc) as string;
    return {
      collection: { type: "FeatureCollection" as const, features: rows.map((section) => ({
        type: "Feature" as const, id: `${routeId}-${section.section_index}`,
        geometry: parseGeometry(section.geometry_geojson) as never,
        properties: { routeId, routePurpose: route.routePurpose, routeGroupKey: route.routeGroupKey,
          tourismCenterKey: route.tourismCenterKey, routeDirection: route.routeDirection,
          sectionIndex: Number(section.section_index), collectionSlotUtc: slotUtc,
          sampledAtUtc: null, geometrySemantics: "actual_here_route_path" }
      })) },
      slotUtc, sourceRunId: null, route, source: "api_airport_route_geometry_v1"
    };
  } catch (error) {
    if (error instanceof ApiNotFoundError) throw error;
    if (!routeReadFallbackEnabled() || !missingReadView(error)) throw error;
  }
  type SampleRow = RouteIdentityRow & { sample_id: number; ingestion_run_id: number | null; collection_slot_utc: string; sampled_at_utc: string };
  const sample = (await query<SampleRow>(
    exact
      ? `SELECT r.id, r.slug, r.origin_label, r.destination_label, r.category, r.route_purpose,
            r.route_group_key, r.tourism_center_key, r.route_direction,
            s.id AS sample_id, s.ingestion_run_id, s.collection_slot_utc, s.sampled_at_utc
       FROM routes r
       JOIN route_samples s ON s.route_id = r.id
      WHERE r.id = ? AND r.active = 1 AND r.route_purpose = 'airport_tourism'
        AND s.provider = 'here' AND s.collection_slot_utc = ?
        AND EXISTS (SELECT 1 FROM route_sample_geometries g WHERE g.route_sample_id = s.id)
      ORDER BY s.sampled_at_utc DESC, s.id DESC LIMIT 1`
      : `SELECT r.id, r.slug, r.origin_label, r.destination_label, r.category, r.route_purpose,
            r.route_group_key, r.tourism_center_key, r.route_direction,
            s.id AS sample_id, s.ingestion_run_id, s.collection_slot_utc, s.sampled_at_utc
       FROM routes r
       JOIN route_samples s ON s.route_id = r.id
      WHERE r.id = ? AND r.active = 1 AND r.route_purpose = 'airport_tourism'
        AND s.provider = 'here'
        AND EXISTS (SELECT 1 FROM route_sample_geometries g WHERE g.route_sample_id = s.id)
      ORDER BY s.collection_slot_utc DESC, s.sampled_at_utc DESC, s.id DESC LIMIT 1`,
    exact ? [routeId, exact] : [routeId]
  ))[0];
  if (!sample) throw new ApiNotFoundError("SLOT_NOT_FOUND", "No HERE route geometry exists for the requested collection slot.", exact ? at : null);
  type SectionRow = GeometryRow & { section_index: number };
  const sections = await query<SectionRow>(
    `SELECT section_index, ST_AsGeoJSON(geometry) AS geometry_json
       FROM route_sample_geometries WHERE route_sample_id = ? ORDER BY section_index ASC`,
    [sample.sample_id]
  );
  if (!sections.length) throw new ApiUnavailableError("No persisted HERE geometry is available for this route sample.");
  const slotUtc = toIsoUtc(sample.collection_slot_utc) as string;
  return {
    collection: {
      type: "FeatureCollection" as const,
      features: sections.map((section) => ({
        type: "Feature" as const,
        id: `${routeId}-${section.section_index}`,
        geometry: parseGeometry(section.geometry_json) as never,
        properties: {
          routeId, routePurpose: route.routePurpose, routeGroupKey: route.routeGroupKey,
          tourismCenterKey: route.tourismCenterKey, routeDirection: route.routeDirection,
          sectionIndex: Number(section.section_index), collectionSlotUtc: slotUtc,
          sampledAtUtc: toIsoUtc(sample.sampled_at_utc), geometrySemantics: "actual_here_route_path"
        }
      }))
    },
    slotUtc,
    sourceRunId: sample.ingestion_run_id == null ? null : String(sample.ingestion_run_id),
    route,
    source: "legacy_route_tables_fallback"
  };
}
