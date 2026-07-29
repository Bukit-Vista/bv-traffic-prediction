import { describe, expect, it } from "vitest";
import { groupAirportTourismCorridors } from "@/lib/routes/airport-corridors";
import type { RouteSummary } from "@/lib/dashboard/types";

function route(group: string, center: string, direction: RouteSummary["routeDirection"], id: number): RouteSummary {
  return {
    id, slug: `${group}-${direction}`, name: `${group} ${direction}`,
    originLabel: direction === "from_airport" ? "DPS Airport" : center,
    destinationLabel: direction === "from_airport" ? center : "DPS Airport",
    category: "airport", routePurpose: "airport_tourism", routeGroupKey: group,
    tourismCenterKey: center, routeDirection: direction, distanceMeters: 1000,
    currentDurationSeconds: 100, typicalDurationSeconds: 100, baseDurationSeconds: 100,
    delayVsTypicalSeconds: 0, delayVsBaseSeconds: 0, ratioVsTypical: 1, ratioVsBase: 1,
    collectionSlotUtc: "2026-07-17T00:00:00.000Z", sampledAtUtc: "2026-07-17T00:05:00.000Z",
    provider: "here", typicalSeconds: 100, liveSeconds: 100, delaySeconds: 0,
    congestionRatio: 1, sampleHourUtc: "2026-07-17T00:00:00.000Z", confidence: null,
    status: "fresh", geometryAvailable: true
  };
}

describe("airport tourism corridor grouping", () => {
  it("keeps both directions as separate measurements in seven groups", () => {
    const centers = ["canggu", "ubud", "uluwatu", "seminyak", "sanur", "jimbaran", "nusa-dua"];
    const groups = groupAirportTourismCorridors(centers.flatMap((center, index) => [
      route(`dps-${center}`, center, "from_airport", index * 2 + 1),
      route(`dps-${center}`, center, "to_airport", index * 2 + 2)
    ]));
    expect(groups).toHaveLength(7);
    expect(groups.every((group) => group.directions.fromAirport && group.directions.toAirport)).toBe(true);
    expect(groups[0]?.directions.fromAirport?.id).not.toBe(groups[0]?.directions.toAirport?.id);
  });

  it("preserves a missing direction instead of copying the reverse measurement", () => {
    const groups = groupAirportTourismCorridors([route("dps-ubud", "ubud", "from_airport", 3)]);
    expect(groups[0]?.directions.fromAirport?.id).toBe(3);
    expect(groups[0]?.directions.toAirport).toBeNull();
  });
});
