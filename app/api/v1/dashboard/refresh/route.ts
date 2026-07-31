import { apiError, apiJson } from "@/lib/api/response";
import { enforceRateLimit, requireOperationsRole } from "@/lib/api/access-control";
import { refreshDashboardCache } from "@/lib/snapshot/refresh-dashboard-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireOperationsRole(request);
    enforceRateLimit(request, "dashboard-manual-refresh", {
      maximum: 2,
      windowMs: 5 * 60_000
    });
    const result = await refreshDashboardCache();
    const response = apiJson(result, {
      ...result.dashboard.meta,
      source: result.cacheAction === "live_fallback" ? "here_mysql" : "here_snapshot_redis"
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return apiError(error);
  }
}
