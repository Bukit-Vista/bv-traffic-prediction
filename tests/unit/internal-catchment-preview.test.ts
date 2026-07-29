import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATCHMENT_DISCLAIMER,
  catchmentPreviewFlagEnabled,
  catchmentPublicFlagEnabled,
  clearCatchmentPreviewCachesForTests,
  readCatchmentCenters,
  readCatchmentFlows,
  readCatchmentOverview,
  readCatchmentZones,
  validateCatchmentFlowFilters
} from "@/lib/api/internal-catchment-preview";
import type { QueryRows } from "@/lib/db/mysql";

const latestRun = {
  model_run_id: 153,
  flow_run_id: 515,
  model_version: "gravity-here-v2",
  prediction_for_utc: "2026-07-26 08:30:00",
  completed_at_utc: "2026-07-26 08:45:00",
  status: "success",
  model_active: 1,
  zone_count: 21,
  od_count: 420,
  input_coverage: 0.979381,
  freshness_seconds: 900,
  semantics: "predicted_relative_mobility",
  disclaimer: CATCHMENT_DISCLAIMER,
  feature_flag_key: "mobility_catchment_shadow_ui_enabled",
  internal_preview_enabled: 1,
  public_serving_enabled: 0,
  error_json: null
};

function zoneRows() {
  return Array.from({ length: 22 }, (_, index) => {
    const displayOnly = index === 21;
    return {
      model_run_id: 153,
      prediction_for_utc: "2026-07-26 08:30:00",
      display_order: index + 1,
      zone_id: index + 1,
      catchment_key: displayOnly ? "nusa-penida-display" : `modeled-${index + 1}`,
      name: displayOnly ? "Nusa Penida" : `Modeled ${index + 1}`,
      model_eligible: displayOnly ? 0 : 1,
      display_only: displayOnly ? 1 : 0,
      matrix_status: displayOnly ? "unavailable" : "available",
      matrix_coverage_scope: displayOnly ? null : "modeled",
      matrix_excluded_area_label: displayOnly ? "Nusa Penida" : null,
      has_prediction: displayOnly ? 0 : 1,
      presence_score: displayOnly ? null : 50 + index,
      inbound_score: displayOnly ? null : 40 + index,
      outbound_score: displayOnly ? null : 30 + index,
      hotspot_rank: displayOnly ? null : index + 1,
      confidence: displayOnly ? null : 0.9,
      longitude: 115.1 + index / 100,
      latitude: -8.7 + index / 100,
      geometry_geojson: JSON.stringify({
        type: "Polygon",
        coordinates: [[[115, -8], [115.1, -8], [115.1, -8.1], [115, -8]]]
      })
    };
  });
}

function previewQuery(): QueryRows {
  return (async <T extends object>(sql: string) => {
    if (sql.includes("latest_run_v1")) return [latestRun] as T[];
    if (sql.includes("catchments_v1")) return zoneRows() as T[];
    throw new Error(`Unexpected query: ${sql}`);
  }) as QueryRows;
}

function completeFlowRows() {
  const rows: Array<Record<string, unknown>> = [];
  for (let origin = 1; origin <= 21; origin += 1) {
    for (let destination = 1; destination <= 21; destination += 1) {
      if (origin === destination) continue;
      rows.push({
        model_run_id: 153,
        prediction_for_utc: "2026-07-26 08:30:00",
        origin_display_order: origin,
        destination_display_order: destination,
        origin_zone_id: origin,
        origin_catchment_key: `modeled-${origin}`,
        origin_name: `Modeled ${origin}`,
        origin_longitude: 115 + origin / 100,
        origin_latitude: -8.8 + origin / 100,
        destination_zone_id: destination,
        destination_catchment_key: `modeled-${destination}`,
        destination_name: `Modeled ${destination}`,
        destination_longitude: 115 + destination / 100,
        destination_latitude: -8.8 + destination / 100,
        mobility_score: 50,
        predicted_share: 0.05,
        duration_seconds: 600,
        distance_meters: 10_000,
        confidence: 0.9,
        semantics: "predicted_relative_mobility",
        disclaimer: CATCHMENT_DISCLAIMER,
        feature_flag_key: "mobility_catchment_shadow_ui_enabled",
        internal_preview_enabled: 1,
        public_serving_enabled: 0
      });
    }
  }
  return rows;
}

afterEach(() => {
  clearCatchmentPreviewCachesForTests();
  vi.restoreAllMocks();
});

describe("Step 09F internal catchment preview", () => {
  it("defaults the server-owned feature flag off", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(catchmentPreviewFlagEnabled({}, false)).toBe(false);
    expect(catchmentPreviewFlagEnabled({ MOBILITY_CATCHMENT_SHADOW_UI_ENABLED: "true" }, false)).toBe(true);
    expect(catchmentPublicFlagEnabled({}, false)).toBe(false);
    expect(catchmentPublicFlagEnabled({ MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED: "true" }, false)).toBe(true);
  });

  it("requires the independent database public-serving contract for public v2 reads", async () => {
    const publicLatest = {
      ...latestRun,
      internal_preview_enabled: 1,
      public_serving_enabled: 1
    };
    const query = (async <T extends object>(sql: string) => {
      if (sql.includes("latest_run_v1")) return [publicLatest] as T[];
      if (sql.includes("catchments_v1")) return zoneRows() as T[];
      throw new Error(`Unexpected query: ${sql}`);
    }) as QueryRows;
    const result = await readCatchmentZones(query, "public");
    expect(result.meta).toMatchObject({
      modelVersion: "gravity-here-v2",
      featureFlagKey: "mobility_catchment_v2_public_enabled",
      servingMode: "public",
      publicServing: true,
      internalPreview: true,
      inputCoverage: 0.979381
    });
  });

  it("fails public v2 reads closed when coverage or database readiness is ineligible", async () => {
    const queryFor = (overrides: Record<string, unknown>) => (async <T extends object>(sql: string) => {
      if (sql.includes("latest_run_v1")) {
        return [{ ...latestRun, public_serving_enabled: 1, ...overrides }] as T[];
      }
      return zoneRows() as T[];
    }) as QueryRows;
    await expect(readCatchmentZones(queryFor({ input_coverage: 0.89999 }), "public"))
      .rejects.toThrow("public serving contract");
    await expect(readCatchmentZones(queryFor({ model_active: 0 }), "public"))
      .rejects.toThrow("public serving contract");
    await expect(readCatchmentZones(queryFor({ error_json: { message: "failed" } }), "public"))
      .rejects.toThrow("public serving contract");
    await expect(readCatchmentZones(queryFor({ public_serving_enabled: 0 }), "public"))
      .rejects.toThrow("public serving contract");
  });

  it("serializes all 22 polygons while preserving Nusa Penida nulls", async () => {
    const result = await readCatchmentZones(previewQuery());
    expect(result.collection.features).toHaveLength(22);
    const nusa = result.collection.features.find((feature) => feature.properties.catchmentKey === "nusa-penida-display");
    expect(nusa?.properties).toMatchObject({
      modelEligible: false,
      displayOnly: true,
      hasPrediction: false,
      presenceScore: null,
      inboundScore: null,
      outboundScore: null,
      hotspotRank: null,
      confidence: null
    });
    expect(JSON.stringify(nusa)).not.toContain("attractionScore");
    expect(result.meta).toMatchObject({
      modelRunId: 153,
      flowRunId: 515,
      sourceRunId: 515,
      modelVersion: "gravity-here-v2",
      stale: false,
      publicServing: false,
      internalPreview: true
    });
  });

  it("derives the approved overview counts from the zone view", async () => {
    const result = await readCatchmentOverview(previewQuery());
    expect(result.data).toEqual({
      displayedCatchmentCount: 22,
      modeledCatchmentCount: 21,
      displayOnlyCatchmentCount: 1,
      odPairCount: 420,
      availableMetrics: ["presence", "inbound", "outbound"],
      displayOnlyCatchmentKeys: ["nusa-penida-display"]
    });
  });

  it("defaults to the complete directed matrix and bounds optional presentation filters", () => {
    expect(validateCatchmentFlowFilters({})).toEqual({ origin: null, destination: null, minScore: 0, limit: 420 });
    expect(validateCatchmentFlowFilters({ origin: "modeled-1" })).toEqual({
      origin: "modeled-1", destination: null, minScore: 0, limit: 20
    });
    expect(validateCatchmentFlowFilters({ destination: "modeled-1" })).toEqual({
      origin: null, destination: "modeled-1", minScore: 0, limit: 20
    });
    expect(() => validateCatchmentFlowFilters({ minScore: Number.NaN })).toThrow("finite");
    expect(() => validateCatchmentFlowFilters({ minScore: 101 })).toThrow("between 0 and 100");
    expect(() => validateCatchmentFlowFilters({ limit: 421 })).toThrow("between 1 and 420");
  });

  it("accepts the complete 21 × 20 directed flow contract with reconciled shares", async () => {
    let flowValues: readonly unknown[] | undefined;
    let flowSql = "";
    const query = (async <T extends object>(sql: string, values?: readonly unknown[]) => {
      if (sql.includes("latest_run_v1")) return [latestRun] as T[];
      if (sql.includes("catchments_v1")) return zoneRows() as T[];
      if (sql.includes("catchment_flows_v1")) {
        flowSql = sql;
        flowValues = values;
        return completeFlowRows() as T[];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }) as QueryRows;
    const result = await readCatchmentFlows({ minScore: 0, limit: 420 }, query);
    expect(result.flows).toHaveLength(420);
    expect(new Set(result.flows.map((flow) => flow.originCatchmentKey)).size).toBe(21);
    expect(result.flows.some((flow) => flow.originZoneId === flow.destinationZoneId)).toBe(false);
    expect(result.flows.some((flow) =>
      flow.originCatchmentKey === "nusa-penida-display" ||
      flow.destinationCatchmentKey === "nusa-penida-display"
    )).toBe(false);
    expect(flowValues).toEqual([null, null, null, null, 0, "420"]);
    expect(flowSql).not.toContain("model_run_id =");
    expect(result.meta).toMatchObject({
      predictionForUtc: "2026-07-26T08:30:00.000Z",
      inputCoverage: 0.979381,
      semantics: "predicted_relative_mobility",
      disclaimer: CATCHMENT_DISCLAIMER
    });
    expect(result.flows[0]).toMatchObject({
      predictionForUtc: "2026-07-26T08:30:00.000Z",
      semantics: "predicted_relative_mobility",
      disclaimer: CATCHMENT_DISCLAIMER
    });
  });

  it("preserves two asymmetric reverse records as opposite directed features", async () => {
    const asymmetricZones = zoneRows().map((row, index) => index === 0
      ? { ...row, catchment_key: "dps-airport-gateway", name: "DPS Airport Gateway" }
      : index === 1
        ? { ...row, catchment_key: "denpasar-urban", name: "Denpasar Urban" }
        : row);
    const asymmetricRows = [
      {
        ...completeFlowRows()[0],
        origin_zone_id: 1,
        origin_catchment_key: "dps-airport-gateway",
        origin_name: "DPS Airport Gateway",
        origin_longitude: 115.16,
        origin_latitude: -8.74,
        destination_zone_id: 2,
        destination_catchment_key: "denpasar-urban",
        destination_name: "Denpasar Urban",
        destination_longitude: 115.22,
        destination_latitude: -8.67,
        mobility_score: 51.66,
        predicted_share: 0.32
      },
      {
        ...completeFlowRows()[1],
        origin_zone_id: 2,
        origin_catchment_key: "denpasar-urban",
        origin_name: "Denpasar Urban",
        origin_longitude: 115.22,
        origin_latitude: -8.67,
        destination_zone_id: 1,
        destination_catchment_key: "dps-airport-gateway",
        destination_name: "DPS Airport Gateway",
        destination_longitude: 115.16,
        destination_latitude: -8.74,
        mobility_score: 7.25,
        predicted_share: 0.04
      }
    ];
    const query = (async <T extends object>(sql: string) => {
      if (sql.includes("latest_run_v1")) return [latestRun] as T[];
      if (sql.includes("catchments_v1")) return asymmetricZones as T[];
      if (sql.includes("catchment_flows_v1")) return asymmetricRows as T[];
      throw new Error(`Unexpected query: ${sql}`);
    }) as QueryRows;
    const result = await readCatchmentFlows({ minScore: 0, limit: 2 }, query);
    expect(result.collection.features).toHaveLength(2);
    expect(result.collection.features[0]).toMatchObject({
      geometry: {
        type: "LineString",
        coordinates: [[115.16, -8.74], [115.22, -8.67]]
      },
      properties: {
        originName: "DPS Airport Gateway",
        destinationName: "Denpasar Urban",
        mobilityScore: 51.66
      }
    });
    expect(result.collection.features[1]).toMatchObject({
      geometry: {
        type: "LineString",
        coordinates: [[115.22, -8.67], [115.16, -8.74]]
      },
      properties: {
        originName: "Denpasar Urban",
        destinationName: "DPS Airport Gateway",
        mobilityScore: 7.25
      }
    });
  });

  it("filters all 20 inbound pairs by destination catchment", async () => {
    let flowValues: readonly unknown[] | undefined;
    const query = (async <T extends object>(sql: string, values?: readonly unknown[]) => {
      if (sql.includes("latest_run_v1")) return [latestRun] as T[];
      if (sql.includes("catchments_v1")) return zoneRows() as T[];
      if (sql.includes("catchment_flows_v1")) {
        flowValues = values;
        return completeFlowRows().filter((row) =>
          row.destination_catchment_key === "modeled-1"
        ) as T[];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }) as QueryRows;
    const result = await readCatchmentFlows({
      destination: "modeled-1",
      minScore: 0,
      limit: 20
    }, query);
    expect(result.flows).toHaveLength(20);
    expect(result.flows.every((flow) => flow.destinationCatchmentKey === "modeled-1")).toBe(true);
    expect(result.destinationCatchmentKey).toBe("modeled-1");
    expect(flowValues).toEqual([null, null, "modeled-1", "modeled-1", 0, "20"]);
  });

  it("accepts aggregated center coverage for all 21 modeled catchments", async () => {
    const query = (async <T extends object>(sql: string) => {
      if (sql.includes("latest_run_v1")) return [latestRun] as T[];
      if (sql.includes("center_summary_v1")) {
        return Array.from({ length: 21 }, (_, index) => ({
          display_order: index + 1,
          zone_id: index + 1,
          catchment_key: `modeled-${index + 1}`,
          name: `Modeled ${index + 1}`,
          model_category: "attraction",
          center_count: 2,
          base_attraction_weight: 1.5,
          mean_longitude: 115 + index / 100,
          mean_latitude: -8.8 + index / 100
        })) as T[];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }) as QueryRows;
    const result = await readCatchmentCenters(null, query);
    expect(new Set(result.summaries.map((summary) => summary.catchmentKey)).size).toBe(21);
    expect(result.summaries.every((summary) => summary.source === "aggregated_activity_center_context")).toBe(true);
  });

  it("fails closed when the latest-run view is not successful", async () => {
    const query = (async <T extends object>(sql: string) => {
      if (sql.includes("latest_run_v1")) return [{ ...latestRun, status: "partial" }] as T[];
      return [] as T[];
    }) as QueryRows;
    await expect(readCatchmentZones(query)).rejects.toThrow("preview serving contract");
  });
});
