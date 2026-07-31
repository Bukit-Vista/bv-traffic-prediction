import { describe, expect, it, vi } from "vitest";
import type { RedisCacheStore } from "@/lib/cache/redis-json";
import {
  acquireRedisLease,
  releaseRedisLease,
  renewRedisLease
} from "@/lib/cache/redis-lease";

function leaseStore() {
  const values = new Map<string, string>();
  const store: RedisCacheStore = {
    get: vi.fn(async (key) => values.get(key) ?? null),
    set: vi.fn(async (key, value, options) => {
      if (options?.NX && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key) => values.delete(key) ? 1 : 0),
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

describe("owner-safe Redis lease", () => {
  it("renews and releases only for the owning token", async () => {
    const { store, values } = leaseStore();
    const lease = await acquireRedisLease(store, "refresh-lock", 900, "owner-a");
    expect(lease).not.toBeNull();
    expect(await acquireRedisLease(store, "refresh-lock", 900, "owner-b")).toBeNull();
    expect(await renewRedisLease(store, lease!)).toBe(true);

    values.set("refresh-lock", "owner-b");
    expect(await renewRedisLease(store, lease!)).toBe(false);
    expect(await releaseRedisLease(store, lease!)).toBe(false);
    expect(values.get("refresh-lock")).toBe("owner-b");
  });

  it("removes the lease when the current owner releases it", async () => {
    const { store, values } = leaseStore();
    const lease = await acquireRedisLease(store, "refresh-lock", 900, "owner-a");
    expect(await releaseRedisLease(store, lease!)).toBe(true);
    expect(values.has("refresh-lock")).toBe(false);
  });
});
