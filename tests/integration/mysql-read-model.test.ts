import { describe, expect, it } from "vitest";
import { getDashboardData } from "@/lib/data/dashboard";
import { getHeatmapRangeData } from "@/lib/data/heatmap-range";
import type { QueryRows } from "@/lib/db/mysql";

function routeRow(id: number, label: string) {
  return {
    id,
    slug: label.toLowerCase(),
    origin_label: label,
    origin_lat: -8,
    origin_lng: 115,
    destination_label: "Destination",
    destination_lat: -8.5,
    destination_lng: 115.5,
    category: "test",
    active: 1,
    created_at: "2026-07-13 00:00:00",
    updated_at: "2026-07-13 00:00:00"
  };
}

function sampleRow(routeId: number, sampleHour: string, score: number) {
  return {
    id: routeId * 10,
    route_id: routeId,
    ingestion_run_id: 1,
    sample_hour_utc: sampleHour,
    sampled_at_utc: sampleHour,
    provider: "here",
    api_product: "routing_v8_calculate_route",
    traffic_source: "live",
    distance_meters: 1000,
    duration_seconds: 100,
    traffic_duration_seconds: Math.round(score * 100),
    traffic_delay_seconds: Math.round(score * 100) - 100,
    congestion_score: score,
    http_status: 200,
    tracking_id: null,
    raw_summary_json: null
  };
}

function runRow(status = "success") {
  return {
    id: 1,
    source: "n8n",
    sample_hour_utc: "2026-07-13 08:00:00",
    started_at_utc: "2026-07-13 08:05:00",
    finished_at_utc: "2026-07-13 08:06:00",
    status,
    route_expected_count: 2,
    route_success_count: 2,
    route_failure_count: 0,
    incident_success: 1,
    flow_tile_expected_count: 0,
    flow_tile_success_count: 0,
    error_json: null
  };
}

describe("mysql read model", () => {
  it("builds dashboard data from latest live samples and latest ingestion run", async () => {
    const calls: string[] = [];
    const query: QueryRows = async (sql) => {
      calls.push(sql);
      if (sql.includes("FROM routes")) {
        return [routeRow(1, "A"), routeRow(2, "B")] as never;
      }
      if (sql.includes("MAX(sample_hour_utc)")) {
        expect(sql).toContain("traffic_source = 'live'");
        return [
          sampleRow(1, "2026-07-13 08:00:00", 1.4),
          sampleRow(2, "2026-07-13 09:00:00", 1.1)
        ] as never;
      }
      if (sql.includes("FROM ingestion_runs")) {
        return [runRow("partial")] as never;
      }
      if (sql.includes("FROM route_samples")) {
        expect(sql).toContain("traffic_source = 'live'");
        return [sampleRow(1, "2026-07-13 08:00:00", 1.4)] as never;
      }
      return [] as never;
    };

    const data = await getDashboardData({ query });

    expect(data.routes).toHaveLength(2);
    expect(data.latestRun?.status).toBe("partial");
    expect(data.leaderboard[0].route.id).toBe(1);
    expect(data.leaderboard[0].score).toBe(1.4);
    expect(calls.some((sql) => sql.includes("traffic_source = 'live'"))).toBe(true);
  });

  it("keeps heatmap cells blank when a live sample is missing", async () => {
    const query: QueryRows = async (sql) => {
      if (sql.includes("FROM routes")) {
        return [routeRow(1, "A"), routeRow(2, "B")] as never;
      }
      if (sql.includes("FROM route_samples")) {
        expect(sql).toContain("traffic_source = 'live'");
        return [sampleRow(1, "2026-07-12 16:00:00", 1.3)] as never;
      }
      return [] as never;
    };

    const heatmap = await getHeatmapRangeData({
      query,
      startDate: "2026-07-13",
      endDate: "2026-07-13"
    });

    expect(heatmap.rows[0].cells[0]?.score).toBeCloseTo(1.3);
    expect(heatmap.heatmaps).toHaveLength(1);
    expect(heatmap.heatmaps[0].date).toBe("2026-07-13");
    expect(heatmap.rows[1].cells[0]).toBeNull();
  });

  it("returns one heatmap per compared WITA date", async () => {
    const query: QueryRows = async (sql) => {
      if (sql.includes("FROM routes")) {
        return [routeRow(1, "A")] as never;
      }
      if (sql.includes("FROM route_samples")) {
        return [
          sampleRow(1, "2026-07-12 16:00:00", 1.2),
          sampleRow(1, "2026-07-13 16:00:00", 1.6)
        ] as never;
      }
      return [] as never;
    };

    const heatmap = await getHeatmapRangeData({
      query,
      startDate: "2026-07-13",
      endDate: "2026-07-14"
    });

    expect(heatmap.heatmaps).toHaveLength(2);
    expect(heatmap.heatmaps.map((item) => item.date)).toEqual([
      "2026-07-13",
      "2026-07-14"
    ]);
    expect(heatmap.heatmaps[0].rows[0].cells[0]?.score).toBeCloseTo(1.2);
    expect(heatmap.heatmaps[1].rows[0].cells[0]?.score).toBeCloseTo(1.6);
  });
});
