import { describe, expect, it } from "vitest";
import { completedUtcHourWindow, coverageForSlots, expectedSlots, resolveMvpUtcWindow } from "@/lib/api/mvp-window";
import { getMvpWindowStatus } from "@/lib/api/data-source";
import type { QueryRows } from "@/lib/db/mysql";

describe("12-hour MVP window", () => {
  it("uses the last twelve completed UTC clock-hours", () => {
    const window = completedUtcHourWindow(12, new Date("2026-07-21T08:35:00.000Z"));
    expect(window).toEqual({
      startUtc: "2026-07-20T20:00:00.000Z",
      endExclusiveUtc: "2026-07-21T08:00:00.000Z",
      windowHours: 12
    });
    expect(expectedSlots(window, 30)).toHaveLength(24);
    expect(expectedSlots(window, 60)).toHaveLength(12);
    expect(expectedSlots(window, 30).at(-1)).toBe("2026-07-21T07:30:00.000Z");
  });

  it("enforces a configured maximum and aligned half-open explicit ranges", () => {
    expect(() => completedUtcHourWindow(13, Date.now(), 12)).toThrow("hours must be an integer");
    expect(() => resolveMvpUtcWindow({
      from: "2026-07-20T20:30:00.000Z",
      to: "2026-07-21T08:00:00.000Z"
    }, Date.now(), 12)).toThrow("align to UTC clock hours");
    expect(resolveMvpUtcWindow({
      from: "2026-07-20T20:00:00.000Z",
      to: "2026-07-21T08:00:00.000Z"
    }, Date.now(), 12).windowHours).toBe(12);
  });

  it("reports every missing slot without substituting an older window", () => {
    const expected = ["a", "b", "c"];
    expect(coverageForSlots(expected, ["a", "c", "older"])).toEqual({
      expectedSlots: 3,
      presentSlots: 2,
      coverage: 2 / 3,
      missingSlotsUtc: ["b"]
    });
  });

  it("accepts a complete 24-Flow-slot and 12-Route-slot source window", async () => {
    const window = completedUtcHourWindow(12, new Date("2026-07-21T08:35:00.000Z"));
    const flowSlots = expectedSlots(window, 30);
    const routeSlots = expectedSlots(window, 60);
    const run = (dataset: "flow" | "routes", slot: string, index: number) => ({
      dataset, run_id: index + 1, run_token: `${dataset}-${index}`, collection_slot_utc: slot,
      status: "success", expected_count: dataset === "flow" ? 2 : 14,
      successful_count: dataset === "flow" ? 2 : 14, failed_count: 0,
      coverage_ratio: 1, record_count: dataset === "flow" ? 3700 : 14,
      retry_count: 0, http_429_count: 0, attempt_count: 1,
      started_at_utc: slot, finished_at_utc: slot, duration_seconds: 20,
      slot_age_minutes: 1, is_running: 0, is_stuck: 0, has_error: 0, health_state: "healthy"
    });
    const query: QueryRows = async (sql) => {
      if (sql.includes("api_flow_run_history_v1")) return flowSlots.map((slot, index) => run("flow", slot, index)) as never;
      if (sql.includes("api_route_run_history_v1")) return routeSlots.map((slot, index) => run("routes", slot, index)) as never;
      if (sql.includes("api_airport_route_slots_v1")) return routeSlots.map((slot) => ({
        collection_slot_utc: slot, observed_route_count: 14, successful_route_count: 14,
        unsuccessful_route_count: 0, first_sampled_at_utc: slot, last_sampled_at_utc: slot,
        minimum_ratio_vs_typical: 1, maximum_ratio_vs_typical: 1.2, average_ratio_vs_typical: 1.1
      })) as never;
      if (sql.includes("api_airport_route_geometry_v1")) return routeSlots.map((slot) => ({
        collection_slot_utc: slot, geometry_route_count: 14
      })) as never;
      throw new Error(`Unexpected query: ${sql}`);
    };
    const result = await getMvpWindowStatus(window, query);
    expect(result.status).toBe("complete");
    expect(result.flow).toMatchObject({ expectedSlots: 24, presentSlots: 24, passedSlots: 24, coverage: 1 });
    expect(result.routes).toMatchObject({
      expectedSlots: 12, presentSlots: 12, passedSlots: 12, expectedSamples: 168,
      presentSamples: 168, expectedGeometries: 168, presentGeometries: 168
    });
  });
});
