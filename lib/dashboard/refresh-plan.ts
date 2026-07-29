import type { DashboardResourceVersions } from "@/lib/dashboard/types";

export function createProvinceFlowScope(mode: "latest" | "historical", at: string) {
  return `${mode}|${at}`;
}

export function createDashboardRefreshPlan(input: {
  mode: "latest" | "historical";
  scopeChanged: boolean;
  routeScopeChanged: boolean;
  serverVersions: DashboardResourceVersions | null;
  appliedVersions: DashboardResourceVersions | null;
  syncFailed: boolean;
}) {
  const latest = input.mode === "latest";
  const changed = (key: keyof DashboardResourceVersions) => latest && (
    input.syncFailed || !input.serverVersions || !input.appliedVersions ||
    input.serverVersions[key] !== input.appliedVersions[key]
  );
  const flowVersionChanged = changed("flow");
  const routeVersionChanged = changed("routes");
  return {
    flowVersionChanged,
    routeVersionChanged,
    flowHealthChanged: changed("flowHealth"),
    routeHealthChanged: changed("routeHealth"),
    flowNeeded: input.scopeChanged || flowVersionChanged,
    routesNeeded: input.routeScopeChanged || routeVersionChanged
  };
}
