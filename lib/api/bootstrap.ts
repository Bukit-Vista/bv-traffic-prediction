import { getDashboardVersionIdentities, getFlowMap, getFlowSlots, getMvpWindowStatus, getRoutes } from "@/lib/api/data-source";
import { getCollectorAlertStates } from "@/lib/api/database-serving-contract";
import { createResourceEtag } from "@/lib/api/conditional-cache";
import { makeMeta } from "@/lib/api/core";
import { useDemoSource } from "@/lib/api/demo-source";
import type { CollectionRun, CollectorState, RouteSummary, SourceDashboardData } from "@/lib/dashboard/types";
import { calculateTrafficOverviewForCollection } from "@/lib/map/viewport-traffic";
import { ensureLatestTrafficSnapshot } from "@/lib/snapshot/ensure-traffic-snapshot";
import { readCurrentDashboardSnapshot } from "@/lib/snapshot/traffic-snapshot";
import { completedUtcHourWindow } from "@/lib/api/mvp-window";

export const DEFAULT_BALI_BBOX: [number, number, number, number] = [114.34, -8.9, 115.78, -8.03];

export type DashboardVersionIdentities = Awaited<ReturnType<typeof getDashboardVersionIdentities>>;

function sameValue(left: unknown, right: unknown) {
  return (left ?? null) === (right ?? null);
}

function routeSnapshotMatches(identity: DashboardVersionIdentities["routes"]["routes"][number], route: RouteSummary | undefined) {
  return Boolean(route) && [
    [identity.id, route?.id], [identity.slug, route?.slug], [identity.originLabel, route?.originLabel],
    [identity.destinationLabel, route?.destinationLabel], [identity.category, route?.category],
    [identity.routePurpose, route?.routePurpose], [identity.routeGroupKey, route?.routeGroupKey],
    [identity.tourismCenterKey, route?.tourismCenterKey], [identity.routeDirection, route?.routeDirection],
    [identity.collectionSlotUtc, route?.collectionSlotUtc], [identity.sampledAtUtc, route?.sampledAtUtc],
    [identity.distanceMeters, route?.distanceMeters], [identity.currentDurationSeconds, route?.currentDurationSeconds],
    [identity.typicalDurationSeconds, route?.typicalDurationSeconds], [identity.baseDurationSeconds, route?.baseDurationSeconds],
    [identity.delayVsTypicalSeconds, route?.delayVsTypicalSeconds], [identity.delayVsBaseSeconds, route?.delayVsBaseSeconds],
    [identity.ratioVsTypical, route?.ratioVsTypical], [identity.ratioVsBase, route?.ratioVsBase],
    [identity.provider, route?.provider], [identity.status, route?.status],
    [identity.geometryCount > 0, route?.geometryAvailable]
  ].every(([left, right]) => sameValue(left, right));
}

function runSnapshotMatches(identity: DashboardVersionIdentities["flowHealth"] | DashboardVersionIdentities["routeHealth"], run: CollectionRun | undefined) {
  if (!identity) return run == null;
  if (!run) return false;
  const expectedCount = "expectedAreas" in identity ? identity.expectedAreas : identity.expected;
  const successCount = "successfulAreas" in identity ? identity.successfulAreas : identity.successful;
  return identity.id === run.id && identity.slotUtc === run.slotUtc && identity.status === run.status &&
    identity.attempts === run.attemptCount && expectedCount === run.expectedCount && successCount === run.successCount &&
    identity.finishedAtUtc === run.finishedAtUtc && identity.hasError === Boolean(run.errorMessage) &&
    (!("observations" in identity) || identity.observations === run.recordCount) &&
    (!("failed" in identity) || identity.failed === run.failedCount);
}

function stateAsRun(state: CollectorState): CollectionRun {
  return {
    id: Number(state.runId), slotUtc: state.collectionSlotUtc, status: state.status,
    source: state.dataset === "flow" ? "HERE Flow" : "HERE Routes",
    expectedCount: state.expectedCount, successCount: state.successfulCount,
    failedCount: state.failedCount, recordCount: state.recordCount,
    durationSeconds: state.durationSeconds, attemptCount: state.retryCount + 1,
    retryCount: state.retryCount, http429Count: state.http429Count,
    slotAgeMinutes: state.slotAgeMinutes, alertCode: state.alertCode ?? undefined,
    coverage: state.coverageRatio, finishedAtUtc: state.finishedAtUtc,
    healthState: state.healthState, isRunning: state.isRunning, isStuck: state.isStuck,
    errorMessage: state.isFailed ? "Collector failed; details are restricted to operations." : null
  };
}

export function dashboardSnapshotMatches(
  identities: DashboardVersionIdentities,
  snapshot: Pick<SourceDashboardData, "meta" | "routes" | "flowRuns" | "routeRuns">
) {
  return String(identities.flow.id) === snapshot.meta.sourceRunId &&
    identities.flow.slotUtc === snapshot.meta.slotUtc &&
    identities.flow.status === snapshot.meta.status &&
    identities.flow.stale === snapshot.meta.stale &&
    identities.routes.routes.length === snapshot.routes.length &&
    identities.routes.routes.every((identity) => routeSnapshotMatches(
      identity,
      snapshot.routes.find((route) => route.id === identity.id)
    )) &&
    runSnapshotMatches(identities.flowHealth, snapshot.flowRuns[0]) &&
    runSnapshotMatches(identities.routeHealth, snapshot.routeRuns[0]);
}

export function dashboardResourceVersions(identities: DashboardVersionIdentities) {
  return {
    flow: createResourceEtag("dashboard-flow", identities.flow),
    routes: createResourceEtag("dashboard-routes", identities.routes),
    flowHealth: createResourceEtag("dashboard-flow-health", identities.flowHealth),
    routeHealth: createResourceEtag("dashboard-route-health", identities.routeHealth)
  };
}

export function dashboardVersionsMatch(
  left: SourceDashboardData["versions"],
  right: SourceDashboardData["versions"]
) {
  return Boolean(left && right) && left!.flow === right!.flow && left!.routes === right!.routes &&
    left!.flowHealth === right!.flowHealth && left!.routeHealth === right!.routeHealth;
}

export function flowSnapshotMatches(
  identities: DashboardVersionIdentities,
  snapshot: Pick<SourceDashboardData, "meta">
) {
  return String(identities.flow.id) === snapshot.meta.sourceRunId && identities.flow.slotUtc === snapshot.meta.slotUtc &&
    identities.flow.status === snapshot.meta.status && identities.flow.stale === snapshot.meta.stale;
}

export function dashboardCacheMatches(live: SourceDashboardData, snapshot: SourceDashboardData) {
  return live.meta.sourceRunId === snapshot.meta.sourceRunId && live.meta.slotUtc === snapshot.meta.slotUtc &&
    dashboardVersionsMatch(live.versions, snapshot.versions);
}

export async function getMySqlSourceDashboardData(): Promise<SourceDashboardData> {
  if (process.env.HERE_SOURCE_CUTOVER_ENABLED === "false") {
    throw new Error("HERE source-data cutover is disabled for this deployment.");
  }
  // This call enforces the production prohibition even though this bootstrap never substitutes fixtures.
  useDemoSource();
  const input = { bbox: DEFAULT_BALI_BBOX, at: "latest", limit: 5000, minConfidence: 0 };
  const window = completedUtcHourWindow();
  const [flow, routes, slots, sourceStates, versionIdentities, windowStatus] = await Promise.all([
    getFlowMap(input),
    getRoutes(),
    getFlowSlots(window.startUtc, window.endExclusiveUtc),
    getCollectorAlertStates(),
    getDashboardVersionIdentities(),
    getMvpWindowStatus(window)
  ]);
  const flowRuns = sourceStates.filter((state) => state.dataset === "flow").map(stateAsRun);
  const routeRuns = sourceStates.filter((state) => state.dataset === "routes").map(stateAsRun);
  const overview = calculateTrafficOverviewForCollection({ flow: flow.collection, routes, coverage: flow.meta.coverage });
  const meta = makeMeta({ ...flow.meta, truncated: flow.truncated, featureCount: flow.collection.features.length });
  const versions = dashboardSnapshotMatches(versionIdentities, { meta, routes, flowRuns, routeRuns })
    ? dashboardResourceVersions(versionIdentities)
    : null;
  return {
    generatedAt: new Date().toISOString(),
    versions,
    flow: flow.collection,
    trafficOverview: overview,
    routes,
    slots,
    flowRuns,
    routeRuns,
    sourceStates,
    windowStatus,
    meta
  };
}

export function dashboardLiveFallbackEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.NODE_ENV !== "production";
}

type DashboardSourceDependencies = {
  env?: NodeJS.ProcessEnv;
  readSnapshot?: typeof readCurrentDashboardSnapshot;
  loadLive?: typeof getMySqlSourceDashboardData;
  materialize?: typeof ensureLatestTrafficSnapshot;
};

export async function getSourceDashboardData(
  dependencies: DashboardSourceDependencies = {}
): Promise<SourceDashboardData> {
  const readSnapshot = dependencies.readSnapshot ?? readCurrentDashboardSnapshot;
  const snapshot = await readSnapshot();
  if (snapshot) return snapshot;

  const env = dependencies.env ?? process.env;
  if (!dashboardLiveFallbackEnabled(env)) {
    throw new Error(
      "The published Redis dashboard snapshot is unavailable. An authorized manual refresh is required."
    );
  }

  const loadLive = dependencies.loadLive ?? getMySqlSourceDashboardData;
  const live = await loadLive();
  try {
    const materialize = dependencies.materialize ?? ensureLatestTrafficSnapshot;
    return await materialize(live) ?? live;
  } catch {
    return live;
  }
}

export function unavailableSourceDashboard(): SourceDashboardData {
  return {
    generatedAt: new Date().toISOString(),
    versions: null,
    flow: { type: "FeatureCollection", features: [] },
    trafficOverview: { weightedJamFactor: null, congestedRoadShare: null, closures: 0, slowestRoute: null, measuredLengthMeters: 0, coverage: 0 },
    routes: [], slots: [], flowRuns: [], routeRuns: [], windowStatus: null,
    trafficTiles: null,
    meta: makeMeta({
      status: "unavailable", stale: false, source: "here_mysql", semantics: "measured_traffic",
      disclaimer: "Current HERE Flow and Route data is unavailable. No fixture data was substituted."
    })
  };
}
