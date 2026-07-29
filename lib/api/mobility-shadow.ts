import { toMysqlDateTime, queryRows, type QueryRows } from "@/lib/db/mysql";
import { toIsoUtc } from "@/lib/db/mappers";
import { ApiUnavailableError } from "@/lib/api/core";
import { bboxToWkt, validatedSqlLimit } from "@/lib/api/spatial";
import type {
  ApiMeta,
  CenterProperties,
  FeatureCollection,
  MobilityFlowProperties,
  MobilityZoneProperties
} from "@/lib/dashboard/types";

export const MOBILITY_MODEL_VERSION = "gravity-here-v1";
export const MOBILITY_DISCLAIMER =
  "Relative mobility prediction based on traffic, accessibility, and attraction signals. It does not represent actual people, vehicles, or trip counts.";
const FRESH_SECONDS = 60 * 60;

type RunRow = {
  model_run_id: number;
  flow_run_id: number;
  prediction_for_utc: string;
  status: "success" | "partial" | "failed" | "running";
  zone_count: number;
  od_count: number;
  input_coverage: number | null;
  started_at_utc: string;
  completed_at_utc: string | null;
  model_version: string;
};

export type MobilityRun = {
  modelRunId: number;
  sourceRunId: number;
  slotUtc: string;
  status: RunRow["status"];
  zoneCount: number;
  odCount: number;
  coverage: number | null;
  startedAtUtc: string;
  completedAtUtc: string | null;
  modelVersion: string;
};

function mapRun(row: RunRow): MobilityRun {
  return {
    modelRunId: Number(row.model_run_id),
    sourceRunId: Number(row.flow_run_id),
    slotUtc: toIsoUtc(row.prediction_for_utc) as string,
    status: row.status,
    zoneCount: Number(row.zone_count),
    odCount: Number(row.od_count),
    coverage: row.input_coverage == null ? null : Number(row.input_coverage),
    startedAtUtc: toIsoUtc(row.started_at_utc) as string,
    completedAtUtc: toIsoUtc(row.completed_at_utc),
    modelVersion: row.model_version
  };
}

const RUN_SELECT = `SELECT run.id AS model_run_id, run.flow_run_id,
  run.prediction_for_utc, run.status, run.zone_count, run.od_count,
  run.input_coverage, run.started_at_utc, run.completed_at_utc,
  version.version AS model_version
FROM mobility_model_runs run
JOIN mobility_model_versions version ON version.id = run.model_version_id`;

export async function resolveMobilityRun(
  at: string,
  query: QueryRows = queryRows
): Promise<{ run: MobilityRun; newest: MobilityRun | null; meta: Partial<ApiMeta> }> {
  const historical = at !== "latest";
  const values = historical ? [MOBILITY_MODEL_VERSION, toMysqlDateTime(at)] : [MOBILITY_MODEL_VERSION];
  const rows = await query<RunRow>(
    `${RUN_SELECT}
     WHERE version.version = ?
       AND run.status ${historical ? "IN ('success','partial') AND run.prediction_for_utc <= ?" : "= 'success'"}
     ORDER BY run.prediction_for_utc DESC, run.id DESC LIMIT 1`,
    values
  );
  if (!rows[0]) {
    throw new ApiUnavailableError(
      historical
        ? "No successful or partial mobility prediction exists at or before the requested UTC time."
        : "No successful mobility prediction is available."
    );
  }
  const run = mapRun(rows[0]);
  const newestRows = historical ? [] : await query<RunRow>(
    `${RUN_SELECT}
     WHERE version.version = ?
     ORDER BY run.prediction_for_utc DESC, run.id DESC LIMIT 1`,
    [MOBILITY_MODEL_VERSION]
  );
  const newest = newestRows[0] ? mapRun(newestRows[0]) : null;
  const freshnessSeconds = Math.max(0, Math.floor((Date.now() - new Date(run.slotUtc).getTime()) / 1000));
  const failedFallback = Boolean(
    newest && newest.modelRunId !== run.modelRunId &&
    newest.status === "failed" && new Date(newest.slotUtc).getTime() > new Date(run.slotUtc).getTime()
  );
  const stale = !historical && (failedFallback || freshnessSeconds > FRESH_SECONDS);
  return {
    run,
    newest,
    meta: {
      selectedSlot: run.slotUtc,
      slotUtc: run.slotUtc,
      requestedSlotUtc: at,
      actualSlotUtc: run.slotUtc,
      source: "mobility_shadow_mysql",
      sourceRunId: String(run.sourceRunId),
      modelRunId: String(run.modelRunId),
      modelVersion: run.modelVersion,
      status: run.status,
      stale,
      isStale: stale,
      isFallback: failedFallback,
      freshnessSeconds,
      coverage: run.coverage,
      semantics: "predicted_relative_mobility",
      disclaimer: MOBILITY_DISCLAIMER,
      ...(failedFallback ? { fallbackReason: "A newer model attempt failed; the latest successful prediction is being shown." } : {})
    }
  };
}

function parseGeometry(value: string | object) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export async function readMobilityZones(
  input: { bbox: [number, number, number, number]; at: string; limit: number },
  query: QueryRows = queryRows
) {
  const resolved = await resolveMobilityRun(input.at, query);
  const limit = validatedSqlLimit(input.limit);
  type Row = {
    zone_id: number; zone_key: string; name: string; zone_version: string;
    presence_score: number; inbound_score: number; outbound_score: number;
    hotspot_rank: number; confidence: number; feature_coverage: number | null;
    destination_attraction_score: number | null; mean_jam_factor: number | null;
    mean_relative_speed: number | null; geometry_geojson: string | object;
  };
  const rows = await query<Row>(
    `SELECT zone.id AS zone_id, zone.zone_key, zone.name, zone.zone_version,
       prediction.presence_score, prediction.inbound_score, prediction.outbound_score,
       prediction.hotspot_rank, prediction.confidence, feature.feature_coverage,
       feature.destination_attraction_score, feature.mean_jam_factor,
       feature.mean_relative_speed, ST_AsGeoJSON(zone.geometry) AS geometry_geojson
     FROM mobility_zone_predictions prediction
     JOIN mobility_zones zone ON zone.id = prediction.zone_id
     LEFT JOIN mobility_zone_features feature
       ON feature.model_run_id = prediction.model_run_id AND feature.zone_id = prediction.zone_id
     JOIN (SELECT ST_GeomFromText(?, 4326, 'axis-order=long-lat') AS viewport) bounds
     WHERE prediction.model_run_id = ? AND zone.active = 1
       AND MBRIntersects(zone.geometry, bounds.viewport)
       AND ST_Intersects(zone.geometry, bounds.viewport)
     ORDER BY prediction.hotspot_rank, zone.id LIMIT ${limit}`,
    [bboxToWkt(input.bbox), resolved.run.modelRunId]
  );
  const collection: FeatureCollection<MobilityZoneProperties> = {
    type: "FeatureCollection",
    features: rows.map((row) => ({
      type: "Feature",
      id: Number(row.zone_id),
      geometry: parseGeometry(row.geometry_geojson) as never,
      properties: {
        zoneId: Number(row.zone_id), zoneKey: row.zone_key, name: row.name,
        regencyName: row.name, zoneVersion: row.zone_version,
        timeBucketUtc: resolved.run.slotUtc, timeBucketLocal: resolved.run.slotUtc,
        presenceScore: Number(row.presence_score), inboundScore: Number(row.inbound_score),
        outboundScore: Number(row.outbound_score),
        attractionScore: Number(row.destination_attraction_score ?? 0),
        hotspotRank: Number(row.hotspot_rank), confidence: Number(row.confidence),
        featureCoverage: row.feature_coverage == null ? null : Number(row.feature_coverage),
        meanJamFactor: row.mean_jam_factor == null ? null : Number(row.mean_jam_factor),
        meanSpeedKph: row.mean_relative_speed == null ? null : Number(row.mean_relative_speed),
        modelVersion: resolved.run.modelVersion, runStatus: resolved.run.status as "success" | "partial",
        isStale: Boolean(resolved.meta.stale)
      }
    }))
  };
  const confidence = rows.length
    ? rows.reduce((sum, row) => sum + Number(row.confidence), 0) / rows.length
    : null;
  return { collection, run: resolved.run, meta: { ...resolved.meta, confidence } };
}

export async function readMobilityFlows(
  input: {
    bbox: [number, number, number, number]; at: string; limit: number; minScore: number;
    originZoneId?: number; destinationZoneId?: number;
  },
  query: QueryRows = queryRows
) {
  const resolved = await resolveMobilityRun(input.at, query);
  const limit = validatedSqlLimit(input.limit);
  type Row = {
    origin_zone_id: number; origin_zone_key: string; origin_name: string;
    origin_longitude: number; origin_latitude: number; destination_zone_id: number;
    destination_zone_key: string; destination_name: string;
    destination_longitude: number; destination_latitude: number;
    mobility_score: number; predicted_share: number; duration_seconds: number | null;
    distance_meters: number | null; confidence: number;
    route_geometry_geojson: string | object | null;
    route_geometry_updated_at_utc: string | null;
  };
  const values = [
    resolved.run.modelRunId, input.minScore,
    input.originZoneId ?? null, input.originZoneId ?? null,
    input.destinationZoneId ?? null, input.destinationZoneId ?? null
  ];
  const readRows = (withRouteCache: boolean) => query<Row>(
    `SELECT prediction.origin_zone_id, origin.zone_key AS origin_zone_key,
       origin.name AS origin_name,
       ST_Longitude(COALESCE(origin.matrix_routing_point, origin.centroid)) AS origin_longitude,
       ST_Latitude(COALESCE(origin.matrix_routing_point, origin.centroid)) AS origin_latitude,
       prediction.destination_zone_id, destination.zone_key AS destination_zone_key,
       destination.name AS destination_name,
       ST_Longitude(COALESCE(destination.matrix_routing_point, destination.centroid)) AS destination_longitude,
       ST_Latitude(COALESCE(destination.matrix_routing_point, destination.centroid)) AS destination_latitude,
       prediction.mobility_score, prediction.predicted_share,
       prediction.duration_seconds, prediction.distance_meters, prediction.confidence,
       ${withRouteCache
         ? "ST_AsGeoJSON(route_geometry.geometry)"
         : "NULL"} AS route_geometry_geojson,
       ${withRouteCache
         ? "route_geometry.fetched_at_utc"
         : "NULL"} AS route_geometry_updated_at_utc
     FROM mobility_od_predictions prediction
     JOIN mobility_zones origin ON origin.id = prediction.origin_zone_id
     JOIN mobility_zones destination ON destination.id = prediction.destination_zone_id
     ${withRouteCache
       ? `LEFT JOIN mobility_od_route_geometries route_geometry
            ON route_geometry.origin_zone_id = prediction.origin_zone_id
           AND route_geometry.destination_zone_id = prediction.destination_zone_id`
       : ""}
     WHERE prediction.model_run_id = ? AND prediction.mobility_score >= ?
       AND (? IS NULL OR prediction.origin_zone_id = ?)
       AND (? IS NULL OR prediction.destination_zone_id = ?)
     ORDER BY prediction.mobility_score DESC LIMIT ${limit}`,
    values
  );
  let rows: Row[];
  try {
    rows = await readRows(true);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ER_NO_SUCH_TABLE") throw error;
    rows = await readRows(false);
  }
  const collection: FeatureCollection<MobilityFlowProperties> = {
    type: "FeatureCollection",
    features: rows.map((row) => {
      const parsedRoute = (typeof row.route_geometry_geojson === "string"
        ? JSON.parse(row.route_geometry_geojson) as { type?: string; coordinates?: unknown }
        : row.route_geometry_geojson) as { type?: string; coordinates?: unknown } | null;
      const hasRoadPath = parsedRoute?.type === "LineString" &&
        Array.isArray(parsedRoute.coordinates) && parsedRoute.coordinates.length > 1;
      return {
        type: "Feature",
        id: `od-${row.origin_zone_id}-${row.destination_zone_id}`,
        geometry: hasRoadPath
          ? parsedRoute as { type: "LineString"; coordinates: [number, number][] }
          : {
              type: "LineString" as const,
              coordinates: [
                [Number(row.origin_longitude), Number(row.origin_latitude)],
                [Number(row.destination_longitude), Number(row.destination_latitude)]
              ]
            },
        properties: {
        originZoneId: Number(row.origin_zone_id), originZoneKey: row.origin_zone_key,
        destinationZoneId: Number(row.destination_zone_id), destinationZoneKey: row.destination_zone_key,
        originName: row.origin_name, destinationName: row.destination_name,
        mobilityScore: Number(row.mobility_score), predictedShare: Number(row.predicted_share),
        durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
        travelTimeSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
        distanceMeters: row.distance_meters == null ? null : Number(row.distance_meters),
        confidence: Number(row.confidence), modelVersion: resolved.run.modelVersion,
        pathSemantics: hasRoadPath ? "cached_here_road_path" : "zone_centroid_fallback",
        routeGeometryUpdatedAtUtc: row.route_geometry_updated_at_utc,
        metricSemantics: "relative_prediction_not_people_count"
      }
      };
    })
  };
  const confidence = rows.length
    ? rows.reduce((sum, row) => sum + Number(row.confidence), 0) / rows.length
    : null;
  return { collection, run: resolved.run, meta: { ...resolved.meta, confidence } };
}

export async function readMobilityCenters(
  input: { bbox: [number, number, number, number]; at: string; limit: number; category?: string },
  query: QueryRows = queryRows
) {
  const resolved = await resolveMobilityRun(input.at, query);
  const limit = validatedSqlLimit(input.limit);
  type Row = {
    zone_id: number; zone_key: string; zone_name: string; model_category: string;
    center_count: number; attraction_weight: number; longitude: number; latitude: number;
  };
  const rows = await query<Row>(
    `SELECT zone.id AS zone_id, zone.zone_key, zone.name AS zone_name,
       center.model_category, COUNT(*) AS center_count,
       SUM(center.base_attraction_weight) AS attraction_weight,
       ST_Longitude(zone.centroid) AS longitude, ST_Latitude(zone.centroid) AS latitude
     FROM activity_centers center
     JOIN mobility_zones zone ON zone.id = center.zone_id
     JOIN (SELECT ST_GeomFromText(?, 4326, 'axis-order=long-lat') AS viewport) bounds
     WHERE center.active = 1
       AND center.model_input_version = 'here-tourism-category-map-v1'
       AND (? IS NULL OR center.model_category = ?)
       AND ST_Contains(bounds.viewport, zone.centroid)
     GROUP BY zone.id, zone.zone_key, zone.name, center.model_category,
       zone.centroid
     ORDER BY zone.id, center.model_category LIMIT ${limit}`,
    [bboxToWkt(input.bbox), input.category ?? null, input.category ?? null]
  );
  const collection: FeatureCollection<CenterProperties> = {
    type: "FeatureCollection",
    features: rows.map((row) => ({
      type: "Feature", id: `${row.zone_id}-${row.model_category}`,
      geometry: { type: "Point", coordinates: [Number(row.longitude), Number(row.latitude)] },
      properties: {
        centerId: Number(row.zone_id), zoneId: Number(row.zone_id), zoneKey: row.zone_key,
        name: `${row.zone_name} · ${row.model_category}`, category: row.model_category,
        centerCount: Number(row.center_count), attractionScore: Number(row.attraction_weight),
        source: "here_places_aggregate"
      }
    }))
  };
  return { collection, run: resolved.run, meta: resolved.meta };
}

export async function readMobilityRuns(
  input: { from?: string; to?: string; status?: string; limit: number },
  query: QueryRows = queryRows
) {
  const limit = Math.min(500, validatedSqlLimit(input.limit));
  const rows = await query<RunRow>(
    `${RUN_SELECT}
     WHERE version.version = ?
       AND (? IS NULL OR run.prediction_for_utc >= ?)
       AND (? IS NULL OR run.prediction_for_utc < ?)
       AND (? IS NULL OR run.status = ?)
     ORDER BY run.prediction_for_utc DESC, run.id DESC LIMIT ${limit}`,
    [
      MOBILITY_MODEL_VERSION,
      input.from ? toMysqlDateTime(input.from) : null, input.from ? toMysqlDateTime(input.from) : null,
      input.to ? toMysqlDateTime(input.to) : null, input.to ? toMysqlDateTime(input.to) : null,
      input.status ?? null, input.status ?? null
    ]
  );
  return rows.map(mapRun);
}
