import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { RedisCacheStore } from "@/lib/cache/redis-json";
import {
  REFRESH_LEASE_SECONDS,
  manualRefreshLockKey,
  performDashboardRefresh
} from "@/lib/snapshot/refresh-dashboard-cache";

function refreshStore() {
  const values = new Map<string, string>();
  const store: RedisCacheStore = {
    get: vi.fn(async (key) => values.get(key) ?? null),
    set: vi.fn(async (key, value, options) => {
      if (options?.NX && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key) => values.delete(key)),
    expire: vi.fn(async (key) => values.has(key) ? 1 : 0),
    eval: vi.fn(async (script, options) => {
      const [key] = options.keys;
      const [owner] = options.arguments;
      if (values.get(key) !== owner) return 0;
      if (script.includes("EXPIRE")) return 1;
      if (script.includes("DEL")) {
        values.delete(key);
        return 1;
      }
      return 0;
    }),
    ping: vi.fn(async () => "PONG")
  };
  return { store, values };
}

const env = {
  REDIS_URL: "redis://cache.internal:6379",
  REDIS_CACHE_ENABLED: "true",
  REDIS_CACHE_NAMESPACE: "traffic-test"
};

const current = {
  generatedAt: "2026-07-31T08:00:00.000Z",
  versions: { flow: "f", routes: "r", flowHealth: "fh", routeHealth: "rh" },
  routes: [],
  flowRuns: [],
  routeRuns: [],
  meta: {
    sourceRunId: "7",
    slotUtc: "2026-07-31T08:00:00.000Z",
    status: "success",
    stale: false
  }
};

const identities = {
  flow: {
    id: 7,
    slotUtc: "2026-07-31T08:00:00.000Z",
    status: "success",
    stale: false
  },
  routes: { stale: false, routes: [] },
  flowHealth: null,
  routeHealth: null
};

describe("manual dashboard refresh safety", () => {
  it("uses a shared namespaced Redis lock", () => {
    expect(manualRefreshLockKey({
      REDIS_CACHE_NAMESPACE: "traffic-production"
    })).toBe("traffic-production:locks:dashboard-manual-refresh");
  });

  it("uses a bounded cross-process refresh lease", () => {
    expect(REFRESH_LEASE_SECONDS).toBe(15 * 60);
  });

  it("uses only source identities when the complete Redis snapshot is current", async () => {
    const { store, values } = refreshStore();
    const loadLive = vi.fn();
    const ensureSnapshot = vi.fn();

    await expect(performDashboardRefresh({
      env,
      store,
      readCurrent: vi.fn(async () => current as never),
      readiness: vi.fn(async () => ({ status: "ok", reason: "ready" }) as never),
      loadIdentities: vi.fn(async () => identities as never),
      loadLive,
      ensureSnapshot
    })).resolves.toMatchObject({ cacheAction: "reused" });

    expect(loadLive).not.toHaveBeenCalled();
    expect(ensureSnapshot).not.toHaveBeenCalled();
    expect(values.has(manualRefreshLockKey(env))).toBe(false);
  });

  it("fails closed and releases the lease when publication does not complete", async () => {
    const { store, values } = refreshStore();
    const live = { ...current, meta: { ...current.meta, sourceRunId: "8" } };

    await expect(performDashboardRefresh({
      env,
      store,
      readCurrent: vi.fn(async () => null),
      readiness: vi.fn(),
      loadIdentities: vi.fn(),
      loadLive: vi.fn(async () => live as never),
      ensureSnapshot: vi.fn(async () => null)
    })).rejects.toThrow("did not publish a complete Redis snapshot");

    expect(values.has(manualRefreshLockKey(env))).toBe(false);
  });
});
