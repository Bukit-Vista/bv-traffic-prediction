import "dotenv/config";
import { getFlowMap, getFlowSlots, getRouteGeometry, getRoutes, getRuns } from "../lib/api/data-source";
import { validateSourceContract } from "../lib/api/source-contract";
import { closeMySqlPool } from "../lib/db/mysql";
import { groupAirportTourismCorridors } from "../lib/routes/airport-corridors";

async function main() {
  const checks = await validateSourceContract();
  const [slots, flowRuns, routeRuns, routes] = await Promise.all([
    getFlowSlots(), getRuns("flow"), getRuns("hourly"), getRoutes()
  ]);
  const newestSlot = slots[0]?.slotUtc;
  if (!newestSlot) throw new Error("No eligible Flow slot is available.");
  const cutoff = new Date(new Date(newestSlot).getTime() - 24 * 60 * 60_000);
  const flowWindow = flowRuns.filter((run) => new Date(run.slotUtc) >= cutoff);
  const routeWindow = routeRuns.filter((run) => new Date(run.slotUtc) >= cutoff);
  const flow = await getFlowMap({ bbox: [114.34, -8.9, 115.78, -8.03], at: "latest", limit: 5000, minConfidence: 0 });
  const geometryRoute = routes.find((route) => route.geometryAvailable);
  const geometry = geometryRoute ? await getRouteGeometry(geometryRoute.id) : null;
  const corridors = groupAirportTourismCorridors(routes);
  const completeCorridors = corridors.filter((corridor) => corridor.directions.fromAirport && corridor.directions.toAirport);
  const airportTourismGate = routes.length === 14 && corridors.length === 7 && completeCorridors.length === 7 &&
    routes.every((route) => route.routePurpose === "airport_tourism" && route.geometryAvailable);
  const stable = flowWindow.length >= 48 && routeWindow.length >= 24 &&
    flowWindow.every((run) => run.status === "success") && routeWindow.every((run) => run.status === "success");

  console.log(JSON.stringify({
    readyForProduction: stable && airportTourismGate,
    airportTourismGate: {
      ready: airportTourismGate,
      routes: routes.length,
      corridors: corridors.length,
      completeDirectionalPairs: completeCorridors.length,
      fromAirport: routes.filter((route) => route.routeDirection === "from_airport").length,
      toAirport: routes.filter((route) => route.routeDirection === "to_airport").length,
      routesWithGeometry: routes.filter((route) => route.geometryAvailable).length
    },
    contractChecks: checks,
    latest: { slotUtc: flow.meta.slotUtc, sourceRunId: flow.meta.sourceRunId, flowFeatures: flow.collection.features.length, routes: routes.length },
    last24Hours: {
      flowRuns: flowWindow.length, routeRuns: routeWindow.length,
      flowFailures: flowWindow.filter((run) => run.status !== "success").length,
      routeFailures: routeWindow.filter((run) => run.status !== "success").length
    },
    routeGeometry: geometry ? { routeId: geometryRoute?.id, slotUtc: geometry.slotUtc, sections: geometry.collection.features.length } : null
  }, null, 2));
  if (!stable) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => closeMySqlPool());
