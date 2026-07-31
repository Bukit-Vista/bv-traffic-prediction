import { describe, expect, it, vi } from "vitest";
import {
  getRedisCacheConfig,
  redisJsonCacheKey,
  withRedisJsonCache
} from "@/lib/cache/redis-json";

function cacheEnv(overrides: Record<string, string> = {}) {
  return {
    REDIS_URL: "redis://cache.internal:6379",
    REDIS_CACHE_ENABLED: "true",
    ...overrides
  };
}

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => values.delete(key)),
    ping: vi.fn(async () => "PONG")
  };
}

describe("Redis JSON cache", () => {
  it("uses stable scoped keys without exposing the Redis URL", () => {
    const env = cacheEnv({ REDIS_CACHE_NAMESPACE: "traffic-prod" });
    const first = redisJsonCacheKey("flow-map", { run: 7, slot: "a" }, { bbox: [1, 2, 3, 4] }, env);
    const reordered = redisJsonCacheKey("flow-map", { slot: "a", run: 7 }, { bbox: [1, 2, 3, 4] }, env);
    expect(first).toBe(reordered);
    expect(first).toMatch(/^traffic-prod:json:flow-map:/);
    expect(first).not.toContain("cache.internal");
  });

  it("compresses a miss, writes it with a TTL, and serves the next read", async () => {
    const store = memoryStore();
    const loader = vi.fn(async () => ({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[115, -8], [115.1, -8.1]] } }]
    }));
    const options = { resource: "geojson", identity: { slot: 1 }, freshness: "historical" as const };
    const dependencies = { env: cacheEnv(), store };

    const first = await withRedisJsonCache(options, loader, dependencies);
    const second = await withRedisJsonCache(options, loader, dependencies);

    expect(second).toEqual(first);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^gz1:/), { EX: 86_400 });
  });

  it("coalesces concurrent cache misses in one process", async () => {
    const store = memoryStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = vi.fn(async () => {
      await blocked;
      return { ok: true };
    });
    const dependencies = { env: cacheEnv(), store };
    const options = { resource: "single-flight", identity: "current" };

    const first = withRedisJsonCache(options, loader, dependencies);
    const second = withRedisJsonCache(options, loader, dependencies);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true }
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("skips values above the compressed per-entry limit", async () => {
    const store = memoryStore();
    const randomPayload = Array.from({ length: 10_000 }, (_, index) =>
      `${index.toString(36)}-${Math.random().toString(36)}`
    ).join("|");
    await withRedisJsonCache(
      { resource: "large", identity: 1 },
      async () => ({ randomPayload }),
      { env: cacheEnv({ REDIS_CACHE_MAX_VALUE_BYTES: "1024" }), store }
    );
    expect(store.set).not.toHaveBeenCalled();
  });

  it("falls back safely when Redis reads and writes fail", async () => {
    const store = memoryStore();
    store.get.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "ECONNREFUSED" }));
    store.set.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "ECONNREFUSED" }));
    const result = await withRedisJsonCache(
      { resource: "flow", identity: 2 },
      async () => ({ ok: true }),
      { env: cacheEnv(), store }
    );
    expect(result).toEqual({ ok: true });
  });

  it("reports an explicitly enabled cache without a URL as misconfigured", () => {
    expect(getRedisCacheConfig({ REDIS_CACHE_ENABLED: "true" })).toMatchObject({
      enabled: false,
      misconfigured: true
    });
  });
});
