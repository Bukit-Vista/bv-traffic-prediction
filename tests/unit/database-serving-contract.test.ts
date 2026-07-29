import { describe, expect, it } from "vitest";
import type { QueryRows } from "@/lib/db/mysql";
import {
  getAirportDestinations,
  getAirportRouteDefinitions,
  getAirportRouteSlots,
  getLatestAirportRouteMeasurements,
  getMobilityProductScope,
  getCollectorAlertStates,
  getCollectorRunHistory,
  getSourceStatuses
} from "@/lib/api/database-serving-contract";

describe("Step 1 database serving views", () => {
  it("maps the draft product scope without enabling predictions", async () => {
    const query: QueryRows = async (sql) => {
      expect(sql).toContain("api_mobility_scope_v1");
      return [{
        scope_id: 1, scope_key: "dps-to-selected-centers", scope_version: "v1", name: "Signals",
        description: "Relative signals", origin_key: "dps-airport", origin_label: "DPS Airport",
        origin_type: "airport_origin", prediction_interval_minutes: 30, storage_timezone: "UTC",
        display_timezone: "Asia/Makassar", output_unit: "relative_model_share",
        candidate_set_semantics: "Fixed registry", disclaimer: "Not people counts",
        freshness_policy_json: '{"flow":{"fresh_minutes":45}}',
        blocking_policy_json: { block_when_flow_expired: true }, feature_flag_key: "signals_enabled",
        prediction_enabled: 0, status: "draft", approved_by: null, approved_at_utc: null,
        updated_at_utc: "2026-07-19 06:29:47.161"
      }] as never;
    };
    const scope = await getMobilityProductScope(query);
    expect(scope).toMatchObject({
      scopeKey: "dps-to-selected-centers", status: "draft", predictionEnabled: false,
      freshnessPolicy: { flow: { fresh_minutes: 45 } }, blockingPolicy: { block_when_flow_expired: true }
    });
  });

  it("returns the ordered fixed destination registry and route definitions", async () => {
    const destinationQuery: QueryRows = async (sql) => {
      expect(sql).toContain("ORDER BY display_order");
      return [{
        scope_id: 1, scope_key: "scope", scope_version: "v1", scope_status: "draft", prediction_enabled: 0,
        destination_key: "canggu", destination_label: "Canggu", route_group_key: "dps-canggu",
        display_order: 1, active: 1
      }] as never;
    };
    const definitionQuery: QueryRows = async (sql) => {
      expect(sql).toContain("api_airport_tourism_routes_v1");
      return [{
        scope_key: "scope", scope_version: "v1", scope_status: "draft", prediction_enabled: 0,
        display_order: 1, route_id: 1, slug: "airport-to-canggu", route_purpose: "airport_tourism",
        route_group_key: "dps-canggu", tourism_center_key: "canggu", route_direction: "from_airport",
        origin_label: "DPS Airport", origin_lat: -8.7467, origin_lng: 115.1672,
        destination_label: "Canggu", destination_lat: -8.6503, destination_lng: 115.1386,
        category: "airport", active: 1
      }] as never;
    };
    expect((await getAirportDestinations(destinationQuery))[0]).toMatchObject({
      destinationKey: "canggu", displayOrder: 1, predictionEnabled: false
    });
    expect((await getAirportRouteDefinitions(definitionQuery))[0]).toMatchObject({
      routeId: 1, routeDirection: "from_airport", origin: { label: "DPS Airport" }
    });
  });

  it("maps nullable latest measurements and preserves negative route delays", async () => {
    const query: QueryRows = async (sql) => {
      expect(sql).toContain("api_airport_route_latest_v1");
      expect(sql).toContain("api_airport_tourism_routes_v1");
      return [{
        scope_key: "scope", scope_version: "v1", scope_status: "draft", prediction_enabled: 0,
        display_order: 1, route_id: 2, slug: "canggu-to-airport", route_group_key: "dps-canggu",
        tourism_center_key: "canggu", route_direction: "to_airport", origin_label: "Canggu",
        origin_lat: -8.65, origin_lng: 115.13, destination_label: "DPS Airport",
        destination_lat: -8.74, destination_lng: 115.16, route_sample_id: 91, ingestion_run_id: 8,
        route_purpose: "airport_tourism", category: "airport-tourism", active: 1,
        collection_slot_utc: "2026-07-19 13:00:00", sampled_at_utc: "2026-07-19 13:05:00",
        provider: "here", distance_meters: 17000, current_duration_seconds: 1900,
        typical_duration_seconds: 2000, base_duration_seconds: null, delay_vs_typical_seconds: -100,
        delay_vs_base_seconds: null, ratio_vs_typical: "0.95", ratio_vs_base: null,
        http_status: 200, slot_age_minutes: 20
      }] as never;
    };
    expect((await getLatestAirportRouteMeasurements(query))[0]).toMatchObject({
      delayVsTypicalSeconds: -100, ratioVsTypical: .95, baseDurationSeconds: null,
      geometryAvailable: true, status: "fresh"
    });
  });

  it("uses a prepared date range and validated integer limit for route slots", async () => {
    let captured: { sql: string; values: readonly unknown[] } | null = null;
    const query: QueryRows = async (sql, values = []) => {
      captured = { sql, values };
      return [{
        collection_slot_utc: "2026-07-19 13:00:00", observed_route_count: 14,
        successful_route_count: 14, unsuccessful_route_count: 0,
        first_sampled_at_utc: "2026-07-19 13:05:00", last_sampled_at_utc: "2026-07-19 13:06:00",
        minimum_ratio_vs_typical: ".95", maximum_ratio_vs_typical: "1.2", average_ratio_vs_typical: "1.05"
      }] as never;
    };
    const slots = await getAirportRouteSlots({
      from: "2026-07-18T13:00:00.000Z", to: "2026-07-19T13:00:00.000Z", limit: 50
    }, query);
    expect(captured).not.toBeNull();
    expect(captured!.sql).toContain("collection_slot_utc >= ? AND collection_slot_utc < ?");
    expect(captured!.sql).toContain("LIMIT 50");
    expect(captured!.sql).not.toContain("LIMIT ?");
    expect(slots[0]).toMatchObject({ observedRouteCount: 14, averageRatioVsTypical: 1.05 });
  });

  it("maps source health without exposing error payload contents", async () => {
    const query: QueryRows = async () => [{
      dataset: "flow", run_id: 188, run_token: "flow:slot", collection_slot_utc: "2026-07-19 13:30:00",
      status: "success", expected_count: 2, successful_count: 2, failed_count: 0, record_count: 3773,
      started_at_utc: "2026-07-19 13:30:00", finished_at_utc: "2026-07-19 13:30:33",
      slot_age_minutes: 26, error_json: '{"credential":"must-not-leak"}'
    }] as never;
    const status = (await getSourceStatuses(query))[0]!;
    expect(status).toMatchObject({ runId: "188", coverage: 1, errorPresent: true });
    expect(JSON.stringify(status)).not.toContain("must-not-leak");
  });

  it("maps the Step 3 collector alert and protected run-history contracts", async () => {
    const alertQuery: QueryRows = async (sql) => {
      expect(sql).toContain("api_collector_alert_state_v1");
      const flow = {
        dataset: "flow", run_id: 215, run_token: "token", collection_slot_utc: "2026-07-20 08:00:00",
        status: "partial", expected_count: 2, successful_count: 1, failed_count: 1, record_count: 2000,
        coverage_ratio: ".5", retry_count: 2, http_429_count: 1, started_at_utc: "2026-07-20 08:00:01",
        finished_at_utc: "2026-07-20 08:00:30", duration_seconds: "29", slot_age_minutes: 20,
        freshness_state: "fresh", health_state: "warning", alert_code: "FLOW_PARTIAL", is_stale: 0,
        is_partial: 1, is_failed: 0, is_running: 0, is_stuck: 0
      };
      return [flow, { ...flow, dataset: "routes", run_id: 99, expected_count: 14, successful_count: 14, failed_count: 0, coverage_ratio: 1, is_partial: 0 }] as never;
    };
    expect((await getCollectorAlertStates(alertQuery))[0]).toMatchObject({
      runId: "215", coverageRatio: .5, retryCount: 2, http429Count: 1, isPartial: true, healthState: "warning"
    });

    const historyQuery: QueryRows = async (sql, values) => {
      expect(sql).toContain("api_flow_run_history_v1");
      expect(sql).toContain("collection_slot_utc >= ? AND collection_slot_utc < ?");
      expect(sql).toContain("LIMIT 25");
      expect(values).toHaveLength(2);
      return [{
        dataset: "flow", run_id: 214, run_token: "token", collection_slot_utc: "2026-07-20 07:30:00",
        status: "success", expected_count: 2, successful_count: 2, failed_count: 0, coverage_ratio: 1,
        record_count: 3772, retry_count: 0, http_429_count: 0, attempt_count: 1,
        started_at_utc: "2026-07-20 07:30:01", finished_at_utc: "2026-07-20 07:30:20",
        duration_seconds: 19, slot_age_minutes: 50, is_running: 0, is_stuck: 0, has_error: 0, health_state: "healthy"
      }] as never;
    };
    expect((await getCollectorRunHistory("flow", {
      from: "2026-07-19T08:00:00.000Z", to: "2026-07-20T08:00:00.000Z", limit: 25
    }, historyQuery))[0]).toMatchObject({ id: 214, coverage: 1, healthState: "healthy", errorMessage: null });
  });
});
