import { apiError, apiJson } from "@/lib/api/response";
import { queryRows } from "@/lib/db/mysql";
import { redisCacheHealth } from "@/lib/cache/redis-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [databaseCheck, redisCheck] = await Promise.allSettled([
      queryRows<{ database_ok: number }>("SELECT 1 AS database_ok"),
      redisCacheHealth()
    ]);
    const database = databaseCheck.status === "fulfilled" &&
      databaseCheck.value[0]?.database_ok === 1 ? "ok" : "unavailable";
    const redis = redisCheck.status === "fulfilled"
      ? redisCheck.value
      : { status: "unavailable" as const, required: true };
    const healthy = database === "ok" && (!redis.required || redis.status === "ok");
    return apiJson({ application: healthy ? "ok" : "unavailable", database, redis: redis.status }, {
      source: "application_health",
      status: healthy ? "success" : "unavailable",
      disclaimer: "This check does not contact HERE or run a collection."
    }, { status: healthy ? 200 : 503 });
  } catch (error) {
    return apiError(error);
  }
}
