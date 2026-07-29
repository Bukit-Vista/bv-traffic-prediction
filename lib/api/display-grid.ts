import { queryRows, type QueryRows } from "@/lib/db/mysql";
import { toIsoUtc } from "@/lib/db/mappers";
import { validatedSqlLimit, type Bbox } from "@/lib/api/spatial";
import type { ApiMeta, DisplayGridProperties, FeatureCollection } from "@/lib/dashboard/types";

export const DISPLAY_GRID_DISCLAIMER = "Source-derived HERE Places heatmap. It does not represent predicted movement, visits, people, vehicles, or trips.";

export type DisplayGridMetric = "attraction" | "placeDensity";
export type DisplayGridCategory =
  | "all" | "dining" | "accommodation" | "attraction" | "culture"
  | "beach" | "shopping" | "nightlife" | "recreation" | "transport";
type DisplayGridResult = {
  meta: Partial<ApiMeta> & {
    isFallback?: boolean;
    fallbackReason?: string | null;
    truncated: boolean;
  };
  data: {
    metric: DisplayGridMetric;
    category: DisplayGridCategory;
    cells: FeatureCollection<DisplayGridProperties>;
  };
};

type DisplayGridRow = {
  display_grid_build_id: number;
  grid_version: string;
  place_import_run_id: number;
  status: string;
  source_status: string;
  source_coverage: number | string | null;
  source_saturated_task_count: number;
  source_completed_at_utc: string | null;
  built_at_utc: string;
  cell_id: number;
  cell_key: string;
  minimum_longitude: number | string;
  minimum_latitude: number | string;
  maximum_longitude: number | string;
  maximum_latitude: number | string;
  center_longitude: number | string;
  center_latitude: number | string;
  category_key: string;
  active_place_count: number;
  model_eligible_place_count: number;
  raw_attraction_weight: number | string;
  place_density_index: number | string;
  attraction_index: number | string;
  semantics: string;
  disclaimer: string;
};

function metadata(row: DisplayGridRow): Partial<ApiMeta> {
  const sourceCompletedAtUtc = toIsoUtc(row.source_completed_at_utc) ??
    toIsoUtc(row.built_at_utc) ??
    new Date(0).toISOString();
  const ageMs = Date.now() - new Date(sourceCompletedAtUtc).getTime();
  return {
    displayGridBuildId: Number(row.display_grid_build_id),
    gridVersion: row.grid_version,
    sourceImportRunId: Number(row.place_import_run_id),
    sourceCompletedAtUtc,
    builtAtUtc: toIsoUtc(row.built_at_utc),
    sourceSaturatedTaskCount: Number(row.source_saturated_task_count),
    status: row.status === "success" && row.source_status === "success" ? "success" : "partial",
    coverage: row.source_coverage == null ? null : Number(row.source_coverage),
    semantics: "source_derived_places_heatmap",
    stale: ageMs > 45 * 24 * 60 * 60 * 1000,
    disclaimer: row.disclaimer || DISPLAY_GRID_DISCLAIMER
  };
}

type CompletedGridBuild = Pick<DisplayGridRow,
  "display_grid_build_id" | "grid_version" | "place_import_run_id" | "status" |
  "source_status" | "source_coverage" | "source_saturated_task_count" |
  "source_completed_at_utc" | "built_at_utc"
>;

export async function readDisplayGrid(input: {
  bbox: Bbox;
  metric: DisplayGridMetric;
  category: DisplayGridCategory;
  limit: number;
}, query: QueryRows = queryRows): Promise<DisplayGridResult> {
  const [west, south, east, north] = input.bbox;
  const limit = validatedSqlLimit(input.limit);
  const categoryKey = input.category === "all" ? "__all__" : input.category;
  let rows: DisplayGridRow[] = [];
  let acceptedViewError: unknown = null;
  try {
    rows = await query<DisplayGridRow>(
      `SELECT
         display_grid_build_id, grid_version, place_import_run_id, status,
         source_status, source_coverage, source_saturated_task_count,
         source_completed_at_utc, built_at_utc, cell_id, cell_key,
         minimum_longitude, minimum_latitude, maximum_longitude, maximum_latitude,
         center_longitude, center_latitude, category_key, active_place_count,
         model_eligible_place_count, raw_attraction_weight, place_density_index,
         attraction_index, semantics, disclaimer
       FROM api_mobility_display_grid_latest_v1
       WHERE category_key = ?
         AND maximum_longitude >= ?
         AND minimum_longitude <= ?
         AND maximum_latitude >= ?
         AND minimum_latitude <= ?
       ORDER BY attraction_index DESC, cell_id
       LIMIT ${limit}`,
      [categoryKey, west, east, south, north]
    );
  } catch (error) {
    // The accepted convenience view may be temporarily unavailable while its
    // definition is refreshed. The completed-build read model below is the
    // authoritative recovery path and uses the same stored grid rows.
    acceptedViewError = error;
  }

  let metaRow = rows[0];
  let recoveredCompletedBuild = false;
  if (!metaRow && !acceptedViewError) {
    try {
      metaRow = (await query<DisplayGridRow>(
        `SELECT display_grid_build_id, grid_version, place_import_run_id, status,
           source_status, source_coverage, source_saturated_task_count,
           source_completed_at_utc, built_at_utc, 0 AS cell_id, '' AS cell_key,
           0 AS minimum_longitude, 0 AS minimum_latitude, 0 AS maximum_longitude,
           0 AS maximum_latitude, 0 AS center_longitude, 0 AS center_latitude,
           '__all__' AS category_key, 0 AS active_place_count,
           0 AS model_eligible_place_count, 0 AS raw_attraction_weight,
           0 AS place_density_index, 0 AS attraction_index, semantics, disclaimer
         FROM api_mobility_display_grid_latest_v1
         ORDER BY source_completed_at_utc DESC, display_grid_build_id DESC LIMIT 1`
      ))[0];
    } catch (error) {
      acceptedViewError = error;
    }
  }
  if (!metaRow) {
    const build = (await query<CompletedGridBuild>(
      `SELECT display_grid_build_id, grid_version, place_import_run_id, status,
         source_status, source_coverage, source_saturated_task_count,
         source_completed_at_utc, completed_at_utc AS built_at_utc
       FROM api_mobility_display_grid_builds_v1
       WHERE status IN ('success', 'partial')
         AND completed_at_utc IS NOT NULL
         AND cell_count > 0
         AND metric_row_count > 0
       ORDER BY completed_at_utc DESC, display_grid_build_id DESC
       LIMIT 1`
    ))[0];
    if (build) {
      rows = await query<DisplayGridRow>(
        `SELECT
           b.display_grid_build_id, b.grid_version, b.place_import_run_id,
           b.status, b.source_status, b.source_coverage,
           b.source_saturated_task_count, b.source_completed_at_utc,
           b.completed_at_utc AS built_at_utc,
           c.id AS cell_id, c.cell_key, c.minimum_longitude,
           c.minimum_latitude, c.maximum_longitude, c.maximum_latitude,
           c.center_longitude, c.center_latitude, m.category_key,
           m.active_place_count, m.model_eligible_place_count,
           m.raw_attraction_weight, m.place_density_index,
           m.attraction_index, 'source_derived_places_heatmap' AS semantics,
           ? AS disclaimer
         FROM api_mobility_display_grid_builds_v1 b
         JOIN mobility_display_grid_metrics m
           ON m.build_id = b.display_grid_build_id
         JOIN mobility_display_grid_cells c
           ON c.id = m.cell_id AND c.active = 1
         WHERE b.display_grid_build_id = ?
           AND m.category_key = ?
           AND c.maximum_longitude >= ?
           AND c.minimum_longitude <= ?
           AND c.maximum_latitude >= ?
           AND c.minimum_latitude <= ?
         ORDER BY m.attraction_index DESC, c.id
         LIMIT ${limit}`,
        [
          DISPLAY_GRID_DISCLAIMER,
          build.display_grid_build_id,
          categoryKey,
          west,
          east,
          south,
          north
        ]
      );
      metaRow = rows[0] ?? {
        ...build,
        cell_id: 0,
        cell_key: "",
        minimum_longitude: 0,
        minimum_latitude: 0,
        maximum_longitude: 0,
        maximum_latitude: 0,
        center_longitude: 0,
        center_latitude: 0,
        category_key: categoryKey,
        active_place_count: 0,
        model_eligible_place_count: 0,
        raw_attraction_weight: 0,
        place_density_index: 0,
        attraction_index: 0,
        semantics: "source_derived_places_heatmap",
        disclaimer: DISPLAY_GRID_DISCLAIMER
      };
      recoveredCompletedBuild = true;
    }
  }
  if (!metaRow && acceptedViewError) throw acceptedViewError;
  if (!metaRow) throw new RangeError("No completed display-grid build is available.");

  const collection: FeatureCollection<DisplayGridProperties> = {
    type: "FeatureCollection",
    features: rows.map((row) => {
      const minLng = Number(row.minimum_longitude);
      const minLat = Number(row.minimum_latitude);
      const maxLng = Number(row.maximum_longitude);
      const maxLat = Number(row.maximum_latitude);
      const attractionIndex = Number(row.attraction_index);
      const placeDensityIndex = Number(row.place_density_index);
      return {
        type: "Feature",
        id: Number(row.cell_id),
        geometry: {
          type: "Polygon",
          coordinates: [[
            [minLng, minLat], [maxLng, minLat], [maxLng, maxLat],
            [minLng, maxLat], [minLng, minLat]
          ]]
        },
        properties: {
          cellId: Number(row.cell_id),
          cellKey: row.cell_key,
          category: input.category,
          relativeIndex: input.metric === "attraction" ? attractionIndex : placeDensityIndex,
          attractionIndex,
          placeDensityIndex,
          activePlaceCount: Number(row.active_place_count),
          modelEligiblePlaceCount: Number(row.model_eligible_place_count),
          rawAttractionWeight: Number(row.raw_attraction_weight),
          centerLongitude: Number(row.center_longitude),
          centerLatitude: Number(row.center_latitude)
        }
      };
    })
  };
  return {
    meta: {
      ...metadata(metaRow),
      isFallback: recoveredCompletedBuild,
      fallbackReason: recoveredCompletedBuild
        ? acceptedViewError
          ? "latest_accepted_view_unavailable_using_latest_completed_grid_build"
          : "latest_accepted_view_empty_using_latest_completed_grid_build"
        : null,
      truncated: rows.length === limit
    },
    data: { metric: input.metric, category: input.category, cells: collection }
  };
}
