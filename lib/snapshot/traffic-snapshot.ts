import { gunzipSync, gzipSync } from "node:zlib";
import {
  getRedisCacheConfig,
  getRedisCacheStore,
  type RedisCacheEnv,
  type RedisCacheStore
} from "@/lib/cache/redis-json";
import type {
  DashboardResourceVersions,
  SourceDashboardData,
  TrafficTileSnapshot
} from "@/lib/dashboard/types";

export const TRAFFIC_SNAPSHOT_SCHEMA_VERSION = 3;
const VERSION_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const DEFAULT_SNAPSHOT_TTL_SECONDS = 2 * 24 * 60 * 60;
const DEFAULT_MAX_DASHBOARD_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 320 * 1024 * 1024;

export type TrafficSnapshotMode = "off" | "prefer" | "require";

export type TrafficSnapshotPointer = TrafficTileSnapshot & {
  schemaVersion: number;
  createdAtUtc: string;
  tileCount: number;
  versions: DashboardResourceVersions;
};

export type TrafficSnapshotManifest = {
  schemaVersion: number;
  version: string;
  dashboardKey: string;
  tileKeys: string[];
};

export type TrafficSnapshotReadiness = {
  status: "ok" | "unavailable";
  reason: "ready" | "pointer_missing" | "manifest_missing" | "manifest_invalid" |
    "dashboard_missing" | "dashboard_invalid" | "tile_missing";
  version: string | null;
  createdAtUtc: string | null;
};

export type TrafficSnapshotEnv = RedisCacheEnv & {
  REDIS_TRAFFIC_CACHE_MODE?: string;
  REDIS_TRAFFIC_SNAPSHOT_TTL_SECONDS?: string;
  REDIS_TRAFFIC_MAX_DASHBOARD_BYTES?: string;
  REDIS_TRAFFIC_MAX_TILE_BYTES?: string;
  REDIS_TRAFFIC_MAX_TOTAL_BYTES?: string;
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function trafficSnapshotMode(env: TrafficSnapshotEnv = process.env): TrafficSnapshotMode {
  const configured = env.REDIS_TRAFFIC_CACHE_MODE?.trim().toLowerCase();
  if (configured === "off" || configured === "require") return configured;
  return "prefer";
}

export function trafficSnapshotConfig(env: TrafficSnapshotEnv = process.env) {
  const redis = getRedisCacheConfig(env);
  return {
    ...redis,
    mode: trafficSnapshotMode(env),
    ttlSeconds: boundedInteger(
      env.REDIS_TRAFFIC_SNAPSHOT_TTL_SECONDS,
      DEFAULT_SNAPSHOT_TTL_SECONDS,
      60,
      7 * 24 * 60 * 60
    ),
    maxDashboardBytes: boundedInteger(
      env.REDIS_TRAFFIC_MAX_DASHBOARD_BYTES,
      DEFAULT_MAX_DASHBOARD_BYTES,
      1024,
      64 * 1024 * 1024
    ),
    maxTileBytes: boundedInteger(
      env.REDIS_TRAFFIC_MAX_TILE_BYTES,
      DEFAULT_MAX_TILE_BYTES,
      1024,
      16 * 1024 * 1024
    ),
    maxTotalBytes: boundedInteger(
      env.REDIS_TRAFFIC_MAX_TOTAL_BYTES,
      DEFAULT_MAX_TOTAL_BYTES,
      1024 * 1024,
      2 * 1024 * 1024 * 1024
    )
  };
}

function cachePrefix(env: TrafficSnapshotEnv = process.env) {
  return `${trafficSnapshotConfig(env).namespace}:traffic-snapshot:v${TRAFFIC_SNAPSHOT_SCHEMA_VERSION}`;
}

export function trafficSnapshotPointerKey(env: TrafficSnapshotEnv = process.env) {
  return `${cachePrefix(env)}:current`;
}

export function trafficSnapshotDashboardKey(version: string, env: TrafficSnapshotEnv = process.env) {
  return `${cachePrefix(env)}:${version}:dashboard`;
}

export function trafficSnapshotManifestKey(version: string, env: TrafficSnapshotEnv = process.env) {
  return `${cachePrefix(env)}:${version}:manifest`;
}

export function trafficSnapshotTileKey(
  version: string,
  zoom: number,
  x: number,
  y: number,
  env: TrafficSnapshotEnv = process.env
) {
  return `${cachePrefix(env)}:${version}:tile:${zoom}:${x}:${y}`;
}

function validPointer(value: unknown): value is TrafficSnapshotPointer {
  if (!value || typeof value !== "object") return false;
  const pointer = value as Partial<TrafficSnapshotPointer>;
  const versions = pointer.versions as Partial<DashboardResourceVersions> | undefined;
  return pointer.schemaVersion === TRAFFIC_SNAPSHOT_SCHEMA_VERSION &&
    typeof pointer.version === "string" && VERSION_PATTERN.test(pointer.version) &&
    typeof pointer.tileUrlTemplate === "string" && pointer.tileUrlTemplate.includes("{z}") &&
    Number.isInteger(pointer.minZoom) && Number.isInteger(pointer.maxZoom) &&
    Number.isInteger(pointer.tileCount) && Number(pointer.tileCount) > 0 &&
    typeof pointer.sourceRunId === "string" && typeof pointer.slotUtc === "string" &&
    typeof versions?.flow === "string" && typeof versions.routes === "string" &&
    typeof versions.flowHealth === "string" && typeof versions.routeHealth === "string";
}

function validManifest(
  value: unknown,
  pointer: TrafficSnapshotPointer,
  env: TrafficSnapshotEnv
): value is TrafficSnapshotManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<TrafficSnapshotManifest>;
  const tilePrefix = `${cachePrefix(env)}:${pointer.version}:tile:`;
  return manifest.schemaVersion === TRAFFIC_SNAPSHOT_SCHEMA_VERSION &&
    manifest.version === pointer.version &&
    manifest.dashboardKey === trafficSnapshotDashboardKey(pointer.version, env) &&
    Array.isArray(manifest.tileKeys) &&
    manifest.tileKeys.length === pointer.tileCount &&
    new Set(manifest.tileKeys).size === manifest.tileKeys.length &&
    manifest.tileKeys.every((key) => typeof key === "string" && key.startsWith(tilePrefix));
}

async function resolveStore(
  env: TrafficSnapshotEnv,
  supplied?: RedisCacheStore | null
): Promise<RedisCacheStore | null> {
  if (trafficSnapshotMode(env) === "off") return null;
  const store = supplied ?? await getRedisCacheStore(env);
  if (!store && trafficSnapshotMode(env) === "require") {
    throw new Error("Redis traffic cache is required but REDIS_URL is not configured.");
  }
  return store;
}

export async function readTrafficSnapshotPointer(
  env: TrafficSnapshotEnv = process.env,
  suppliedStore?: RedisCacheStore | null
): Promise<TrafficSnapshotPointer | null> {
  try {
    const store = await resolveStore(env, suppliedStore);
    if (!store) return null;
    const raw = await store.get(trafficSnapshotPointerKey(env));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!validPointer(parsed)) throw new Error("Redis traffic snapshot pointer is invalid.");
    return parsed;
  } catch (error) {
    if (trafficSnapshotMode(env) === "require") throw error;
    return null;
  }
}

export async function readTrafficSnapshotManifest(
  pointer: TrafficSnapshotPointer,
  env: TrafficSnapshotEnv = process.env,
  suppliedStore?: RedisCacheStore | null
): Promise<TrafficSnapshotManifest | null> {
  try {
    const store = await resolveStore(env, suppliedStore);
    if (!store) return null;
    const raw = await store.get(trafficSnapshotManifestKey(pointer.version, env));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return validManifest(parsed, pointer, env) ? parsed : null;
  } catch (error) {
    if (trafficSnapshotMode(env) === "require") throw error;
    return null;
  }
}

export function publicTrafficTileSnapshot(pointer: TrafficSnapshotPointer): TrafficTileSnapshot {
  return {
    version: pointer.version,
    tileUrlTemplate: pointer.tileUrlTemplate,
    minZoom: pointer.minZoom,
    maxZoom: pointer.maxZoom,
    sourceLayers: pointer.sourceLayers,
    slotUtc: pointer.slotUtc,
    sourceRunId: pointer.sourceRunId,
    featureCount: pointer.featureCount,
    pulsePointCount: pointer.pulsePointCount
  };
}

export function encodeDashboardSnapshot(
  dashboard: SourceDashboardData,
  env: TrafficSnapshotEnv = process.env
) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(dashboard)), { level: 6 });
  if (compressed.byteLength > trafficSnapshotConfig(env).maxDashboardBytes) {
    throw new Error("Compressed Redis dashboard snapshot exceeds the configured entry limit.");
  }
  return compressed.toString("base64");
}

function decodeDashboardSnapshot(
  encoded: string,
  env: TrafficSnapshotEnv = process.env
): SourceDashboardData {
  const config = trafficSnapshotConfig(env);
  const compressed = Buffer.from(encoded, "base64");
  if (compressed.byteLength > config.maxDashboardBytes) {
    throw new Error("Redis dashboard snapshot exceeds the configured entry limit.");
  }
  return JSON.parse(gunzipSync(compressed, {
    maxOutputLength: config.maxDashboardBytes * 16
  }).toString("utf8")) as SourceDashboardData;
}

export async function readCurrentDashboardSnapshot(
  env: TrafficSnapshotEnv = process.env,
  suppliedStore?: RedisCacheStore | null
): Promise<SourceDashboardData | null> {
  try {
    const store = await resolveStore(env, suppliedStore);
    if (!store) return null;
    const pointer = await readTrafficSnapshotPointer(env, store);
    if (!pointer) return null;
    const encoded = await store.get(trafficSnapshotDashboardKey(pointer.version, env));
    if (!encoded) throw new Error("Redis dashboard snapshot payload is unavailable.");
    const dashboard = decodeDashboardSnapshot(encoded, env);
    if (dashboard.meta.sourceRunId !== pointer.sourceRunId || dashboard.meta.slotUtc !== pointer.slotUtc) {
      throw new Error("Redis dashboard snapshot identity does not match its tile manifest.");
    }
    return {
      ...dashboard,
      meta: { ...dashboard.meta, source: "here_snapshot_redis" },
      trafficTiles: publicTrafficTileSnapshot(pointer)
    };
  } catch (error) {
    if (trafficSnapshotMode(env) === "require") throw error;
    return null;
  }
}

export async function trafficSnapshotReadiness(
  env: TrafficSnapshotEnv = process.env,
  suppliedStore?: RedisCacheStore | null
): Promise<TrafficSnapshotReadiness> {
  const unavailable = (
    reason: Exclude<TrafficSnapshotReadiness["reason"], "ready">,
    pointer?: TrafficSnapshotPointer | null
  ): TrafficSnapshotReadiness => ({
    status: "unavailable",
    reason,
    version: pointer?.version ?? null,
    createdAtUtc: pointer?.createdAtUtc ?? null
  });
  try {
    const store = await resolveStore(env, suppliedStore);
    if (!store) return unavailable("pointer_missing");
    const pointer = await readTrafficSnapshotPointer(env, store);
    if (!pointer) return unavailable("pointer_missing");

    const encodedDashboard = await store.get(
      trafficSnapshotDashboardKey(pointer.version, env)
    );
    if (!encodedDashboard) return unavailable("dashboard_missing", pointer);
    try {
      const dashboard = decodeDashboardSnapshot(encodedDashboard, env);
      if (
        dashboard.meta.sourceRunId !== pointer.sourceRunId ||
        dashboard.meta.slotUtc !== pointer.slotUtc
      ) {
        return unavailable("dashboard_invalid", pointer);
      }
    } catch {
      return unavailable("dashboard_invalid", pointer);
    }

    const rawManifest = await store.get(trafficSnapshotManifestKey(pointer.version, env));
    if (!rawManifest) return unavailable("manifest_missing", pointer);
    const manifest = await readTrafficSnapshotManifest(pointer, env, store);
    if (!manifest) return unavailable("manifest_invalid", pointer);
    if (!await store.get(manifest.tileKeys[0]!)) {
      return unavailable("tile_missing", pointer);
    }
    return {
      status: "ok",
      reason: "ready",
      version: pointer.version,
      createdAtUtc: pointer.createdAtUtc
    };
  } catch {
    return unavailable("pointer_missing");
  }
}

function validTileCoordinates(version: string, zoom: number, x: number, y: number) {
  if (!VERSION_PATTERN.test(version)) return false;
  const limit = 2 ** zoom;
  return Number.isInteger(zoom) && zoom >= 0 && zoom <= 22 &&
    Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && y >= 0 && x < limit && y < limit;
}

export async function readTrafficVectorTile(
  version: string,
  zoom: number,
  x: number,
  y: number,
  env: TrafficSnapshotEnv = process.env,
  suppliedStore?: RedisCacheStore | null
) {
  if (!validTileCoordinates(version, zoom, x, y)) return null;
  try {
    const store = await resolveStore(env, suppliedStore);
    if (!store) return null;
    const encoded = await store.get(trafficSnapshotTileKey(version, zoom, x, y, env));
    if (!encoded) return null;
    const tile = Buffer.from(encoded, "base64");
    if (tile.byteLength > trafficSnapshotConfig(env).maxTileBytes) return null;
    return tile;
  } catch (error) {
    if (trafficSnapshotMode(env) === "require") throw error;
    return null;
  }
}
