import { apiError, apiJson } from "@/lib/api/response";
import { refreshDashboardCache } from "@/lib/snapshot/refresh-dashboard-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
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
