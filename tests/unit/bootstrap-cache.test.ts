import { describe, expect, it } from "vitest";
import {
  dashboardLiveFallbackEnabled,
  dashboardCacheMatches,
  dashboardResourceVersions,
  dashboardSnapshotMatches,
  dashboardVersionsMatch,
  flowSnapshotMatches,
  getSourceDashboardData
} from "@/lib/api/bootstrap";
import { vi } from "vitest";

const identities = {
  flow: { id: 67, slotUtc: "2026-07-17T01:00:00.000Z", status: "success", stale: false },
  routes: {
    stale: false,
    routes: [{
      id: 1, slug: "airport-canggu", originLabel: "DPS Airport", destinationLabel: "Canggu",
      category: "airport", routePurpose: "airport_tourism", routeGroupKey: "canggu",
      tourismCenterKey: "canggu", routeDirection: "from_airport", sampleId: 20,
      collectionSlotUtc: "2026-07-17T01:00:00.000Z", sampledAtUtc: "2026-07-17T01:01:00.000Z",
      distanceMeters: 21000, currentDurationSeconds: 3600, typicalDurationSeconds: 3300,
      baseDurationSeconds: 3000, delayVsTypicalSeconds: 300, delayVsBaseSeconds: 600,
      ratioVsTypical: 1.09, ratioVsBase: 1.2, provider: "here", status: "fresh", geometryCount: 2
    }]
  },
  flowHealth: {
    id: 67, slotUtc: "2026-07-17T01:00:00.000Z", status: "success", attempts: 1,
    observations: 3773, expectedAreas: 10, successfulAreas: 10,
    finishedAtUtc: "2026-07-17T01:02:00.000Z", hasError: false
  },
  routeHealth: {
    id: 108, slotUtc: "2026-07-17T01:00:00.000Z", status: "success", attempts: 1,
    expected: 14, successful: 14, failed: 0,
    finishedAtUtc: "2026-07-17T01:03:00.000Z", hasError: false
  }
};

const snapshot = {
  meta: { sourceRunId: "67", slotUtc: "2026-07-17T01:00:00.000Z", status: "success", stale: false },
  routes: [{
    id: 1, slug: "airport-canggu", name: "DPS Airport to Canggu", originLabel: "DPS Airport", destinationLabel: "Canggu",
    category: "airport", routePurpose: "airport_tourism", routeGroupKey: "canggu",
    tourismCenterKey: "canggu", routeDirection: "from_airport",
    collectionSlotUtc: "2026-07-17T01:00:00.000Z", sampledAtUtc: "2026-07-17T01:01:00.000Z",
    distanceMeters: 21000, currentDurationSeconds: 3600, typicalDurationSeconds: 3300,
    baseDurationSeconds: 3000, delayVsTypicalSeconds: 300, delayVsBaseSeconds: 600,
    ratioVsTypical: 1.09, ratioVsBase: 1.2, provider: "here", status: "fresh", geometryAvailable: true
  }],
  flowRuns: [{
    id: 67, slotUtc: "2026-07-17T01:00:00.000Z", status: "success", source: "HERE Flow",
    expectedCount: 10, successCount: 10, failedCount: 0, recordCount: 3773,
    durationSeconds: 120, attemptCount: 1, finishedAtUtc: "2026-07-17T01:02:00.000Z", errorMessage: null
  }],
  routeRuns: [{
    id: 108, slotUtc: "2026-07-17T01:00:00.000Z", status: "success", source: "n8n-here-routes",
    expectedCount: 14, successCount: 14, failedCount: 0, recordCount: 14,
    durationSeconds: 180, attemptCount: 1, finishedAtUtc: "2026-07-17T01:03:00.000Z", errorMessage: null
  }]
};

describe("dashboard bootstrap cache alignment", () => {
  it("accepts versions only when the rendered snapshot has the same identities", () => {
    expect(dashboardSnapshotMatches(identities as never, snapshot as never)).toBe(true);
  });

  it("rejects a version token when a displayed route changed during bootstrap", () => {
    const changed = { ...snapshot, routes: [{ ...snapshot.routes[0], ratioVsTypical: 1.12 }] };
    expect(dashboardSnapshotMatches(identities as never, changed as never)).toBe(false);
  });

  it("distinguishes a current Flow tile cache from a fully current dashboard cache", () => {
    const versions = dashboardResourceVersions(identities as never);
    const cached = { ...snapshot, versions };
    const live = { ...cached, versions };
    expect(flowSnapshotMatches(identities as never, cached as never)).toBe(true);
    expect(dashboardVersionsMatch(versions, { ...versions, routes: "changed" })).toBe(false);
    expect(dashboardCacheMatches(live as never, cached as never)).toBe(true);
    expect(dashboardCacheMatches({ ...live, meta: { ...live.meta, sourceRunId: "68" } } as never, cached as never)).toBe(false);
  });

  it("serves a published snapshot without touching live MySQL", async () => {
    const loadLive = vi.fn();
    await expect(getSourceDashboardData({
      env: { NODE_ENV: "production" },
      readSnapshot: async () => snapshot as never,
      loadLive
    })).resolves.toBe(snapshot);
    expect(loadLive).not.toHaveBeenCalled();
  });

  it("requires a manual refresh when production has no published snapshot", async () => {
    expect(dashboardLiveFallbackEnabled({ NODE_ENV: "production" })).toBe(false);
    await expect(getSourceDashboardData({
      env: { NODE_ENV: "production" },
      readSnapshot: async () => null,
      loadLive: vi.fn()
    })).rejects.toThrow("authorized manual refresh");
  });
});
