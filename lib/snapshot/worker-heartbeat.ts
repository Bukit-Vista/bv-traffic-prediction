import { randomUUID } from "node:crypto";
import {
  getRedisCacheConfig,
  getRedisCacheStore,
  type RedisCacheEnv,
  type RedisCacheStore
} from "@/lib/cache/redis-json";

export const SNAPSHOT_WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const SNAPSHOT_WORKER_STALE_AFTER_MS = 3 * 60_000;
export const SNAPSHOT_WORKER_HEARTBEAT_TTL_SECONDS = 10 * 60;

export type SnapshotWorkerPhase = "starting" | "refreshing" | "waiting" | "stopping";

export type SnapshotWorkerHeartbeat = {
  schemaVersion: 1;
  workerId: string;
  startedAtUtc: string;
  heartbeatAtUtc: string;
  phase: SnapshotWorkerPhase;
  consecutiveFailures: number;
  lastAttemptAtUtc: string | null;
  lastSuccessAtUtc: string | null;
  lastFailureAtUtc: string | null;
  nextAttemptAtUtc: string | null;
  snapshotVersion: string | null;
};

export function snapshotWorkerHeartbeatKey(env: RedisCacheEnv = process.env) {
  return `${getRedisCacheConfig(env).namespace}:health:snapshot-worker`;
}

function validHeartbeat(value: unknown): value is SnapshotWorkerHeartbeat {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SnapshotWorkerHeartbeat>;
  return candidate.schemaVersion === 1 &&
    typeof candidate.workerId === "string" &&
    typeof candidate.startedAtUtc === "string" &&
    typeof candidate.heartbeatAtUtc === "string" &&
    ["starting", "refreshing", "waiting", "stopping"].includes(candidate.phase ?? "") &&
    Number.isInteger(candidate.consecutiveFailures) &&
    (candidate.snapshotVersion == null || typeof candidate.snapshotVersion === "string");
}

export async function writeSnapshotWorkerHeartbeat(
  heartbeat: SnapshotWorkerHeartbeat,
  env: RedisCacheEnv = process.env,
  suppliedStore?: RedisCacheStore | null
) {
  const store = suppliedStore ?? await getRedisCacheStore(env);
  if (!store) throw new Error("Redis is required for the snapshot worker heartbeat.");
  await store.set(
    snapshotWorkerHeartbeatKey(env),
    JSON.stringify(heartbeat),
    { EX: SNAPSHOT_WORKER_HEARTBEAT_TTL_SECONDS }
  );
}

export async function snapshotWorkerHeartbeatHealth(
  env: RedisCacheEnv = process.env,
  suppliedStore?: RedisCacheStore | null,
  nowMs = Date.now()
) {
  const store = suppliedStore ?? await getRedisCacheStore(env);
  if (!store) return { status: "missing" as const, heartbeat: null };
  const encoded = await store.get(snapshotWorkerHeartbeatKey(env));
  if (!encoded) return { status: "missing" as const, heartbeat: null };
  try {
    const heartbeat: unknown = JSON.parse(encoded);
    if (!validHeartbeat(heartbeat)) {
      return { status: "invalid" as const, heartbeat: null };
    }
    const heartbeatMs = Date.parse(heartbeat.heartbeatAtUtc);
    if (!Number.isFinite(heartbeatMs)) {
      return { status: "invalid" as const, heartbeat: null };
    }
    return {
      status: nowMs - heartbeatMs <= SNAPSHOT_WORKER_STALE_AFTER_MS
        ? "ok" as const
        : "stale" as const,
      heartbeat
    };
  } catch {
    return { status: "invalid" as const, heartbeat: null };
  }
}

export function createSnapshotWorkerHeartbeat(nowMs = Date.now()) {
  const startedAtUtc = new Date(nowMs).toISOString();
  return {
    schemaVersion: 1 as const,
    workerId: randomUUID(),
    startedAtUtc,
    heartbeatAtUtc: startedAtUtc,
    phase: "starting" as SnapshotWorkerPhase,
    consecutiveFailures: 0,
    lastAttemptAtUtc: null,
    lastSuccessAtUtc: null,
    lastFailureAtUtc: null,
    nextAttemptAtUtc: null,
    snapshotVersion: null
  } satisfies SnapshotWorkerHeartbeat;
}
