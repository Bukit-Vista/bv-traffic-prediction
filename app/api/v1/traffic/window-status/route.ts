import { apiError, apiJson } from "@/lib/api/response";
import { applyConditionalHeaders, conditionalNotModified, createResourceEtag } from "@/lib/api/conditional-cache";
import { getMvpWindowStatus } from "@/lib/api/data-source";
import { resolveMvpUtcWindow } from "@/lib/api/mvp-window";
import { mvpWindowQuerySchema, parseQuery } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(mvpWindowQuerySchema, request);
    const window = resolveMvpUtcWindow(input);
    const result = await getMvpWindowStatus(window);
    const cacheControl = "private, max-age=30, must-revalidate";
    const etag = createResourceEtag("traffic-mvp-window-status", result);
    const cached = conditionalNotModified(request, etag, cacheControl);
    if (cached) return cached;
    return applyConditionalHeaders(apiJson({ flow: result.flow, routes: result.routes }, {
      source: "here_mysql_12_hour_window",
      requestedSlotUtc: window.endExclusiveUtc,
      actualSlotUtc: null,
      windowStartUtc: window.startUtc,
      windowEndExclusiveUtc: window.endExclusiveUtc,
      windowHours: window.windowHours,
      status: result.status,
      coverage: Math.min(result.flow.coverage, result.routes.coverage),
      stale: false,
      isFallback: false,
      semantics: "measured_traffic",
      disclaimer: "This dashboard displays HERE-derived road traffic and selected-route conditions. It does not measure people, tourists, vehicles, or actual trips."
    }), etag, cacheControl);
  } catch (error) {
    return apiError(error);
  }
}
