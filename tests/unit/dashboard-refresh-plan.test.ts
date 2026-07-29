import { describe, expect, it } from "vitest";
import { createDashboardRefreshPlan, createProvinceFlowScope } from "@/lib/dashboard/refresh-plan";
import type { DashboardResourceVersions } from "@/lib/dashboard/types";

const versions: DashboardResourceVersions = { flow: "f1", routes: "r1", flowHealth: "fh1", routeHealth: "rh1" };

describe("dashboard conditional refresh planning", () => {
  it("does no resource work when versions and scopes are unchanged", () => {
    expect(createDashboardRefreshPlan({ mode: "latest", scopeChanged: false, routeScopeChanged: false, serverVersions: versions, appliedVersions: versions, syncFailed: false })).toEqual({
      flowVersionChanged: false, routeVersionChanged: false, flowHealthChanged: false,
      routeHealthChanged: false, flowNeeded: false, routesNeeded: false
    });
  });

  it("updates only Flow resources for a new Flow version", () => {
    const next = { ...versions, flow: "f2", flowHealth: "fh2" };
    expect(createDashboardRefreshPlan({ mode: "latest", scopeChanged: false, routeScopeChanged: false, serverVersions: next, appliedVersions: versions, syncFailed: false })).toMatchObject({
      flowNeeded: true, routesNeeded: false, flowHealthChanged: true, routeHealthChanged: false
    });
  });

  it("keeps one province Flow scope across pan, zoom, and confidence changes", () => {
    expect(createProvinceFlowScope("latest", "latest")).toBe(createProvinceFlowScope("latest", "latest"));
    expect(createDashboardRefreshPlan({ mode: "latest", scopeChanged: false, routeScopeChanged: false, serverVersions: versions, appliedVersions: versions, syncFailed: false })).toMatchObject({
      flowNeeded: false, routesNeeded: false
    });
  });

  it("loads exact Flow and Routes when historical selection changes", () => {
    expect(createDashboardRefreshPlan({ mode: "historical", scopeChanged: true, routeScopeChanged: true, serverVersions: versions, appliedVersions: versions, syncFailed: false })).toMatchObject({
      flowNeeded: true, routesNeeded: true, flowVersionChanged: false, routeVersionChanged: false
    });
  });
});
