import "dotenv/config";
import { closeRedisCache } from "@/lib/cache/redis-json";
import { snapshotWorkerHeartbeatHealth } from "@/lib/snapshot/worker-heartbeat";

snapshotWorkerHeartbeatHealth()
  .then((health) => {
    if (health.status !== "ok") process.exitCode = 1;
  })
  .catch(() => {
    process.exitCode = 1;
  })
  .finally(closeRedisCache);
