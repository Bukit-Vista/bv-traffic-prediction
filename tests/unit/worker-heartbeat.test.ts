import { describe, expect, it, vi } from "vitest";
import type { RedisCacheStore } from "@/lib/cache/redis-json";
import {
  createSnapshotWorkerHeartbeat,
  SNAPSHOT_WORKER_STALE_AFTER_MS,
  snapshotWorkerHeartbeatHealth,
  snapshotWorkerHeartbeatKey,
  writeSnapshotWorkerHeartbeat
} from "@/lib/snapshot/worker-heartbeat";

function heartbeatStore() {
  const values = new Map<string, string>();
  const store: RedisCacheStore = {
    get: vi.fn(async (key) => values.get(key) ?? null),
    set: vi.fn(async (key, value) => {
      values.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key) => values.delete(key)),
    ping: vi.fn(async () => "PONG")
  };
  return { store, values };
}

const env = {
  REDIS_URL: "redis://cache.internal:6379",
  REDIS_CACHE_ENABLED: "true",
  REDIS_CACHE_NAMESPACE: "traffic-test"
};

describe("snapshot worker heartbeat", () => {
  it("writes a namespaced heartbeat and reports a live worker", async () => {
    const now = Date.parse("2026-07-31T09:00:00.000Z");
    const heartbeat = createSnapshotWorkerHeartbeat(now);
    const { store, values } = heartbeatStore();

    await writeSnapshotWorkerHeartbeat(heartbeat, env, store);

    expect(values.has(snapshotWorkerHeartbeatKey(env))).toBe(true);
    await expect(snapshotWorkerHeartbeatHealth(env, store, now)).resolves.toMatchObject({
      status: "ok",
      heartbeat: { workerId: heartbeat.workerId, phase: "starting" }
    });
  });

  it("reports stale, missing, and malformed heartbeats", async () => {
    const now = Date.parse("2026-07-31T09:00:00.000Z");
    const { store, values } = heartbeatStore();
    expect(await snapshotWorkerHeartbeatHealth(env, store, now)).toEqual({
      status: "missing",
      heartbeat: null
    });

    const heartbeat = createSnapshotWorkerHeartbeat(now - SNAPSHOT_WORKER_STALE_AFTER_MS - 1);
    await writeSnapshotWorkerHeartbeat(heartbeat, env, store);
    expect((await snapshotWorkerHeartbeatHealth(env, store, now)).status).toBe("stale");

    values.set(snapshotWorkerHeartbeatKey(env), "not-json");
    expect((await snapshotWorkerHeartbeatHealth(env, store, now)).status).toBe("invalid");
  });
});
