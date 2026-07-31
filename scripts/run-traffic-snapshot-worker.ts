import "dotenv/config";
import { closeRedisCache } from "@/lib/cache/redis-json";
import { closeMySqlPool } from "@/lib/db/mysql";
import { prewarmMobilityCache } from "@/lib/snapshot/prewarm-mobility-cache";
import { refreshDashboardCache } from "@/lib/snapshot/refresh-dashboard-cache";
import {
  createSnapshotWorkerHeartbeat,
  SNAPSHOT_WORKER_HEARTBEAT_INTERVAL_MS,
  type SnapshotWorkerHeartbeat,
  writeSnapshotWorkerHeartbeat
} from "@/lib/snapshot/worker-heartbeat";
import {
  nextAlignedRefreshDelayMs,
  nextSnapshotFailureDelayMs
} from "@/lib/snapshot/refresh-schedule";

const INTERVAL_MINUTES = 30;
const OFFSET_MINUTES = 12;

let stopping = false;
let wake: (() => void) | null = null;
let heartbeat: SnapshotWorkerHeartbeat = createSnapshotWorkerHeartbeat();
let heartbeatWrite: Promise<void> = Promise.resolve();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function publishHeartbeat(
  patch: Partial<Omit<SnapshotWorkerHeartbeat, "schemaVersion" | "workerId" | "startedAtUtc">> = {}
) {
  heartbeat = {
    ...heartbeat,
    ...patch,
    heartbeatAtUtc: new Date().toISOString()
  };
  const write = heartbeatWrite
    .catch(() => undefined)
    .then(() => writeSnapshotWorkerHeartbeat(heartbeat));
  heartbeatWrite = write;
  return write;
}

function wait(milliseconds: number) {
  if (stopping) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, milliseconds);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
}

function requestStop(signal: NodeJS.Signals) {
  stopping = true;
  void publishHeartbeat({ phase: "stopping", nextAttemptAtUtc: null }).catch(() => undefined);
  process.stdout.write(`${JSON.stringify({
    event: "traffic_snapshot_worker_stopping",
    signal,
    timestamp: new Date().toISOString()
  })}\n`);
  wake?.();
}

async function refreshOnce() {
  const startedAt = Date.now();
  const result = await refreshDashboardCache();
  if (!result.dashboard.trafficTiles) {
    throw new Error("The scheduled refresh did not publish a complete Redis snapshot.");
  }
  const pointer = result.dashboard.trafficTiles;
  process.stdout.write(`${JSON.stringify({
    event: "traffic_snapshot_refresh_succeeded",
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    cacheAction: result.cacheAction,
    version: pointer.version,
    sourceRunId: pointer.sourceRunId,
    slotUtc: pointer.slotUtc,
    features: pointer.featureCount,
    pulsePoints: pointer.pulsePointCount
  })}\n`);
  const publicCatchmentEnabled = process.env.MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED === "true";
  if (
    result.cacheAction === "rebuilt" &&
    (publicCatchmentEnabled || process.env.MOBILITY_CATCHMENT_SHADOW_UI_ENABLED === "true")
  ) {
    const prewarmStartedAt = Date.now();
    const mobility = await prewarmMobilityCache(publicCatchmentEnabled ? "public" : "internal");
    process.stdout.write(`${JSON.stringify({
      event: "mobility_cache_prewarm_succeeded",
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - prewarmStartedAt,
      ...mobility
    })}\n`);
  }
  return result;
}

async function main() {
  await publishHeartbeat().catch(() => undefined);
  heartbeatTimer = setInterval(() => {
    void publishHeartbeat().catch(() => undefined);
  }, SNAPSHOT_WORKER_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
  process.stdout.write(`${JSON.stringify({
    event: "traffic_snapshot_worker_started",
    timestamp: new Date().toISOString(),
    intervalMinutes: INTERVAL_MINUTES,
    offsetMinutes: OFFSET_MINUTES
  })}\n`);

  let consecutiveFailures = 0;
  while (!stopping) {
    const startedAt = Date.now();
    const attemptedAtUtc = new Date(startedAt).toISOString();
    let nextDelayMs: number;
    try {
      await publishHeartbeat({
        phase: "refreshing",
        lastAttemptAtUtc: attemptedAtUtc,
        nextAttemptAtUtc: null
      });
      const result = await refreshOnce();
      consecutiveFailures = 0;
      nextDelayMs = nextAlignedRefreshDelayMs(Date.now(), INTERVAL_MINUTES, OFFSET_MINUTES);
      await publishHeartbeat({
        phase: "waiting",
        consecutiveFailures,
        lastSuccessAtUtc: new Date().toISOString(),
        nextAttemptAtUtc: new Date(Date.now() + nextDelayMs).toISOString(),
        snapshotVersion: result.dashboard.trafficTiles?.version ?? heartbeat.snapshotVersion
      });
    } catch (error) {
      consecutiveFailures += 1;
      nextDelayMs = nextSnapshotFailureDelayMs(consecutiveFailures, INTERVAL_MINUTES);
      await publishHeartbeat({
        phase: "waiting",
        consecutiveFailures,
        lastFailureAtUtc: new Date().toISOString(),
        nextAttemptAtUtc: new Date(Date.now() + nextDelayMs).toISOString()
      }).catch(() => undefined);
      process.stderr.write(`${JSON.stringify({
        event: "traffic_snapshot_refresh_failed",
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        consecutiveFailures,
        retryInSeconds: nextDelayMs / 1000,
        error: error instanceof Error ? error.message : String(error)
      })}\n`);
    }
    if (stopping) break;
    await wait(nextDelayMs);
  }
}

process.once("SIGINT", () => requestStop("SIGINT"));
process.once("SIGTERM", () => requestStop("SIGTERM"));

main()
  .finally(async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await publishHeartbeat({ phase: "stopping", nextAttemptAtUtc: null }).catch(() => undefined);
    await Promise.all([closeMySqlPool(), closeRedisCache()]);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
