import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { GeoJSONVT, type GeoJSONVTTile } from "@maplibre/geojson-vt";
import { fromGeojsonVt } from "@maplibre/vt-pbf";
import {
  getRedisCacheStore,
  type RedisCacheStore
} from "@/lib/cache/redis-json";
import type {
  FeatureCollection,
  FlowProperties,
  SourceDashboardData,
  TrafficTileSnapshot
} from "@/lib/dashboard/types";
import { createTrafficHeatmapCollection } from "@/lib/map/traffic-heatmap";
import { DEFAULT_BALI_BBOX } from "@/lib/map/viewport";
import { calculateTrafficOverviewForCollection } from "@/lib/map/viewport-traffic";
import {
  encodeDashboardSnapshot,
  TRAFFIC_SNAPSHOT_SCHEMA_VERSION,
  trafficSnapshotConfig,
  trafficSnapshotDashboardKey,
  trafficSnapshotPointerKey,
  trafficSnapshotTileKey,
  type TrafficSnapshotEnv,
  type TrafficSnapshotPointer
} from "@/lib/snapshot/traffic-snapshot";

const MIN_ZOOM = 7;
const MAX_ZOOM = 14;
const LINE_LAYER = "traffic_lines";
const PULSE_LAYER = "traffic_pulse_points";
const WRITE_BATCH_SIZE = 64;

type TileEntry = {
  key: string;
  encoded: string;
  byteLength: number;
};

function tileX(longitude: number, zoom: number) {
  return Math.floor((longitude + 180) / 360 * 2 ** zoom);
}

function tileY(latitude: number, zoom: number) {
  const radians = latitude * Math.PI / 180;
  return Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * 2 ** zoom);
}

function snapshotVersion(data: SourceDashboardData) {
  const identity = JSON.stringify({
    schema: TRAFFIC_SNAPSHOT_SCHEMA_VERSION,
    tileProfile: "pulse-lod-v3-redis",
    sourceRunId: data.meta.sourceRunId,
    slotUtc: data.meta.slotUtc,
    status: data.meta.status,
    coverage: data.meta.coverage,
    features: data.flow.features.length,
    versions: data.versions
  });
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

function vectorIndex(collection: FeatureCollection<Record<string, unknown>>, maxZoom: number) {
  return new GeoJSONVT(collection as never, {
    maxZoom,
    indexMaxZoom: Math.min(8, maxZoom),
    indexMaxPoints: 50_000,
    tolerance: 2,
    extent: 4096,
    buffer: 96,
    promoteId: "segmentId"
  });
}

function publicManifest(
  version: string,
  data: SourceDashboardData,
  pulsePointCount: number,
  minZoom: number,
  maxZoom: number
): TrafficTileSnapshot {
  return {
    version,
    tileUrlTemplate: `/api/v1/traffic/tiles/${version}/{z}/{x}/{y}`,
    minZoom,
    maxZoom,
    sourceLayers: { lines: LINE_LAYER, pulsePoints: PULSE_LAYER },
    slotUtc: data.meta.slotUtc ?? data.meta.selectedSlot ?? "",
    sourceRunId: data.meta.sourceRunId ?? "",
    featureCount: data.flow.features.length,
    pulsePointCount
  };
}

function validateSource(data: SourceDashboardData) {
  if (!data.meta.sourceRunId || !data.meta.slotUtc) {
    throw new Error("Traffic cache requires a Flow run ID and collection slot.");
  }
  if (!data.flow.features.length) {
    throw new Error("Traffic cache requires at least one measured Flow feature.");
  }
  if (!data.versions) {
    throw new Error("Traffic cache requires reconciled dashboard resource versions.");
  }
}

function trafficOverviewByConfidence(dashboard: SourceDashboardData) {
  return Object.fromEntries(Array.from({ length: 21 }, (_, index) => {
    const minimumConfidence = index / 20;
    const filteredFlow: FeatureCollection<FlowProperties> = {
      type: "FeatureCollection",
      features: dashboard.flow.features.filter(
        (feature) => (feature.properties.confidence ?? 0) >= minimumConfidence
      )
    };
    return [minimumConfidence.toFixed(2), calculateTrafficOverviewForCollection({
      flow: filteredFlow,
      routes: dashboard.routes,
      coverage: dashboard.meta.coverage
    })];
  }));
}

async function writeBatches(
  store: RedisCacheStore,
  entries: TileEntry[],
  ttlSeconds: number
) {
  for (let index = 0; index < entries.length; index += WRITE_BATCH_SIZE) {
    const batch = entries.slice(index, index + WRITE_BATCH_SIZE);
    await Promise.all(batch.map((entry) => store.set(entry.key, entry.encoded, { EX: ttlSeconds })));
  }
}

export async function buildTrafficSnapshot(
  dashboard: SourceDashboardData,
  options: {
    env?: TrafficSnapshotEnv;
    store?: RedisCacheStore | null;
    minZoom?: number;
    maxZoom?: number;
  } = {}
): Promise<TrafficSnapshotPointer> {
  validateSource(dashboard);
  const env = options.env ?? process.env;
  const config = trafficSnapshotConfig(env);
  const store = options.store ?? await getRedisCacheStore(env);
  if (!store) throw new Error("Redis is required to build the traffic cache.");

  const minZoom = options.minZoom ?? MIN_ZOOM;
  const maxZoom = options.maxZoom ?? MAX_ZOOM;
  if (
    !Number.isInteger(minZoom) || !Number.isInteger(maxZoom) ||
    minZoom < 0 || maxZoom < minZoom || maxZoom > 22
  ) {
    throw new Error("Traffic cache zoom range is invalid.");
  }

  const version = snapshotVersion(dashboard);
  const provinceHeatmap = createTrafficHeatmapCollection(
    dashboard.flow,
    { spacingMeters: 450, maximumPoints: 8_000 }
  );
  const regionalHeatmap = createTrafficHeatmapCollection(
    dashboard.flow,
    { spacingMeters: 250, maximumPoints: 16_000 }
  );
  const streetHeatmap = createTrafficHeatmapCollection(
    dashboard.flow,
    { spacingMeters: 150, maximumPoints: 30_000 }
  );
  const lineIndex = vectorIndex(dashboard.flow as FeatureCollection<FlowProperties> as never, maxZoom);
  const provincePulseIndex = vectorIndex(provinceHeatmap as never, maxZoom);
  const regionalPulseIndex = vectorIndex(regionalHeatmap as never, maxZoom);
  const streetPulseIndex = vectorIndex(streetHeatmap as never, maxZoom);
  const tileEntries: TileEntry[] = [];

  for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
    const limit = 2 ** zoom;
    const west = Math.max(0, tileX(DEFAULT_BALI_BBOX[0], zoom));
    const east = Math.min(limit - 1, tileX(DEFAULT_BALI_BBOX[2], zoom));
    const north = Math.max(0, tileY(DEFAULT_BALI_BBOX[3], zoom));
    const south = Math.min(limit - 1, tileY(DEFAULT_BALI_BBOX[1], zoom));
    for (let x = west; x <= east; x += 1) {
      for (let y = north; y <= south; y += 1) {
        const lines = lineIndex.getTile(zoom, x, y);
        const pulseIndex = zoom < 11
          ? provincePulseIndex
          : zoom < 14 ? regionalPulseIndex : streetPulseIndex;
        const pulses = pulseIndex.getTile(zoom, x, y);
        const layers: Record<string, GeoJSONVTTile> = {};
        if (lines?.features.length) layers[LINE_LAYER] = lines;
        if (pulses?.features.length) layers[PULSE_LAYER] = pulses;
        if (!Object.keys(layers).length) continue;

        const encoded = fromGeojsonVt(layers, { version: 2, extent: 4096 });
        const compressed = gzipSync(encoded, { level: 9 });
        if (compressed.byteLength > config.maxTileBytes) {
          throw new Error(`Compressed traffic tile ${zoom}/${x}/${y} exceeds the Redis entry limit.`);
        }
        tileEntries.push({
          key: trafficSnapshotTileKey(version, zoom, x, y, env),
          encoded: compressed.toString("base64"),
          byteLength: compressed.byteLength
        });
      }
    }
  }
  if (!tileEntries.length) throw new Error("Generated Redis traffic cache contains no tiles.");

  const tileManifest = publicManifest(
    version,
    dashboard,
    streetHeatmap.features.length,
    minZoom,
    maxZoom
  );
  const dashboardSnapshot: SourceDashboardData = {
    ...dashboard,
    flow: { type: "FeatureCollection", features: [] },
    trafficOverviewByConfidence: trafficOverviewByConfidence(dashboard),
    trafficTiles: tileManifest
  };
  const encodedDashboard = encodeDashboardSnapshot(dashboardSnapshot, env);
  const totalBytes = Buffer.byteLength(encodedDashboard, "base64") +
    tileEntries.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (totalBytes > config.maxTotalBytes) {
    throw new Error(
      `Redis traffic cache requires ${totalBytes} bytes, above the configured ${config.maxTotalBytes}-byte budget.`
    );
  }

  const pointer: TrafficSnapshotPointer = {
    ...tileManifest,
    schemaVersion: TRAFFIC_SNAPSHOT_SCHEMA_VERSION,
    createdAtUtc: new Date().toISOString(),
    tileCount: tileEntries.length,
    versions: dashboard.versions!
  };

  // Versioned values are written first. Publishing the pointer last makes
  // activation atomic from readers' perspective.
  await writeBatches(store, tileEntries, config.ttlSeconds);
  await store.set(
    trafficSnapshotDashboardKey(version, env),
    encodedDashboard,
    { EX: config.ttlSeconds }
  );
  await store.set(
    trafficSnapshotPointerKey(env),
    JSON.stringify(pointer),
    { EX: config.ttlSeconds }
  );
  return pointer;
}
