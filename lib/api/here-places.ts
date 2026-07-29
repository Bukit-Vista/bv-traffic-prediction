import { queryRows, type QueryRows } from "@/lib/db/mysql";
import { toIsoUtc } from "@/lib/db/mappers";
import type { ApiMeta, FeatureCollection } from "@/lib/dashboard/types";

const MODEL_INPUT_VERSION = "here-tourism-category-map-v1";
const HERE_DISPLAY_CATEGORY_SQL = `CASE
  WHEN LOWER(primary_category_name) LIKE '%beach%' THEN 'beach'
  WHEN LOWER(primary_category_name) REGEXP 'restaurant|food|caf|dining|bakery|coffee' THEN 'dining'
  WHEN LOWER(primary_category_name) REGEXP 'hotel|lodging|resort|hostel|accommodation' THEN 'accommodation'
  WHEN LOWER(primary_category_name) REGEXP 'museum|gallery|historic|religious|temple|culture' THEN 'culture'
  WHEN LOWER(primary_category_name) REGEXP 'shop|store|market|mall' THEN 'shopping'
  WHEN LOWER(primary_category_name) REGEXP 'bar|pub|night|entertainment' THEN 'nightlife'
  WHEN LOWER(primary_category_name) REGEXP 'park|recreation|sport|golf|fitness' THEN 'recreation'
  WHEN LOWER(primary_category_name) REGEXP 'airport|transport|station|terminal|parking|ferry' THEN 'transport'
  ELSE 'attraction'
END`;

function hereDisplayCategory(primaryCategory: string) {
  const value = primaryCategory.toLowerCase();
  if (value.includes("beach")) return "beach";
  if (/restaurant|food|caf|dining|bakery|coffee/.test(value)) return "dining";
  if (/hotel|lodging|resort|hostel|accommodation/.test(value)) return "accommodation";
  if (/museum|gallery|historic|religious|temple|culture/.test(value)) return "culture";
  if (/shop|store|market|mall/.test(value)) return "shopping";
  if (/bar|pub|night|entertainment/.test(value)) return "nightlife";
  if (/park|recreation|sport|golf|fitness/.test(value)) return "recreation";
  if (/airport|transport|station|terminal|parking|ferry/.test(value)) return "transport";
  return "attraction";
}

type PlacesInput = {
  mode: "aggregate" | "cluster" | "point";
  bbox?: [number, number, number, number];
  zoom?: number;
  category?: string;
  eligibleOnly: boolean;
  limit: number;
  cursor?: string;
  at: string;
};

type ImportRow = {
  import_run_id: number;
  import_version: string;
  zone_version: string;
  category_mapping_version: string;
  completed_at_utc: string;
  status: string;
  saturated_task_count: number;
  failed_task_count: number;
  age_minutes: number;
};

type Cursor = { weight: number; id: number };

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value?: string): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (!Number.isFinite(parsed.weight) || !Number.isInteger(parsed.id) || Number(parsed.id) <= 0) throw new Error();
    return { weight: Number(parsed.weight), id: Number(parsed.id) };
  } catch {
    throw new RangeError("cursor is invalid or expired");
  }
}

async function placesMeta(query: QueryRows): Promise<Partial<ApiMeta>> {
  const row = (await query<ImportRow>(
    `SELECT import_run_id, import_version, zone_version, category_mapping_version,
       completed_at_utc, status, saturated_task_count, failed_task_count, age_minutes
     FROM api_here_place_import_status_v1
     WHERE completed_at_utc IS NOT NULL
     ORDER BY completed_at_utc DESC, import_run_id DESC LIMIT 1`
  ))[0];
  if (!row) throw new RangeError("No accepted HERE Places import is available.");
  return {
    source: "HERE Geocoding and Search",
    semantics: "source_activity_centers",
    status: row.saturated_task_count > 0 ? "partial" : row.status === "success" ? "success" : "partial",
    stale: Number(row.age_minutes) > 45 * 24 * 60,
    isStale: Number(row.age_minutes) > 45 * 24 * 60,
    placeImportRunId: Number(row.import_run_id),
    importVersion: row.import_version,
    categoryMappingVersion: row.category_mapping_version,
    zoneVersion: row.zone_version,
    lastImportedAtUtc: toIsoUtc(row.completed_at_utc),
    saturatedTaskCount: Number(row.saturated_task_count),
    failedTaskCount: Number(row.failed_task_count),
    disclaimer: "HERE activity centers are source and model-input locations. Attraction weight is not people, popularity, visits, or trip counts."
  };
}

export async function readHerePlaces(input: PlacesInput, query: QueryRows = queryRows) {
  const meta = await placesMeta(query);
  const eligibility = input.eligibleOnly ? "AND model_eligible = 1" : "";
  const category = input.category ? `AND (${HERE_DISPLAY_CATEGORY_SQL}) = ?` : "";
  const categoryValues = input.category ? [input.category] : [];

  if (input.mode === "aggregate") {
    type Row = {
      zone_id: number; zone_key: string; zone_name: string; display_category: string;
      model_eligible: number; eligibility_reason: string | null; access_scope: string;
      center_count: number; attraction_weight: number; longitude: number; latitude: number;
      last_seen_at_utc: string;
    };
    const displayGrouping = input.eligibleOnly
      ? ""
      : ", model_eligible, eligibility_reason, access_scope";
    const rows = await query<Row>(
      `SELECT zone_id, zone_key, zone_name, ${HERE_DISPLAY_CATEGORY_SQL} AS display_category,
         ${input.eligibleOnly ? "1 AS model_eligible, NULL AS eligibility_reason, 'model_eligible' AS access_scope" : "model_eligible, eligibility_reason, access_scope"},
         COUNT(*) AS center_count, ROUND(SUM(base_attraction_weight), 5) AS attraction_weight,
         AVG(longitude) AS longitude, AVG(latitude) AS latitude,
         MAX(last_seen_at_utc) AS last_seen_at_utc
       FROM api_activity_centers_v1
       WHERE active = 1 ${eligibility}
         AND model_input_version = _utf8mb4'${MODEL_INPUT_VERSION}' COLLATE utf8mb4_unicode_ci
         ${category}
       GROUP BY zone_id, zone_key, zone_name, display_category ${displayGrouping}
       ORDER BY zone_id, display_category`,
      categoryValues
    );
    return {
      meta,
      data: {
        mode: "aggregate" as const,
        eligibleOnly: input.eligibleOnly,
        groups: rows.map((row) => ({
          zoneId: Number(row.zone_id), zoneKey: row.zone_key, zoneName: row.zone_name,
          category: row.display_category, categoryBasis: "here_primary_category",
          hereCategoryFilter: input.category ?? null, centerCount: Number(row.center_count),
          attractionWeight: Number(row.attraction_weight),
          longitude: Number(row.longitude), latitude: Number(row.latitude),
          modelEligible: Boolean(row.model_eligible), eligibilityReason: row.eligibility_reason,
          accessScope: row.access_scope, lastSeenAtUtc: toIsoUtc(row.last_seen_at_utc)
        }))
      }
    };
  }

  const [west, south, east, north] = input.bbox!;
  if (input.mode === "cluster") {
    // Deliberately coarser than map tiles: grouping also splits each cell by
    // model category, so a tile-sized grid would still approach raw-point
    // volume in dense Badung and Denpasar viewports.
    const cellSize = Math.max(0.0025, 360 / 2 ** ((input.zoom ?? 9) + 4));
    type Row = {
      grid_x: number; grid_y: number; display_category: string; model_eligible: number;
      center_count: number; attraction_weight: number; longitude: number; latitude: number;
    };
    const rows = await query<Row>(
      `SELECT FLOOR((longitude - ?) / ?) AS grid_x,
         FLOOR((latitude - ?) / ?) AS grid_y, ${HERE_DISPLAY_CATEGORY_SQL} AS display_category,
         ${input.eligibleOnly ? "1" : "model_eligible"} AS model_eligible,
         COUNT(*) AS center_count, ROUND(SUM(base_attraction_weight), 5) AS attraction_weight,
         AVG(longitude) AS longitude, AVG(latitude) AS latitude
       FROM api_activity_centers_v1
       WHERE active = 1 ${eligibility}
         AND model_input_version = _utf8mb4'${MODEL_INPUT_VERSION}' COLLATE utf8mb4_unicode_ci
         AND longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ? ${category}
       GROUP BY grid_x, grid_y, display_category, model_eligible
       ORDER BY attraction_weight DESC, grid_x, grid_y
       LIMIT ${input.limit + 1}`,
      [west, cellSize, south, cellSize, west, east, south, north, ...categoryValues]
    );
    const truncated = rows.length > input.limit;
    const selected = rows.slice(0, input.limit);
    const collection: FeatureCollection<Record<string, unknown>> = {
      type: "FeatureCollection",
      features: selected.map((row, index) => ({
        type: "Feature", id: `cluster-${row.grid_x}-${row.grid_y}-${row.display_category}-${index}`,
        geometry: { type: "Point", coordinates: [Number(row.longitude), Number(row.latitude)] },
        properties: {
          kind: "cluster", category: row.display_category, categoryBasis: "here_primary_category",
          hereCategoryFilter: input.category ?? null, centerCount: Number(row.center_count),
          attractionWeight: Number(row.attraction_weight), modelEligible: Boolean(row.model_eligible)
        }
      }))
    };
    return { meta: { ...meta, truncated }, data: { mode: "cluster" as const, ...collection, nextCursor: null, truncated } };
  }

  const cursor = decodeCursor(input.cursor);
  type PointRow = {
    activity_center_id: number; here_place_id: string; title: string; primary_category_name: string;
    model_category: string; base_attraction_weight: number; zone_key: string; zone_name: string;
    longitude: number; latitude: number; model_eligible: number; eligibility_reason: string | null;
    access_scope: string; last_seen_at_utc: string;
  };
  const cursorSql = cursor
    ? "AND (base_attraction_weight < ? OR (base_attraction_weight = ? AND activity_center_id > ?))"
    : "";
  const rows = await query<PointRow>(
    `SELECT activity_center_id, here_place_id, title, primary_category_name,
       model_category, base_attraction_weight, zone_key, zone_name, longitude, latitude,
       model_eligible, eligibility_reason, access_scope, last_seen_at_utc
     FROM api_activity_centers_v1
     WHERE active = 1 ${eligibility}
       AND model_input_version = _utf8mb4'${MODEL_INPUT_VERSION}' COLLATE utf8mb4_unicode_ci
       AND longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ? ${category} ${cursorSql}
     ORDER BY base_attraction_weight DESC, activity_center_id ASC
     LIMIT ${input.limit + 1}`,
    [
      west, east, south, north, ...categoryValues,
      ...(cursor ? [cursor.weight, cursor.weight, cursor.id] : [])
    ]
  );
  const truncated = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const last = selected.at(-1);
  const nextCursor = truncated && last
    ? encodeCursor({ weight: Number(last.base_attraction_weight), id: Number(last.activity_center_id) })
    : null;
  const collection: FeatureCollection<Record<string, unknown>> = {
    type: "FeatureCollection",
    features: selected.map((row) => ({
      type: "Feature", id: Number(row.activity_center_id),
      geometry: { type: "Point", coordinates: [Number(row.longitude), Number(row.latitude)] },
      properties: {
        kind: "place", herePlaceId: row.here_place_id, title: row.title,
        primaryCategory: row.primary_category_name,
        category: hereDisplayCategory(row.primary_category_name),
        categoryBasis: "here_primary_category", modelCategory: row.model_category,
        zoneKey: row.zone_key, zoneName: row.zone_name,
        modelAttractionWeight: Number(row.base_attraction_weight),
        modelEligible: Boolean(row.model_eligible), eligibilityReason: row.eligibility_reason,
        accessScope: row.access_scope, lastSeenAtUtc: toIsoUtc(row.last_seen_at_utc)
      }
    }))
  };
  return { meta: { ...meta, truncated }, data: { mode: "point" as const, ...collection, nextCursor, truncated } };
}
