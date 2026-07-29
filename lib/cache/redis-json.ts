import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { createClient, type RedisClientType } from "redis";

const CACHE_VALUE_VERSION = "gz1";
const DEFAULT_LATEST_TTL_SECONDS = 60;
const DEFAULT_HISTORICAL_TTL_SECONDS = 86_400;
const DEFAULT_MAX_VALUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;

export type RedisCacheFreshness = "latest" | "historical";

export type RedisCacheEnv = {
  [key: string]: string | undefined;
  NODE_ENV?: string;
  REDIS_URL?: string;
  REDIS_CACHE_ENABLED?: string;
  REDIS_CACHE_REQUIRED?: string;
  REDIS_CACHE_NAMESPACE?: string;
  REDIS_CACHE_TTL_LATEST_SECONDS?: string;
  REDIS_CACHE_TTL_HISTORICAL_SECONDS?: string;
  REDIS_CACHE_MAX_VALUE_BYTES?: string;
  REDIS_CONNECT_TIMEOUT_MS?: string;
};

export type RedisCacheStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  ping(): Promise<string>;
};

type CacheDependencies = {
  env?: RedisCacheEnv;
  store?: RedisCacheStore | null;
};

export type RedisJsonCacheOptions = {
  resource: string;
  identity: unknown;
  scope?: unknown;
  freshness?: RedisCacheFreshness;
  ttlSeconds?: number;
};

let singletonClient: RedisClientType | null = null;
let connectingClient: Promise<RedisClientType> | null = null;
let lastWarningAt = 0;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function enabledFlag(value: string | undefined, fallback: boolean) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`
  ).join(",")}}`;
}

export function getRedisCacheConfig(env: RedisCacheEnv = process.env) {
  const url = env.REDIS_URL?.trim() || null;
  const explicitlyEnabled = enabledFlag(env.REDIS_CACHE_ENABLED, Boolean(url));
  const namespace = (env.REDIS_CACHE_NAMESPACE?.trim() || "bali-traffic")
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .slice(0, 80);
  return {
    url,
    enabled: explicitlyEnabled && Boolean(url),
    misconfigured: explicitlyEnabled && !url,
    required: enabledFlag(env.REDIS_CACHE_REQUIRED, false),
    namespace,
    latestTtlSeconds: boundedInteger(
      env.REDIS_CACHE_TTL_LATEST_SECONDS,
      DEFAULT_LATEST_TTL_SECONDS,
      1,
      86_400
    ),
    historicalTtlSeconds: boundedInteger(
      env.REDIS_CACHE_TTL_HISTORICAL_SECONDS,
      DEFAULT_HISTORICAL_TTL_SECONDS,
      60,
      7 * 86_400
    ),
    maxValueBytes: boundedInteger(
      env.REDIS_CACHE_MAX_VALUE_BYTES,
      DEFAULT_MAX_VALUE_BYTES,
      1_024,
      64 * 1024 * 1024
    ),
    connectTimeoutMs: boundedInteger(
      env.REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
      250,
      10_000
    )
  };
}

export function redisJsonCacheKey(
  resource: string,
  identity: unknown,
  scope: unknown = null,
  env: RedisCacheEnv = process.env
) {
  const config = getRedisCacheConfig(env);
  const digest = createHash("sha256")
    .update(stableSerialize({ version: CACHE_VALUE_VERSION, resource, identity, scope }))
    .digest("base64url");
  return `${config.namespace}:json:${resource}:${digest}`;
}

function warnCacheFailure(operation: string, error: unknown) {
  const now = Date.now();
  if (now - lastWarningAt < 30_000) return;
  lastWarningAt = now;
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "unknown";
  console.warn(`Redis cache ${operation} failed; using the source directly.`, { code });
}

export async function getRedisCacheStore(env: RedisCacheEnv = process.env): Promise<RedisCacheStore | null> {
  const config = getRedisCacheConfig(env);
  if (!config.enabled || !config.url) return null;
  if (singletonClient?.isReady) return singletonClient as RedisCacheStore;
  if (!singletonClient) {
    singletonClient = createClient({
      url: config.url,
      socket: {
        connectTimeout: config.connectTimeoutMs,
        // Bound initial request latency when Redis is unavailable. A later
        // request can establish a fresh connection after this attempt fails.
        reconnectStrategy: (retries) => retries >= 2 ? false : Math.min(50 * 2 ** retries, 500)
      }
    });
    singletonClient.on("error", (error) => warnCacheFailure("connection", error));
  }
  connectingClient ??= singletonClient.connect()
    .then(() => singletonClient as RedisClientType)
    .catch((error) => {
      connectingClient = null;
      throw error;
    });
  return connectingClient as Promise<RedisCacheStore>;
}

function encodeCacheValue(value: unknown, maximumCompressedBytes: number) {
  const serialized = Buffer.from(JSON.stringify(value));
  // Avoid doing synchronous compression work on a pathological response that
  // cannot reasonably fit after compression.
  if (serialized.byteLength > maximumCompressedBytes * 16) return null;
  const compressed = gzipSync(serialized, { level: 6 });
  return {
    byteLength: compressed.byteLength,
    encoded: `${CACHE_VALUE_VERSION}:${compressed.toString("base64")}`
  };
}

function decodeCacheValue<T>(encoded: string, maximumCompressedBytes: number): T {
  const [version, payload] = encoded.split(":", 2);
  if (version !== CACHE_VALUE_VERSION || !payload) {
    throw new Error("Unsupported Redis JSON cache value.");
  }
  const compressed = Buffer.from(payload, "base64");
  if (compressed.byteLength > maximumCompressedBytes) {
    throw new Error("Redis JSON cache value exceeds the configured limit.");
  }
  return JSON.parse(gunzipSync(compressed, {
    maxOutputLength: maximumCompressedBytes * 16
  }).toString("utf8")) as T;
}

/**
 * Best-effort read-through cache for JSON-compatible API values.
 *
 * Redis failures never hide an available MySQL result. Values are compressed and
 * skipped when their compressed size exceeds the configured per-entry ceiling.
 */
export async function withRedisJsonCache<T>(
  options: RedisJsonCacheOptions,
  loader: () => Promise<T>,
  dependencies: CacheDependencies = {}
): Promise<T> {
  const env = dependencies.env ?? process.env;
  const config = getRedisCacheConfig(env);
  if (!config.enabled) return loader();

  const key = redisJsonCacheKey(options.resource, options.identity, options.scope, env);
  let store: RedisCacheStore | null = dependencies.store ?? null;
  try {
    store ??= await getRedisCacheStore(env);
    const cached = await store?.get(key);
    if (cached) {
      try {
        return decodeCacheValue<T>(cached, config.maxValueBytes);
      } catch (error) {
        warnCacheFailure("decode", error);
        await store?.del(key).catch(() => undefined);
      }
    }
  } catch (error) {
    warnCacheFailure("read", error);
  }

  const value = await loader();
  if (!store) return value;

  try {
    const encoded = encodeCacheValue(value, config.maxValueBytes);
    if (encoded && encoded.byteLength <= config.maxValueBytes) {
      const ttlSeconds = options.ttlSeconds ?? (
        options.freshness === "historical"
          ? config.historicalTtlSeconds
          : config.latestTtlSeconds
      );
      await store.set(key, encoded.encoded, {
        EX: boundedInteger(String(ttlSeconds), config.latestTtlSeconds, 1, 7 * 86_400)
      });
    }
  } catch (error) {
    warnCacheFailure("write", error);
  }
  return value;
}

export async function redisCacheHealth(env: RedisCacheEnv = process.env) {
  const config = getRedisCacheConfig(env);
  if (config.misconfigured) return { status: "misconfigured" as const, required: config.required };
  if (!config.enabled) return { status: "disabled" as const, required: config.required };
  try {
    const store = await getRedisCacheStore(env);
    return {
      status: await store?.ping() === "PONG" ? "ok" as const : "unavailable" as const,
      required: config.required
    };
  } catch {
    return { status: "unavailable" as const, required: config.required };
  }
}

export async function closeRedisCache() {
  connectingClient = null;
  const client = singletonClient;
  singletonClient = null;
  if (client?.isOpen) await client.quit();
}
