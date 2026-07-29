import { describe, expect, it } from "vitest";
import { getMobilityPredictionReadiness, requireMobilityPredictionReady } from "@/lib/api/mobility-readiness";
import type { QueryRows } from "@/lib/db/mysql";

function scopeRow(overrides: Record<string, unknown> = {}) {
  return {
    scope_id: 1, scope_key: "dps-to-selected-centers", scope_version: "v1", name: "Relative mobility",
    description: "Model-derived destination likelihood", origin_key: "dps-airport", origin_label: "DPS Airport",
    origin_type: "airport_origin", prediction_interval_minutes: 30, storage_timezone: "UTC",
    display_timezone: "Asia/Makassar", output_unit: "relative_model_share",
    candidate_set_semantics: "reviewed zones", disclaimer: "Not an observed people count.",
    freshness_policy_json: {}, blocking_policy_json: {}, feature_flag_key: "predicted_mobility",
    prediction_enabled: 0, status: "draft", approved_by: null, approved_at_utc: null,
    updated_at_utc: "2026-07-21 01:00:00",
    ...overrides
  };
}

describe("predicted mobility readiness gate", () => {
  it("opens the workspace but blocks production output when model inputs are empty", async () => {
    const query: QueryRows = async (sql) => {
      if (sql.includes("api_mobility_scope_v1")) return [scopeRow()] as never;
      if (sql.includes("SELECT r.id")) return [] as never;
      return [{ active_zones: 0, activity_centers: 0, zone_road_mappings: 0, zone_predictions: 0, od_predictions: 0 }] as never;
    };
    const readiness = await getMobilityPredictionReadiness(query, new Date("2026-07-21T02:00:00.000Z"));
    expect(readiness).toMatchObject({ workspaceEnabled: true, ready: false, status: "blocked" });
    expect(readiness.missing).toEqual(expect.arrayContaining([
      "scope_not_approved", "prediction_disabled", "active_zones_missing", "activity_centers_missing",
      "zone_road_mappings_missing", "successful_model_run_missing", "zone_predictions_missing", "od_predictions_missing"
    ]));
    await expect(requireMobilityPredictionReady(query)).rejects.toMatchObject({ name: "FeatureNotReadyError", feature: "predicted_mobility" });
  });

  it("serves production predictions only after every gate passes", async () => {
    const query: QueryRows = async (sql) => {
      if (sql.includes("api_mobility_scope_v1")) return [scopeRow({ prediction_enabled: 1, status: "approved", approved_by: "product-owner", approved_at_utc: "2026-07-21 01:30:00" })] as never;
      if (sql.includes("SELECT r.id")) return [{
        id: 84, prediction_for_utc: "2026-07-21 02:00:00", status: "success",
        input_coverage: ".92", version: "gravity-v1", model_active: 1
      }] as never;
      expect(sql).toContain("SELECT id FROM mobility_model_runs");
      return [{ active_zones: 120, activity_centers: 48, zone_road_mappings: 3100, zone_predictions: 120, od_predictions: 460 }] as never;
    };
    const readiness = await getMobilityPredictionReadiness(query, new Date("2026-07-21T02:05:00.000Z"));
    expect(readiness).toMatchObject({
      ready: true, status: "ready", missing: [],
      latestModelRun: { id: "84", predictionForUtc: "2026-07-21T02:00:00.000Z", modelVersion: "gravity-v1", inputCoverage: .92 },
      counts: { activeZones: 120, activityCenters: 48, zoneRoadMappings: 3100, zonePredictions: 120, odPredictions: 460 }
    });
  });
});
