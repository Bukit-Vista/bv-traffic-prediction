import { describe, expect, it } from "vitest";
import type { QueryRows } from "@/lib/db/mysql";
import { DISPLAY_GRID_DISCLAIMER, readDisplayGrid } from "@/lib/api/display-grid";
import { displayGridQuerySchema } from "@/lib/api/validation";

describe("display-only HERE Places grid", () => {
  it("clamps an overlapping pitched-camera bbox and rejects a remote bbox", () => {
    const parsed = displayGridQuerySchema.parse({
      bbox: "114.45900,-9.28140,115.93590,-7.47655",
      category: "beach",
      density: "fine"
    });
    expect(parsed).toMatchObject({
      bbox: [114.459, -9.2814, 115.9359, -7.55]
    });
    expect(parsed).not.toHaveProperty("density");
    expect(() => displayGridQuerySchema.parse({
      bbox: "100,-4,101,-3"
    })).toThrow("bbox must overlap the supported Bali viewport");
  });

  it("uses numeric bbox predicates, approved category mapping, and a validated limit", async () => {
    let captured: { sql: string; values: readonly unknown[] } | null = null;
    const query: QueryRows = async (sql, values = []) => {
      captured = { sql, values };
      return [{
        display_grid_build_id: 3, grid_version: "bali-places-display-grid-0p01deg-v1",
        place_import_run_id: 9, status: "success", source_status: "partial",
        source_coverage: "1", source_saturated_task_count: 2,
        source_completed_at_utc: "2026-07-23 02:55:40.408", built_at_utc: "2026-07-24 00:15:00.000",
        cell_id: 44, cell_key: "115.10:-8.70", minimum_longitude: "115.10",
        minimum_latitude: "-8.70", maximum_longitude: "115.11", maximum_latitude: "-8.69",
        center_longitude: "115.105", center_latitude: "-8.695", category_key: "__all__",
        active_place_count: 12, model_eligible_place_count: 8, raw_attraction_weight: "5.5",
        place_density_index: "62.5", attraction_index: "81.25",
        semantics: "source_derived_places_heatmap", disclaimer: DISPLAY_GRID_DISCLAIMER
      }] as never;
    };
    const result = await readDisplayGrid({
      bbox: [114.34, -8.9, 115.78, -8.03], metric: "attraction", category: "all", limit: 2000
    }, query);
    expect(captured!.sql).toContain("FROM api_mobility_display_grid_latest_v1");
    expect(captured!.sql).toContain("maximum_longitude >= ?");
    expect(captured!.sql).toContain("LIMIT 2000");
    expect(captured!.sql).not.toContain("LIMIT ?");
    expect(captured!.values).toEqual(["__all__", 114.34, 115.78, -8.9, -8.03]);
    expect(result.data.cells.features[0]).toMatchObject({
      geometry: { type: "Polygon" },
      properties: { relativeIndex: 81.25, activePlaceCount: 12 }
    });
    expect(result.meta).toMatchObject({
      displayGridBuildId: 3, sourceImportRunId: 9, status: "partial",
      sourceSaturatedTaskCount: 2, disclaimer: DISPLAY_GRID_DISCLAIMER
    });
  });

  it("selects the density index without changing stored attraction values", async () => {
    const query: QueryRows = async () => [{
      display_grid_build_id: 1, grid_version: "v1", place_import_run_id: 9,
      status: "success", source_status: "success", source_coverage: 1,
      source_saturated_task_count: 0, source_completed_at_utc: "2026-07-23 00:00:00",
      built_at_utc: "2026-07-24 00:00:00", cell_id: 1, cell_key: "cell",
      minimum_longitude: 115, minimum_latitude: -8.7, maximum_longitude: 115.01,
      maximum_latitude: -8.69, center_longitude: 115.005, center_latitude: -8.695,
      category_key: "dining", active_place_count: 3, model_eligible_place_count: 2,
      raw_attraction_weight: 1, place_density_index: 42, attraction_index: 77,
      semantics: "source_derived_places_heatmap", disclaimer: DISPLAY_GRID_DISCLAIMER
    }] as never;
    const result = await readDisplayGrid({
      bbox: [114.9, -8.8, 115.2, -8.5], metric: "placeDensity", category: "dining", limit: 20
    }, query);
    expect(result.data.cells.features[0]?.properties).toMatchObject({
      category: "dining", relativeIndex: 42, attractionIndex: 77
    });
  });

  it("recovers the latest completed display-grid build when the accepted view is empty", async () => {
    let recoveredValues: readonly unknown[] | undefined;
    const query: QueryRows = async (sql, values) => {
      if (sql.includes("api_mobility_display_grid_latest_v1")) return [] as never;
      if (sql.includes("JOIN mobility_display_grid_metrics")) {
        recoveredValues = values;
        return [{
          display_grid_build_id: 1,
          grid_version: "bali-places-display-grid-0p01deg-v1",
          place_import_run_id: 10, status: "partial", source_status: "partial",
          source_coverage: 1, source_saturated_task_count: 230,
          source_completed_at_utc: null, built_at_utc: "2026-07-23 17:40:42",
          cell_id: 101, cell_key: "114.50:-8.80",
          minimum_longitude: 114.5, minimum_latitude: -8.8,
          maximum_longitude: 114.51, maximum_latitude: -8.79,
          center_longitude: 114.505, center_latitude: -8.795,
          category_key: "__all__", active_place_count: 12,
          model_eligible_place_count: 10, raw_attraction_weight: 6,
          place_density_index: 70, attraction_index: 82,
          semantics: "source_derived_places_heatmap",
          disclaimer: DISPLAY_GRID_DISCLAIMER
        }, {
          display_grid_build_id: 1,
          grid_version: "bali-places-display-grid-0p01deg-v1",
          place_import_run_id: 10, status: "partial", source_status: "partial",
          source_coverage: 1, source_saturated_task_count: 230,
          source_completed_at_utc: null, built_at_utc: "2026-07-23 17:40:42",
          cell_id: 102, cell_key: "114.51:-8.80",
          minimum_longitude: 114.51, minimum_latitude: -8.8,
          maximum_longitude: 114.52, maximum_latitude: -8.79,
          center_longitude: 114.515, center_latitude: -8.795,
          category_key: "__all__", active_place_count: 8,
          model_eligible_place_count: 7, raw_attraction_weight: 4,
          place_density_index: 55, attraction_index: 64,
          semantics: "source_derived_places_heatmap",
          disclaimer: DISPLAY_GRID_DISCLAIMER
        }] as never;
      }
      if (sql.includes("api_mobility_display_grid_builds_v1")) {
        return [{
          display_grid_build_id: 1,
          grid_version: "bali-places-display-grid-0p01deg-v1",
          place_import_run_id: 10, status: "partial", source_status: "partial",
          source_coverage: 1, source_saturated_task_count: 230,
          source_completed_at_utc: null, built_at_utc: "2026-07-23 17:40:42"
        }] as never;
      }
      throw new Error(`Unexpected query: ${sql}`);
    };
    const result = await readDisplayGrid({
      bbox: [114.34, -8.9, 115.78, -8.03],
      metric: "attraction",
      category: "all",
      limit: 2000
    }, query);
    expect(result.data.cells.features).toHaveLength(2);
    expect(result.data.cells.features.map((feature) => feature.properties.cellKey))
      .toEqual(["114.50:-8.80", "114.51:-8.80"]);
    expect(recoveredValues).toEqual([
      DISPLAY_GRID_DISCLAIMER, 1, "__all__", 114.34, 115.78, -8.9, -8.03
    ]);
    expect(result.meta).toMatchObject({
      isFallback: true,
      gridVersion: "bali-places-display-grid-0p01deg-v1",
      sourceSaturatedTaskCount: 230,
      fallbackReason: "latest_accepted_view_empty_using_latest_completed_grid_build"
    });
  });

  it("recovers from an unavailable accepted view using the completed-build read model", async () => {
    const query: QueryRows = async (sql) => {
      if (sql.includes("api_mobility_display_grid_latest_v1")) {
        throw Object.assign(new Error("Accepted view is being refreshed."), {
          code: "ER_NO_SUCH_TABLE"
        });
      }
      if (sql.includes("JOIN mobility_display_grid_metrics")) {
        return [{
          display_grid_build_id: 7,
          grid_version: "bali-places-display-grid-0p01deg-v1",
          place_import_run_id: 12, status: "success", source_status: "success",
          source_coverage: 1, source_saturated_task_count: 0,
          source_completed_at_utc: "2026-07-27 07:00:00",
          built_at_utc: "2026-07-27 07:02:00",
          cell_id: 701, cell_key: "115.10:-8.70",
          minimum_longitude: 115.1, minimum_latitude: -8.7,
          maximum_longitude: 115.11, maximum_latitude: -8.69,
          center_longitude: 115.105, center_latitude: -8.695,
          category_key: "__all__", active_place_count: 9,
          model_eligible_place_count: 8, raw_attraction_weight: 4,
          place_density_index: 58, attraction_index: 73,
          semantics: "source_derived_places_heatmap",
          disclaimer: DISPLAY_GRID_DISCLAIMER
        }] as never;
      }
      if (sql.includes("api_mobility_display_grid_builds_v1")) {
        return [{
          display_grid_build_id: 7,
          grid_version: "bali-places-display-grid-0p01deg-v1",
          place_import_run_id: 12, status: "success", source_status: "success",
          source_coverage: 1, source_saturated_task_count: 0,
          source_completed_at_utc: "2026-07-27 07:00:00",
          built_at_utc: "2026-07-27 07:02:00"
        }] as never;
      }
      throw new Error(`Unexpected query: ${sql}`);
    };

    const result = await readDisplayGrid({
      bbox: [114.34, -8.9, 115.78, -8.03],
      metric: "attraction",
      category: "all",
      limit: 5000
    }, query);

    expect(result.data.cells.features).toHaveLength(1);
    expect(result.data.cells.features[0]?.properties).toMatchObject({
      cellKey: "115.10:-8.70",
      relativeIndex: 73
    });
    expect(result.meta).toMatchObject({
      isFallback: true,
      fallbackReason: "latest_accepted_view_unavailable_using_latest_completed_grid_build"
    });
  });
});
