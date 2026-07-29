import { apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { getFlowSlots } from "@/lib/api/data-source";
import { coverageForSlots, expectedSlots, resolveMvpUtcWindow } from "@/lib/api/mvp-window";
import { mvpWindowQuerySchema, parseQuery } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(mvpWindowQuerySchema, request);
    const window = resolveMvpUtcWindow(input);
    const slots = await getFlowSlots(window.startUtc, window.endExclusiveUtc);
    const expected = expectedSlots(window, 30);
    const coverage = coverageForSlots(expected, slots.map((slot) => slot.slotUtc));
    const passedSlots = slots.filter((slot) => slot.status === "success" && slot.coverage === 1).length;
    const complete = coverage.presentSlots === expected.length && passedSlots === expected.length;
    const etag = createResourceEtag("flow-slots", { slots, window }, input);
    const cached = conditionalNotModified(request, etag);
    if (cached) return cached;
    return applyConditionalHeaders(apiJson({ slots, intervalMinutes: 30, window, coverage: { ...coverage, passedSlots } }, {
      selectedSlot: slots[0]?.slotUtc ?? null,
      slotUtc: slots[0]?.slotUtc ?? null,
      sourceRunId: slots[0]?.sourceRunId ?? null,
      requestedSlotUtc: window.endExclusiveUtc,
      actualSlotUtc: slots[0]?.slotUtc ?? null,
      windowStartUtc: window.startUtc,
      windowEndExclusiveUtc: window.endExclusiveUtc,
      windowHours: window.windowHours,
      status: complete ? "success" : "partial",
      coverage: coverage.coverage,
      source: "traffic_flow_collection_runs",
      semantics: "measured_traffic"
    }), etag);
  } catch (error) {
    return apiError(error);
  }
}
