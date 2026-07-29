import "dotenv/config";
import { getMySqlSourceDashboardData } from "@/lib/api/bootstrap";
import { closeMySqlPool } from "@/lib/db/mysql";
import { buildTrafficSnapshot } from "@/lib/snapshot/build-traffic-snapshot";
import { closeRedisCache } from "@/lib/cache/redis-json";

async function main() {
  const dashboard = await getMySqlSourceDashboardData();
  const pointer = await buildTrafficSnapshot(dashboard);
  process.stdout.write(`${JSON.stringify({
    status: "ready",
    version: pointer.version,
    sourceRunId: pointer.sourceRunId,
    slotUtc: pointer.slotUtc,
    features: pointer.featureCount,
    pulsePoints: pointer.pulsePointCount,
    tiles: pointer.tileCount
  }, null, 2)}\n`);
}

main()
  .finally(() => Promise.all([closeMySqlPool(), closeRedisCache()]))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
