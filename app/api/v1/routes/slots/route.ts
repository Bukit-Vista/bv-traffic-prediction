import { apiError, apiJson } from "@/lib/api/response";
import { getAirportRouteSlots } from "@/lib/api/database-serving-contract";
import { coverageForSlots, expectedSlots, MVP_ROUTES_PER_SLOT, resolveMvpUtcWindow } from "@/lib/api/mvp-window";
import { mvpWindowQuerySchema, parseQuery } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(mvpWindowQuerySchema, request);
    const window = resolveMvpUtcWindow(input);
    const slots = await getAirportRouteSlots({ from: window.startUtc, to: window.endExclusiveUtc, limit: 500 });
    const expected = expectedSlots(window, 60);
    const coverage = coverageForSlots(expected, slots.map((slot) => slot.collectionSlotUtc));
    const passedSlots = slots.filter((slot) => slot.successfulRouteCount === MVP_ROUTES_PER_SLOT && slot.unsuccessfulRouteCount === 0).length;
    const complete = coverage.presentSlots === expected.length && passedSlots === expected.length;
    return apiJson({ slots, count: slots.length, window, coverage: { ...coverage, passedSlots } }, {
      source: "api_airport_route_slots_v1",
      selectedSlot: slots[0]?.collectionSlotUtc ?? null,
      slotUtc: slots[0]?.collectionSlotUtc ?? null,
      requestedSlotUtc: window.endExclusiveUtc,
      actualSlotUtc: slots[0]?.collectionSlotUtc ?? null,
      windowStartUtc: window.startUtc,
      windowEndExclusiveUtc: window.endExclusiveUtc,
      windowHours: window.windowHours,
      status: complete ? "success" : "partial",
      coverage: coverage.coverage,
      semantics: "measured_route_condition",
      disclaimer: "Route slots describe available HERE measurements; they are not destination predictions."
    });
  } catch (error) {
    return apiError(error);
  }
}
