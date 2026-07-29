import { describe, expect, it } from "vitest";
import {
  mapIngestionRun,
  mapRoute,
  mapRouteSample,
  parseJson,
  toIsoUtc
} from "@/lib/db/mappers";
import { getMySqlConfig, getMySqlRuntimeConfig, hasMutationPrivileges, toMysqlDateTime } from "@/lib/db/mysql";

describe("mysql config and mappers", () => {
  it("requires MySQL configuration", () => {
    expect(() => getMySqlConfig({})).toThrow("Missing MySQL configuration");
  });

  it("supports individual connection fields", () => {
    expect(
      getMySqlConfig({
        MYSQL_HOST: "127.0.0.1",
        MYSQL_PORT: "3307",
        MYSQL_USER: "route_reader",
        MYSQL_PASSWORD: "secret",
        MYSQL_DATABASE: "bali_routes"
      })
    ).toEqual({
      host: "127.0.0.1",
      port: 3307,
      user: "route_reader",
      password: "secret",
      database: "bali_routes"
    });
  });

  it("bounds the read pool and per-query timeout", () => {
    expect(getMySqlRuntimeConfig({})).toEqual({ connectionLimit: 6, queryTimeoutMs: 15000 });
    expect(getMySqlRuntimeConfig({ MYSQL_CONNECTION_LIMIT: "200", MYSQL_QUERY_TIMEOUT_MS: "90000" })).toEqual({
      connectionLimit: 6, queryTimeoutMs: 15000
    });
  });

  it("detects write-capable grants without retaining grant details", () => {
    expect(hasMutationPrivileges("GRANT SELECT ON app.* TO reader")).toBe(false);
    expect(hasMutationPrivileges("GRANT SELECT, INSERT, UPDATE ON app.* TO reader")).toBe(true);
  });

  it("normalizes MySQL datetime values as UTC ISO strings", () => {
    expect(toIsoUtc("2026-07-13 08:00:00")).toBe("2026-07-13T08:00:00.000Z");
    expect(toMysqlDateTime("2026-07-13T08:00:00.000Z")).toBe(
      "2026-07-13 08:00:00"
    );
  });

  it("parses nullable JSON values", () => {
    expect(parseJson(null)).toBeNull();
    expect(parseJson('{"ok":true}')).toEqual({ ok: true });
    expect(parseJson("plain")).toBe("plain");
  });

  it("maps snake_case MySQL rows to app types", () => {
    expect(
      mapRoute({
        id: 1,
        slug: "airport-to-canggu",
        origin_label: "DPS Airport",
        origin_lat: -8.7467,
        origin_lng: 115.1672,
        destination_label: "Canggu",
        destination_lat: -8.6503,
        destination_lng: 115.1386,
        category: "airport",
        active: 1,
        created_at: "2026-07-13 08:00:00",
        updated_at: "2026-07-13 09:00:00"
      })
    ).toMatchObject({
      id: 1,
      originLabel: "DPS Airport",
      active: true,
      createdAt: "2026-07-13T08:00:00.000Z"
    });

    expect(
      mapRouteSample({
        id: 10,
        route_id: 1,
        ingestion_run_id: 2,
        sample_hour_utc: "2026-07-13 08:00:00",
        sampled_at_utc: "2026-07-13 08:05:00",
        provider: "here",
        api_product: "routing_v8_calculate_route",
        traffic_source: "live",
        distance_meters: 1000,
        duration_seconds: 100,
        traffic_duration_seconds: 150,
        traffic_delay_seconds: 50,
        congestion_score: "1.500",
        http_status: 200,
        tracking_id: null,
        raw_summary_json: '{"lengthInMeters":1000}'
      })
    ).toMatchObject({
      routeId: 1,
      sampleHour: "2026-07-13T08:00:00.000Z",
      congestionScore: 1.5,
      rawSummaryJson: { lengthInMeters: 1000 }
    });

    expect(
      mapIngestionRun({
        id: 3,
        source: "n8n",
        sample_hour_utc: "2026-07-13 08:00:00",
        started_at_utc: "2026-07-13 08:05:00",
        finished_at_utc: null,
        status: "partial",
        route_expected_count: 13,
        route_success_count: 12,
        route_failure_count: 1,
        incident_success: 1,
        flow_tile_expected_count: 0,
        flow_tile_success_count: 0,
        error_json: null
      })
    ).toMatchObject({
      source: "n8n",
      status: "partial",
      routeSuccessCount: 12,
      incidentSuccess: true
    });
  });
});
