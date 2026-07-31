import "dotenv/config";
import { describe, expect, it } from "vitest";
import { validateFullSourceContract } from "@/lib/api/source-contract";
import { getCollectorAlertStates, getAirportRouteDefinitions } from "@/lib/api/database-serving-contract";
import { getFlowMap, getMvpWindowStatus, getRouteGeometry, getRouteHistory } from "@/lib/api/data-source";
import { completedUtcHourWindow } from "@/lib/api/mvp-window";

const enabled = process.env.RUN_MYSQL_CONTRACT_TESTS === "1";
const CONTRACT_TEST_TIMEOUT_MS = 60_000;

describe.skipIf(!enabled)("read-only HERE MySQL contract", () => {
  it("has the canonical non-null columns, unique slots, latest pointers, and SRID 4326 geometry", async () => {
    const checks = await validateFullSourceContract();
    expect(checks).not.toHaveLength(0);
    expect(checks.every((check) => check.ok)).toBe(true);
  }, CONTRACT_TEST_TIMEOUT_MS);

  it("serves the deployed Step 3 Flow, collector, history, and geometry read paths", async () => {
    const [flow, collectors, definitions] = await Promise.all([
      getFlowMap({ bbox: [115.10, -8.80, 115.30, -8.60], at: "latest", limit: 25, minConfidence: 0 }),
      getCollectorAlertStates(),
      getAirportRouteDefinitions()
    ]);
    expect(flow.collection.features.length).toBeGreaterThan(0);
    expect(flow.source).toBe("api_traffic_flow_latest_v1");
    expect(collectors.map((state) => state.dataset).sort()).toEqual(["flow", "routes"]);
    expect(definitions).toHaveLength(14);

    const routeId = definitions[0]!.routeId;
    const window = completedUtcHourWindow();
    const [history, geometry, windowStatus] = await Promise.all([
      getRouteHistory(routeId, { from: window.startUtc, to: window.endExclusiveUtc, limit: 12 }),
      getRouteGeometry(routeId, "latest"),
      getMvpWindowStatus(window)
    ]);
    expect(history.points.length).toBeGreaterThan(0);
    expect(history.points.map((point) => point.collectionSlotUtc)).toEqual(
      [...history.points].map((point) => point.collectionSlotUtc).sort()
    );
    expect(["api_airport_route_history_v1", "legacy_route_tables_fallback"]).toContain(history.source);
    expect(geometry.collection.features.length).toBeGreaterThan(0);
    expect(geometry.collection.features.map((feature) => Number(feature.properties.sectionIndex))).toEqual(
      [...geometry.collection.features].map((feature) => Number(feature.properties.sectionIndex)).sort((a, b) => a - b)
    );
    expect(windowStatus.flow.expectedSlots).toBe(24);
    expect(windowStatus.routes.expectedSlots).toBe(12);
    expect(windowStatus.routes.expectedSamples).toBe(168);
  }, CONTRACT_TEST_TIMEOUT_MS);
});
