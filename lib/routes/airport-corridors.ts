import type { AirportCorridor, RouteSummary } from "@/lib/dashboard/types";

export const AIRPORT_CORRIDOR_DISCLAIMER = "Airport corridor indicators are inferred from route travel conditions. They do not represent observed people or trip counts.";

export function groupAirportTourismCorridors(routes: RouteSummary[]): AirportCorridor[] {
  const groups = new Map<string, AirportCorridor>();
  for (const route of routes) {
    const key = route.routeGroupKey;
    let group = groups.get(key);
    if (!group) {
      group = {
        routeGroupKey: key,
        tourismCenterKey: route.tourismCenterKey,
        directions: { fromAirport: null, toAirport: null }
      };
      groups.set(key, group);
    }
    if (route.routeDirection === "from_airport") group.directions.fromAirport = route;
    if (route.routeDirection === "to_airport") group.directions.toAirport = route;
  }
  return [...groups.values()].sort((a, b) => a.routeGroupKey.localeCompare(b.routeGroupKey));
}
