import { describe, expect, it } from "vitest";
import { bboxToWkt, isBaliViewport, validatedSqlLimit } from "@/lib/api/spatial";
import { getFlowMap, getRouteGeometry, getRouteHistory, getRouteResourceIdentity, getRoutes, resolveFlowResource } from "@/lib/api/data-source";
import { makeMeta } from "@/lib/api/response";
import type { QueryRows } from "@/lib/db/mysql";

const flowRun = {
  id: 51, run_token: "run", claim_token: "claim", collection_slot_utc: "2026-07-16 17:00:00",
  started_at_utc: "2026-07-16 17:00:01", finished_at_utc: "2026-07-16 17:00:09",
  status: "success", attempt_count: 1, area_expected_count: 2, area_success_count: 2,
  segment_count: 1, observation_count: 1, error_json: null
};

describe("HERE production cutover", () => {
  it("builds a closed WGS84 viewport polygon and validates Bali query bounds", () => {
    expect(bboxToWkt([114.34, -8.9, 115.78, -8.03])).toBe(
      "POLYGON((114.34 -8.9,115.78 -8.9,115.78 -8.03,114.34 -8.03,114.34 -8.9))"
    );
    expect(isBaliViewport([114.34, -8.9, 115.78, -8.03])).toBe(true);
    expect(isBaliViewport([110, -10, 120, -6])).toBe(false);
  });

  it("only permits bounded integer SQL limits", () => {
    expect(validatedSqlLimit(5000)).toBe(5000);
    expect(() => validatedSqlLimit(1.5)).toThrow();
    expect(() => validatedSqlLimit(5001)).toThrow();
  });

  it("maps complete source metadata and retains selectedSlot as an alias", () => {
    expect(makeMeta({ slotUtc: "2026-07-16T17:00:00.000Z", sourceRunId: "51", status: "partial", stale: true, coverage: .5, semantics: "measured_traffic" })).toMatchObject({
      selectedSlot: "2026-07-16T17:00:00.000Z", slotUtc: "2026-07-16T17:00:00.000Z", sourceRunId: "51",
      status: "partial", stale: true, coverage: .5, semantics: "measured_traffic"
    });
  });

  it("uses exact collection slots, prepared WKT intersection, interpolated limits, and preserves null Flow measurements", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const query: QueryRows = async (sql, values = []) => {
      calls.push({ sql, values });
      if (sql.includes("WHERE collection_slot_utc = ?") && sql.includes("traffic_flow_collection_runs")) return [flowRun] as never;
      if (sql.includes("ORDER BY collection_slot_utc DESC, id DESC LIMIT 1") && sql.includes("traffic_flow_collection_runs")) return [flowRun] as never;
      if (sql.includes("FROM traffic_road_segments")) return [{
        segment_id: 1, segment_key: "segment", road_name: null, functional_class: null, length_meters: 120,
        geometry_json: '{"type":"LineString","coordinates":[[115,-8.5],[115.1,-8.5]]}',
        collection_slot_utc: "2026-07-16 17:00:00", source_updated_utc: null,
        fetched_at_utc: "2026-07-16 17:00:08", observed_at_utc: "2026-07-16 17:00:00",
        speed_kph: null, free_flow_kph: null, relative_speed: null, jam_factor: null,
        jam_tendency: null, confidence: null, traversability: null, road_closure: 0
      }] as never;
      return [] as never;
    };
    const result = await getFlowMap({ bbox: [114.34, -8.9, 115.78, -8.03], at: "2026-07-16T17:00:00.000Z", limit: 25, minConfidence: 0 }, query);
    const mapCall = calls.find((call) => call.sql.includes("FROM traffic_road_segments"))!;
    expect(mapCall.sql).toContain("ST_GeomFromText(?, 4326, 'axis-order=long-lat')");
    expect(mapCall.sql).toContain("MBRIntersects");
    expect(mapCall.sql).toContain("ST_Intersects");
    expect(mapCall.sql).toContain("LIMIT 26");
    expect(mapCall.sql).not.toContain("LIMIT ?");
    expect(mapCall.values[0]).toBe(bboxToWkt([114.34, -8.9, 115.78, -8.03]));
    expect(result.collection.features[0]?.properties).toMatchObject({ speedKph: null, jamFactor: null, sourceUpdatedUtc: null });
  });

  it("reuses a resolved Flow version instead of repeating run lookups before the spatial query", async () => {
    const calls: string[] = [];
    const query: QueryRows = async (sql) => {
      calls.push(sql);
      if (sql.includes("traffic_flow_collection_runs")) return [flowRun] as never;
      if (sql.includes("FROM traffic_road_segments")) return [] as never;
      return [] as never;
    };
    const resolved = await resolveFlowResource("latest", query);
    const runQueries = calls.filter((sql) => sql.includes("traffic_flow_collection_runs")).length;
    await getFlowMap({ bbox: [114.34, -8.9, 115.78, -8.03], at: "latest", limit: 25, minConfidence: 0 }, query, resolved);
    expect(calls.filter((sql) => sql.includes("traffic_flow_collection_runs"))).toHaveLength(runQueries);
    expect(calls.some((sql) => sql.includes("FROM api_traffic_flow_latest_v1"))).toBe(true);
  });

  it("selects each route independently, avoids geometry join duplicates, and preserves negative delays", async () => {
    const query: QueryRows = async (sql) => {
      expect(sql).toContain("SELECT rs2.id FROM route_samples rs2");
      expect(sql).toContain("rs2.collection_slot_utc DESC");
      expect(sql).toContain("EXISTS(SELECT 1 FROM route_sample_geometries");
      expect(sql).not.toContain("LEFT JOIN route_sample_geometries");
      expect(sql).toContain("r.route_purpose = 'airport_tourism'");
      return [{
        id: 2, slug: "canggu-airport", origin_label: "Canggu", destination_label: "DPS Airport", category: "airport",
        route_purpose: "airport_tourism", route_group_key: "dps-canggu", tourism_center_key: "canggu", route_direction: "to_airport",
        distance_meters: 17000, current_duration_seconds: 1900, typical_duration_seconds: 2000,
        base_duration_seconds: null, delay_vs_typical_seconds: -100, delay_vs_base_seconds: null,
        ratio_vs_typical: .95, ratio_vs_base: null, collection_slot_utc: "2026-07-16 17:00:00",
        sampled_at_utc: "2026-07-16 17:05:00", provider: "here", geometry_available: 1
      }] as never;
    };
    const routes = await getRoutes("2026-07-16T17:00:00.000Z", query);
    expect(routes[0]).toMatchObject({ delayVsTypicalSeconds: -100, ratioVsTypical: .95, baseDurationSeconds: null, geometryAvailable: true });
  });

  it("builds a lightweight Route version identity from definitions, samples, measurements, and geometry", async () => {
    const query: QueryRows = async (sql) => {
      expect(sql).toContain("rs.current_duration_seconds");
      expect(sql).toContain("route_sample_geometries");
      return [{
        id: 2, slug: "canggu-airport", origin_label: "Canggu", destination_label: "DPS Airport", category: "airport",
        route_purpose: "airport_tourism", route_group_key: "dps-canggu", tourism_center_key: "canggu", route_direction: "to_airport",
        sample_id: 91, collection_slot_utc: "2026-07-16 17:00:00", sampled_at_utc: "2026-07-16 17:05:00",
        current_duration_seconds: 1900, typical_duration_seconds: 2000, base_duration_seconds: 1800,
        delay_vs_typical_seconds: -100, ratio_vs_typical: .95, geometry_count: 2
      }] as never;
    };
    const identity = await getRouteResourceIdentity("latest", query);
    expect(identity.routes[0]).toMatchObject({ sampleId: 91, currentDurationSeconds: 1900, ratioVsTypical: .95, geometryCount: 2 });
  });

  it("returns every HERE geometry section in section_index order", async () => {
    const query: QueryRows = async (sql) => {
      if (sql.includes("api_airport_tourism_routes_v1")) return [{
        scope_key: "scope", scope_version: "v1", scope_status: "approved", prediction_enabled: 0, display_order: 1,
        route_id: 2, slug: "canggu-airport", origin_label: "Canggu", origin_lat: -8.6, origin_lng: 115.1,
        destination_label: "DPS Airport", destination_lat: -8.7, destination_lng: 115.16, category: "airport",
        route_purpose: "airport_tourism", route_group_key: "dps-canggu", tourism_center_key: "canggu",
        route_direction: "to_airport", active: 1
      }] as never;
      if (sql.includes("api_airport_route_geometry_v1")) {
        expect(sql).toContain("ORDER BY section_index ASC");
        return [
          { route_sample_id: 9, collection_slot_utc: "2026-07-16 17:00:00", section_index: 0, geometry_geojson: '{"type":"LineString","coordinates":[[115,-8.5],[115.1,-8.5]]}' },
          { route_sample_id: 9, collection_slot_utc: "2026-07-16 17:00:00", section_index: 1, geometry_geojson: '{"type":"LineString","coordinates":[[115.1,-8.5],[115.2,-8.6]]}' }
        ] as never;
      }
      if (sql.includes("JOIN route_samples s")) {
        expect(sql).toContain("EXISTS (SELECT 1 FROM route_sample_geometries");
        expect(sql).not.toContain("? IS NULL");
        return [{
        id: 2, slug: "canggu-airport", origin_label: "Canggu", destination_label: "DPS Airport", category: "airport",
        route_purpose: "airport_tourism", route_group_key: "dps-canggu", tourism_center_key: "canggu", route_direction: "to_airport",
        sample_id: 9, ingestion_run_id: 3, collection_slot_utc: "2026-07-16 17:00:00", sampled_at_utc: "2026-07-16 17:05:00"
        }] as never;
      }
      expect(sql).toContain("ORDER BY section_index ASC");
      return [
        { section_index: 0, geometry_json: '{"type":"LineString","coordinates":[[115,-8.5],[115.1,-8.5]]}' },
        { section_index: 1, geometry_json: '{"type":"LineString","coordinates":[[115.1,-8.5],[115.2,-8.6]]}' }
      ] as never;
    };
    const result = await getRouteGeometry(2, "latest", query);
    expect(result.collection.features.map((feature) => feature.properties.sectionIndex)).toEqual([0, 1]);
  });

  it("keeps route history scoped to one airport-tourism direction", async () => {
    const query: QueryRows = async (sql) => {
      if (sql.includes("api_airport_tourism_routes_v1")) return [{
        scope_key: "scope", scope_version: "v1", scope_status: "approved", prediction_enabled: 0, display_order: 1,
        route_id: 2, slug: "canggu-airport", origin_label: "Canggu", origin_lat: -8.6, origin_lng: 115.1,
        destination_label: "DPS Airport", destination_lat: -8.7, destination_lng: 115.16, category: "airport",
        route_purpose: "airport_tourism", route_group_key: "dps-canggu", tourism_center_key: "canggu", route_direction: "to_airport", active: 1
      }] as never;
      expect(sql).toContain("api_airport_route_history_v1");
      expect(sql).toContain("route_id = ?");
      expect(sql).toContain("collection_slot_utc >= ? AND collection_slot_utc < ?");
      return [{
        collection_slot_utc: "2026-07-16 17:00:00", sampled_at_utc: "2026-07-16 17:05:00",
        current_duration_seconds: 1900, typical_duration_seconds: 2000, base_duration_seconds: null,
        delay_vs_typical_seconds: -100, delay_vs_base_seconds: null, ratio_vs_typical: .95, ratio_vs_base: null
      }] as never;
    };
    const result = await getRouteHistory(2, { from: "2026-07-10T17:00:00.000Z", to: "2026-07-17T17:00:00.000Z", limit: 168 }, query);
    expect(result.route).toMatchObject({ routeGroupKey: "dps-canggu", routeDirection: "to_airport" });
    expect(result.points[0]).toMatchObject({ delayVsTypicalSeconds: -100, ratioVsTypical: .95 });
    expect(result.source).toBe("api_airport_route_history_v1");
  });
});
