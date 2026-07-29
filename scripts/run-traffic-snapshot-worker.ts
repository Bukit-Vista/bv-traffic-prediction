import "dotenv/config";
import { getMySqlSourceDashboardData } from "@/lib/api/bootstrap";
import { closeRedisCache } from "@/lib/cache/redis-json";
import { closeMySqlPool } from "@/lib/db/mysql";
import { buildTrafficSnapshot } from "@/lib/snapshot/build-traffic-snapshot";
import { prewarmMobilityCache } from "@/lib/snapshot/prewarm-mobility-cache";
import { nextAlignedRefreshDelayMs } from "@/lib/snapshot/refresh-schedule";

const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_OFFSET_MINUTES = 12;
const MINIMUM_INTERVAL_MINUTES = 5;
const MAXIMUM_INTERVAL_MINUTES = 24 * 60;
const FAILURE_RETRY_MS = 60_000;

let stopping = false;
let wake: (() => void) | null = null;

function intervalMinutes(value = process.env.SNAPSHOT_REFRESH_INTERVAL_MINUTES) {
  if (value == null || value.trim() === "") {
    return DEFAULT_INTERVAL_MINUTES;
  }
  const minutes = Number(value);
  if (
    !Number.isInteger(minutes) ||
    minutes < MINIMUM_INTERVAL_MINUTES ||
    minutes > MAXIMUM_INTERVAL_MINUTES
  ) {
    throw new Error(
      `SNAPSHOT_REFRESH_INTERVAL_MINUTES must be an integer between ${MINIMUM_INTERVAL_MINUTES} and ${MAXIMUM_INTERVAL_MINUTES}.`
    );
  }
  return minutes;
}

function offsetMinutes(interval: number, value = process.env.SNAPSHOT_REFRESH_OFFSET_MINUTES) {
  if (value == null || value.trim() === "") {
    return Math.min(DEFAULT_OFFSET_MINUTES, interval - 1);
  }
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= interval) {
    throw new Error(
      "SNAPSHOT_REFRESH_OFFSET_MINUTES must be an integer from 0 up to one minute less than the refresh interval."
    );
  }
  return minutes;
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
  process.stdout.write(`${JSON.stringify({
    event: "traffic_snapshot_worker_stopping",
    signal,
    timestamp: new Date().toISOString()
  })}\n`);
  wake?.();
}

async function refreshOnce() {
  const startedAt = Date.now();
  const dashboard = await getMySqlSourceDashboardData();
  const pointer = await buildTrafficSnapshot(dashboard);
  process.stdout.write(`${JSON.stringify({
    event: "traffic_snapshot_refresh_succeeded",
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    version: pointer.version,
    sourceRunId: pointer.sourceRunId,
    slotUtc: pointer.slotUtc,
    features: pointer.featureCount,
    pulsePoints: pointer.pulsePointCount,
    tiles: pointer.tileCount
  })}\n`);
  const publicCatchmentEnabled = process.env.MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED === "true";
  if (publicCatchmentEnabled || process.env.MOBILITY_CATCHMENT_SHADOW_UI_ENABLED === "true") {
    const prewarmStartedAt = Date.now();
    const mobility = await prewarmMobilityCache(publicCatchmentEnabled ? "public" : "internal");
    process.stdout.write(`${JSON.stringify({
      event: "mobility_cache_prewarm_succeeded",
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - prewarmStartedAt,
      ...mobility
    })}\n`);
  }
}

async function main() {
  const interval = intervalMinutes();
  const offset = offsetMinutes(interval);
  const intervalMs = interval * 60_000;
  process.stdout.write(`${JSON.stringify({
    event: "traffic_snapshot_worker_started",
    timestamp: new Date().toISOString(),
    intervalMinutes: interval,
    offsetMinutes: offset
  })}\n`);

  while (!stopping) {
    const startedAt = Date.now();
    let succeeded = false;
    try {
      await refreshOnce();
      succeeded = true;
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        event: "traffic_snapshot_refresh_failed",
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        retryInSeconds: Math.min(intervalMs, FAILURE_RETRY_MS) / 1000,
        error: error instanceof Error ? error.message : String(error)
      })}\n`);
    }
    if (stopping) break;
    const nextDelayMs = succeeded
      ? nextAlignedRefreshDelayMs(Date.now(), interval, offset)
      : Math.min(intervalMs, FAILURE_RETRY_MS);
    await wait(nextDelayMs);
  }
}

process.once("SIGINT", () => requestStop("SIGINT"));
process.once("SIGTERM", () => requestStop("SIGTERM"));

main()
  .finally(() => Promise.all([closeMySqlPool(), closeRedisCache()]))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
