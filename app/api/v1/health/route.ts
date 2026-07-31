import { apiError, apiJson } from "@/lib/api/response";
import { redisCacheHealth } from "@/lib/cache/redis-json";
import { trafficSnapshotReadiness } from "@/lib/snapshot/traffic-snapshot";
import { snapshotWorkerHeartbeatHealth } from "@/lib/snapshot/worker-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [redisCheck, snapshotCheck, workerCheck] = await Promise.allSettled([
      redisCacheHealth(),
      trafficSnapshotReadiness(),
      snapshotWorkerHeartbeatHealth()
    ]);
    const redis = redisCheck.status === "fulfilled"
      ? redisCheck.value
      : { status: "unavailable" as const, required: true };
    const snapshot = snapshotCheck.status === "fulfilled"
      ? snapshotCheck.value
      : { status: "unavailable" as const, reason: "pointer_missing" as const, version: null, createdAtUtc: null };
    const worker = workerCheck.status === "fulfilled"
      ? workerCheck.value
      : { status: "missing" as const, heartbeat: null };
    const healthy = redis.status === "ok" && snapshot.status === "ok";
    const response = apiJson({
      application: healthy ? "ok" : "unavailable",
      database: "not_checked",
      redis: redis.status,
      snapshot,
      worker
    }, {
      source: "application_health",
      status: healthy ? "success" : "unavailable",
      disclaimer: "This readiness check uses Redis snapshot and worker-heartbeat data only; it does not query MySQL, contact HERE, or run a collection."
    }, { status: healthy ? 200 : 503 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return apiError(error);
  }
}
