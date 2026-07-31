import { describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { makeMeta } from "@/lib/api/response";
import type { RedisCacheStore } from "@/lib/cache/redis-json";
import type { SourceDashboardData } from "@/lib/dashboard/types";
import { buildTrafficSnapshot } from "@/lib/snapshot/build-traffic-snapshot";
import { ensureLatestTrafficSnapshot } from "@/lib/snapshot/ensure-traffic-snapshot";
import {
  readCurrentDashboardSnapshot,
  readTrafficSnapshotPointer,
  readTrafficVectorTile,
  trafficSnapshotManifestKey,
  trafficSnapshotReadiness,
  trafficSnapshotPointerKey
} from "@/lib/snapshot/traffic-snapshot";

function tileX(longitude: number, zoom: number) {
  return Math.floor((longitude + 180) / 360 * 2 ** zoom);
}

function tileY(latitude: number, zoom: number) {
  const radians = latitude * Math.PI / 180;
  return Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * 2 ** zoom);
}

function memoryStore() {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; value: string; ttl: number | null }> = [];
  const expirations: Array<{ key: string; ttl: number }> = [];
  const store: RedisCacheStore = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, options?: { EX?: number }) => {
      values.set(key, value);
      writes.push({ key, value, ttl: options?.EX ?? null });
      return "OK";
    }),
    del: vi.fn(async (key: string) => values.delete(key)),
    expire: vi.fn(async (key: string, ttl: number) => {
      expirations.push({ key, ttl });
      return values.has(key) ? 1 : 0;
    }),
    ping: vi.fn(async () => "PONG")
  };
  return { store, values, writes, expirations };
}

function cacheEnv() {
  return {
    REDIS_URL: "redis://cache.internal:6379",
    REDIS_CACHE_ENABLED: "true",
    REDIS_CACHE_NAMESPACE: "traffic-test",
    REDIS_TRAFFIC_CACHE_MODE: "require",
    REDIS_TRAFFIC_SNAPSHOT_TTL_SECONDS: "3600"
  };
}

function dashboard(): SourceDashboardData {
  const slotUtc = "2026-07-19T10:00:00.000Z";
  return {
    generatedAt: slotUtc,
    versions: {
      flow: "flow-v1",
      routes: "routes-v1",
      flowHealth: "flow-health-v1",
      routeHealth: "route-health-v1"
    },
    flow: {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        id: "segment-1",
        geometry: { type: "LineString", coordinates: [[114.99, -8.5], [115.05, -8.5]] },
        properties: {
          segmentId: 1,
          segmentKey: "segment-1",
          roadName: "Snapshot Road",
          functionalClass: 2,
          lengthMeters: 6600,
          collectionSlotUtc: slotUtc,
          sourceUpdatedUtc: slotUtc,
          fetchedAtUtc: slotUtc,
          speedKph: 18,
          freeFlowKph: 40,
          relativeSpeed: 0.45,
          jamFactor: 7,
          jamTendency: 0,
          confidence: 0.9,
          traversability: "open",
          roadClosure: false
        }
      }]
    },
    trafficOverview: {
      weightedJamFactor: 7,
      congestedRoadShare: 1,
      closures: 0,
      slowestRoute: null,
      measuredLengthMeters: 6600,
      coverage: 1
    },
    routes: [],
    slots: [{ slotUtc, sourceRunId: "91", status: "success", coverage: 1 }],
    flowRuns: [],
    routeRuns: [],
    meta: makeMeta({
      slotUtc,
      sourceRunId: "91",
      source: "here_flow_mysql",
      status: "success",
      coverage: 1,
      semantics: "measured_traffic"
    })
  };
}

describe("immutable Redis traffic cache", () => {
  it("builds, atomically activates, reads, and serves a compressed vector tile", async () => {
    const { store, values, writes } = memoryStore();
    const env = cacheEnv();
    const pointer = await buildTrafficSnapshot(dashboard(), {
      env,
      store,
      minZoom: 7,
      maxZoom: 8
    });

    expect(pointer.tileCount).toBeGreaterThan(0);
    const activePointer = await readTrafficSnapshotPointer(env, store);
    expect(activePointer?.version).toBe(pointer.version);
    expect(activePointer?.versions).toEqual(dashboard().versions);
    expect(writes.at(-1)?.key).toBe(trafficSnapshotPointerKey(env));
    expect(writes.every((write) => write.ttl == null)).toBe(true);
    expect(values.has(trafficSnapshotManifestKey(pointer.version, env))).toBe(true);
    expect(await trafficSnapshotReadiness(env, store)).toMatchObject({
      status: "ok",
      reason: "ready",
      version: pointer.version
    });

    const restored = await readCurrentDashboardSnapshot(env, store);
    expect(restored?.meta.sourceRunId).toBe("91");
    expect(restored?.meta.source).toBe("here_snapshot_redis");
    expect(restored?.trafficTiles?.version).toBe(pointer.version);
    expect(restored?.flow.features).toHaveLength(0);
    expect(restored?.trafficOverviewByConfidence?.["0.90"]?.weightedJamFactor).toBe(7);

    const zoom = 7;
    const tile = await readTrafficVectorTile(
      pointer.version,
      zoom,
      tileX(115, zoom),
      tileY(-8.5, zoom),
      env,
      store
    );
    expect(tile).not.toBeNull();
    expect(gunzipSync(tile!).byteLength).toBeGreaterThan(0);
    expect(await readTrafficVectorTile("../invalid", zoom, 0, 0, env, store)).toBeNull();
  });

  it("materializes once for concurrent requests and reuses the Redis version", async () => {
    const { store } = memoryStore();
    const env = cacheEnv();

    expect(await readCurrentDashboardSnapshot(env, store)).toBeNull();
    const [first, concurrent] = await Promise.all([
      ensureLatestTrafficSnapshot(dashboard(), env, store),
      ensureLatestTrafficSnapshot(dashboard(), env, store)
    ]);

    expect(first?.meta.sourceRunId).toBe("91");
    expect(concurrent?.trafficTiles?.version).toBe(first?.trafficTiles?.version);
    expect((await readCurrentDashboardSnapshot(env, store))?.trafficTiles?.version)
      .toBe(first?.trafficTiles?.version);
  });

  it("keeps the active version persistent and retires the replaced version", async () => {
    const { store, values, expirations } = memoryStore();
    const env = cacheEnv();
    const first = await buildTrafficSnapshot(dashboard(), { env, store, minZoom: 7, maxZoom: 7 });
    const firstKeys = [...values.keys()].filter((key) => key.includes(first.version));

    const latestDashboard: SourceDashboardData = {
      ...dashboard(),
      slots: [{ ...dashboard().slots[0], sourceRunId: "92" }],
      meta: { ...dashboard().meta, sourceRunId: "92" }
    };
    const latest = await buildTrafficSnapshot(latestDashboard, {
      env,
      store,
      minZoom: 7,
      maxZoom: 7
    });

    expect(latest.version).not.toBe(first.version);
    expect(firstKeys.every((key) => values.has(key))).toBe(true);
    expect(firstKeys.every((key) =>
      expirations.some((expiration) => expiration.key === key && expiration.ttl === 3600)
    )).toBe(true);
    expect(expirations.some((expiration) =>
      expiration.key === trafficSnapshotManifestKey(first.version, env)
    )).toBe(true);
    expect((await readTrafficSnapshotPointer(env, store))?.version).toBe(latest.version);
    expect(await trafficSnapshotReadiness(env, store)).toMatchObject({
      status: "ok",
      version: latest.version
    });
  });

  it("reports an incomplete active version as unavailable", async () => {
    const { store, values } = memoryStore();
    const env = cacheEnv();
    const pointer = await buildTrafficSnapshot(dashboard(), {
      env,
      store,
      minZoom: 7,
      maxZoom: 7
    });
    values.delete(trafficSnapshotManifestKey(pointer.version, env));
    expect(await trafficSnapshotReadiness(env, store)).toEqual({
      status: "unavailable",
      reason: "manifest_missing",
      version: pointer.version,
      createdAtUtc: pointer.createdAtUtc
    });
  });

  it("rebuilds a matching legacy snapshot into the persistent manifest format", async () => {
    const { store, values, writes } = memoryStore();
    const env = cacheEnv();
    const pointer = await buildTrafficSnapshot(dashboard(), {
      env,
      store,
      minZoom: 7,
      maxZoom: 7
    });
    values.delete(trafficSnapshotManifestKey(pointer.version, env));
    const writesBeforeRepair = writes.length;

    const repaired = await ensureLatestTrafficSnapshot(dashboard(), env, store);

    expect(repaired?.trafficTiles?.version).toBe(pointer.version);
    expect(writes.length).toBeGreaterThan(writesBeforeRepair);
    expect(await trafficSnapshotReadiness(env, store)).toMatchObject({
      status: "ok",
      reason: "ready",
      version: pointer.version
    });
  });
});
