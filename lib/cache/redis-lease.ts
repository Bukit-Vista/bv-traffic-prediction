import { randomUUID } from "node:crypto";
import type { RedisCacheStore } from "@/lib/cache/redis-json";

const RENEW_IF_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_IF_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export type RedisLease = {
  key: string;
  owner: string;
  ttlSeconds: number;
};

function evaluator(store: RedisCacheStore) {
  if (!store.eval) throw new Error("Redis scripting is required for an owner-safe refresh lease.");
  return store.eval.bind(store);
}

export async function acquireRedisLease(
  store: RedisCacheStore,
  key: string,
  ttlSeconds: number,
  owner: string = randomUUID()
): Promise<RedisLease | null> {
  const acquired = await store.set(key, owner, { EX: ttlSeconds, NX: true });
  return acquired === "OK" ? { key, owner, ttlSeconds } : null;
}

export async function renewRedisLease(store: RedisCacheStore, lease: RedisLease) {
  const result = await evaluator(store)(RENEW_IF_OWNER, {
    keys: [lease.key],
    arguments: [lease.owner, String(lease.ttlSeconds)]
  });
  return Number(result) === 1;
}

export async function releaseRedisLease(store: RedisCacheStore, lease: RedisLease) {
  const result = await evaluator(store)(RELEASE_IF_OWNER, {
    keys: [lease.key],
    arguments: [lease.owner]
  });
  return Number(result) === 1;
}

export function maintainRedisLease(
  store: RedisCacheStore,
  lease: RedisLease,
  intervalMs: number
) {
  let stopped = false;
  let lost: Error | null = null;
  let renewal: Promise<void> | null = null;

  const renew = () => {
    if (stopped || renewal) return;
    renewal = renewRedisLease(store, lease)
      .then((owned) => {
        if (!owned) lost = new Error("Dashboard refresh lease ownership was lost.");
      })
      .catch(() => {
        lost = new Error("Dashboard refresh lease could not be renewed.");
      })
      .finally(() => {
        renewal = null;
      });
  };
  const timer = setInterval(renew, intervalMs);
  timer.unref?.();

  return {
    assertOwned: async () => {
      if (lost) throw lost;
      if (!(await renewRedisLease(store, lease))) {
        lost = new Error("Dashboard refresh lease ownership was lost.");
        throw lost;
      }
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await renewal;
      await releaseRedisLease(store, lease).catch(() => false);
    }
  };
}
