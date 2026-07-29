import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  ApiMeta,
  CenterProperties,
  CollectionRun,
  DashboardFixture,
  FeatureCollection,
  FlowProperties,
  Geometry,
  IncidentProperties,
  MobilityFlowProperties,
  MobilityZoneProperties,
  Position,
  RouteSummary
} from "@/lib/dashboard/types";

const HALF_HOUR_MS = 30 * 60 * 1000;

function floorHalfHour(date: Date) {
  return new Date(Math.floor(date.getTime() / HALF_HOUR_MS) * HALF_HOUR_MS);
}

function witaLabel(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Makassar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset"
  })
    .format(new Date(iso))
    .replace(", ", "T")
    .replace(" GMT+08:00", "+08:00");
}

type ImportedZone = {
  id: number;
  geometry: Extract<Geometry, { type: "MultiPolygon" }>;
  properties: { zoneId: number; zoneKey: string; name: string; regencyName: string; center: Position };
};

type ImportedRoad = {
  id: string;
  geometry: Extract<Geometry, { type: "MultiLineString" }>;
  properties: { segmentId: number; segmentKey: string; roadName: string; functionalClass: number };
};

type ImportedCenter = {
  id: number;
  geometry: Extract<Geometry, { type: "Point" }>;
  properties: CenterProperties;
};

function geographySnapshot<T>(fileName: string) {
  return JSON.parse(readFileSync(path.join(process.cwd(), "public/geography", fileName), "utf8")) as { features: T[] };
}

const zoneMetrics: Record<string, { scores: [number, number, number, number]; jam: number }> = {
  Badung: { scores: [94, 88, 81, 96], jam: 8.1 },
  Denpasar: { scores: [88, 92, 67, 86], jam: 7.2 },
  Gianyar: { scores: [78, 83, 61, 87], jam: 5.8 },
  Buleleng: { scores: [55, 61, 50, 59], jam: 3.1 },
  Tabanan: { scores: [46, 38, 66, 35], jam: 3.7 },
  Klungkung: { scores: [42, 49, 45, 40], jam: 2.9 },
  Bangli: { scores: [37, 44, 32, 53], jam: 2.6 },
  Karangasem: { scores: [29, 34, 25, 31], jam: 1.8 },
  Jembrana: { scores: [24, 20, 43, 18], jam: 2.2 }
};

const zoneDefinitions = geographySnapshot<ImportedZone>("bali-regencies.geojson").features
  .map((feature) => ({
    id: feature.properties.zoneId,
    key: feature.properties.zoneKey,
    name: feature.properties.name,
    regency: feature.properties.regencyName,
    center: feature.properties.center,
    geometry: feature.geometry,
    ...zoneMetrics[feature.properties.name]!
  }))
  .sort((first, second) => first.id - second.id);

const roadMetrics: Record<string, { speed: number; free: number; jam: number; confidence: number; tendency: number }> = {
  "osm-sunset-road": { speed: 12.4, free: 42.8, jam: 8.4, confidence: .94, tendency: 1 },
  "osm-bypass-ngurah-rai": { speed: 24.8, free: 58.3, jam: 6.1, confidence: .97, tendency: 0 },
  "osm-raya-kerobokan": { speed: 10.1, free: 35.4, jam: 8.8, confidence: .89, tendency: 1 },
  "osm-raya-canggu": { speed: 16.6, free: 38.2, jam: 6.8, confidence: .85, tendency: -1 },
  "osm-denpasar-gilimanuk": { speed: 44.3, free: 57.2, jam: 3.1, confidence: .92, tendency: 0 },
  "osm-raya-ubud": { speed: 18.8, free: 39.7, jam: 5.7, confidence: .83, tendency: 1 },
  "osm-ida-bagus-mantra": { speed: 53.1, free: 62.4, jam: 1.9, confidence: .98, tendency: 0 },
  "osm-airport-access": { speed: 0, free: 34.6, jam: 10, confidence: .99, tendency: 1 }
};

const roadDefinitions = geographySnapshot<ImportedRoad>("bali-osm-roads.geojson").features.map((feature) => ({
  id: feature.properties.segmentId,
  key: feature.properties.segmentKey,
  name: feature.properties.roadName,
  fc: feature.properties.functionalClass,
  geometry: feature.geometry,
  ...roadMetrics[feature.properties.segmentKey]!
}));

const activityCenterDefinitions = geographySnapshot<ImportedCenter>("bali-osm-activity-centers.geojson").features;

function realRoadPoint(segmentKey: string, fraction = 0.5): Position {
  const road = roadDefinitions.find((candidate) => candidate.key === segmentKey);
  if (!road) throw new Error(`Missing real road geometry for ${segmentKey}`);
  const points = road.geometry.coordinates.flat();
  return points[Math.min(points.length - 1, Math.max(0, Math.floor(points.length * fraction)))]!;
}

export function createDashboardFixture(now = new Date()): DashboardFixture {
  const generatedAt = now.toISOString();
  const selected = floorHalfHour(now);
  const selectedSlot = selected.toISOString();
  const slots = Array.from({ length: 14 }, (_, index) =>
    new Date(selected.getTime() - (13 - index) * HALF_HOUR_MS).toISOString()
  );

  const zones: FeatureCollection<MobilityZoneProperties> = {
    type: "FeatureCollection",
    features: zoneDefinitions.map((zone, index) => ({
      type: "Feature",
      id: zone.id,
      geometry: zone.geometry,
      properties: {
        zoneId: zone.id,
        zoneKey: zone.key,
        name: zone.name,
        regencyName: zone.regency,
        timeBucketUtc: selectedSlot,
        timeBucketLocal: witaLabel(selectedSlot),
        presenceScore: zone.scores[0],
        inboundScore: zone.scores[1],
        outboundScore: zone.scores[2],
        attractionScore: zone.scores[3],
        hotspotRank: index + 1,
        confidence: Number((.92 - index * .025).toFixed(2)),
        meanJamFactor: zone.jam,
        meanSpeedKph: Number((51 - zone.jam * 4.1).toFixed(1)),
        modelVersion: "gravity-v1",
        runStatus: index === zoneDefinitions.length - 1 ? "partial" : "success",
        isStale: false,
        center: zone.center,
        geometrySource: "GADM 4.0"
      }
    }))
  };

  const flow: FeatureCollection<FlowProperties> = {
    type: "FeatureCollection",
    features: roadDefinitions.map((road) => ({
      type: "Feature",
      id: road.key,
      geometry: road.geometry,
      properties: {
        segmentId: road.id,
        segmentKey: road.key,
        roadName: road.name,
        functionalClass: road.fc,
        observedAt: selectedSlot,
        speedKph: road.speed,
        freeFlowKph: road.free,
        relativeSpeed: Number((road.speed / road.free).toFixed(4)),
        jamFactor: road.jam,
        jamTendency: road.tendency,
        confidence: road.confidence,
        traversability: road.jam === 10 ? "closed" : "open",
        roadClosure: road.jam === 10,
        geometrySource: "OpenStreetMap named ways"
      }
    }))
  };

  const incidents: FeatureCollection<IncidentProperties> = {
    type: "FeatureCollection",
    features: [
      { id: 501, point: realRoadPoint("osm-airport-access", .52), category: "road_closure", severity: "major", description: "Airport access restriction", closure: true, length: 420 },
      { id: 502, point: realRoadPoint("osm-raya-kerobokan", .5), category: "congestion", severity: "moderate", description: "Heavy traffic near Kerobokan junction", closure: false, length: 1250 },
      { id: 503, point: realRoadPoint("osm-raya-ubud", .5), category: "construction", severity: "minor", description: "Lane works with intermittent delays", closure: false, length: 680 }
    ].map((item) => ({
      type: "Feature",
      id: item.id,
      geometry: { type: "Point", coordinates: item.point },
      properties: {
        incidentId: item.id,
        category: item.category,
        severity: item.severity,
        description: item.description,
        startTime: new Date(selected.getTime() - 90 * 60_000).toISOString(),
        endTime: null,
        roadClosure: item.closure,
        lengthMeters: item.length,
        sourceTimestamp: selectedSlot,
        geometrySource: "OpenStreetMap road vertex"
      }
    }))
  };

  const centers: FeatureCollection<CenterProperties> = {
    type: "FeatureCollection",
    features: activityCenterDefinitions.map((feature) => ({ type: "Feature", id: feature.id, geometry: feature.geometry, properties: feature.properties }))
  };

  const zoneById = new Map(zoneDefinitions.map((zone) => [zone.id, zone]));
  const odRows: Array<[number, number, number, number, number]> = [
    [104,101,92,.22,1800], [101,104,84,.18,2100], [105,104,81,.15,2400],
    [108,104,76,.14,2700], [109,101,68,.12,1900], [103,105,57,.10,3200],
    [107,105,48,.08,4400], [102,105,45,.07,2600], [106,101,41,.06,3900]
  ];
  const mobilityFlows: FeatureCollection<MobilityFlowProperties> = {
    type: "FeatureCollection",
    features: odRows.map(([originId, destinationId, score, share, travel], index) => {
      const origin = zoneById.get(originId)!;
      const destination = zoneById.get(destinationId)!;
      return {
        type: "Feature" as const,
        id: `od-${index + 1}`,
        geometry: { type: "LineString" as const, coordinates: [origin.center, destination.center] },
        properties: {
          originZoneId: originId,
          destinationZoneId: destinationId,
          originName: origin.name,
          destinationName: destination.name,
          mobilityScore: score,
          predictedShare: share,
          travelTimeSeconds: travel,
          confidence: .76,
          modelVersion: "gravity-v1",
          metricSemantics: "relative_prediction_not_people_count" as const
        }
      };
    })
  };

  const routes: RouteSummary[] = [
    [1,"airport-canggu","DPS Airport to Canggu","DPS Airport","Canggu","Airport",21400,2340,3720,1380,1.59,.94],
    [2,"ubud-sanur","Ubud to Sanur","Ubud","Sanur","Intercity",26700,2700,3420,720,1.27,.88],
    [3,"denpasar-nusa-dua","Denpasar to Nusa Dua","Denpasar","Nusa Dua","Commuter",24800,2520,3120,600,1.24,.91],
    [4,"tabanan-denpasar","Tabanan to Denpasar","Tabanan","Denpasar","Intercity",29400,2880,3240,360,1.13,.89],
    [5,"amed-ubud","Amed to Ubud","Amed","Ubud","Tourism",70100,6060,6420,360,1.06,.81]
  ].map((row) => ({
    id: row[0] as number,
    slug: row[1] as string,
    name: row[2] as string,
    originLabel: row[3] as string,
    destinationLabel: row[4] as string,
    category: row[5] as string,
    routePurpose: "general",
    routeGroupKey: `demo-${row[0] as number}`,
    tourismCenterKey: String(row[4]).toLowerCase().replaceAll(" ", "-"),
    routeDirection: "other",
    distanceMeters: row[6] as number,
    typicalSeconds: row[7] as number,
    liveSeconds: row[8] as number,
    delaySeconds: row[9] as number,
    congestionRatio: row[10] as number,
    sampleHourUtc: selectedSlot,
    confidence: row[11] as number,
    status: "fresh" as const,
    geometryAvailable: false
  }));

  function runs(source: string, intervalMs: number, count: number): CollectionRun[] {
    return Array.from({ length: count }, (_, index) => {
      const status = index === 2 ? "partial" : index === 5 ? "failed" : "success";
      const expected = source === "HERE Flow" ? 12 : 6;
      return {
        id: 900 + index + (source === "HERE Flow" ? 0 : 50),
        slotUtc: new Date(selected.getTime() - index * intervalMs).toISOString(),
        status,
        source,
        expectedCount: expected,
        successCount: status === "success" ? expected : status === "partial" ? expected - 2 : 0,
        failedCount: status === "success" ? 0 : status === "partial" ? 2 : expected,
        recordCount: status === "failed" ? 0 : 1854 - index * 37,
        durationSeconds: status === "failed" ? 83 : 41 + index,
        errorMessage: status === "partial" ? "Two collection areas timed out" : status === "failed" ? "Provider request exhausted retry budget" : null
      };
    });
  }

  const meta: ApiMeta = {
    requestId: "demo-fixture",
    generatedAt,
    selectedSlot,
    source: "demo_fixture",
    freshnessSeconds: Math.max(0, Math.round((now.getTime() - selected.getTime()) / 1000)),
    status: "fresh",
    featureCount: flow.features.length,
    modelVersion: "gravity-v1",
    disclaimer: "Predicted relative mobility index. This is not an observed people count. Demo values use real GADM/OSM geometry."
  };

  return {
    generatedAt,
    selectedSlot,
    slots,
    trafficOverview: {
      weightedJamFactor: 6.4,
      congestedRoadShare: .38,
      closures: 1,
      activeIncidents: incidents.features.length,
      slowestRoute: routes[0] ?? null,
      measuredLengthMeters: 184_200,
      coverage: .92
    },
    mobilityOverview: {
      activeZones: zones.features.length,
      topHotspot: "Badung",
      medianPresenceScore: 55,
      inputCoverage: .88,
      runStatus: "partial",
      modelVersion: "gravity-v1"
    },
    flow,
    incidents,
    zones,
    mobilityFlows,
    centers,
    routes,
    flowRuns: runs("HERE Flow", HALF_HOUR_MS, 8),
    hourlyRuns: runs("HERE Routing + Incidents", 2 * HALF_HOUR_MS, 8),
    meta
  };
}

export function demoMeta(at: string | null = null): ApiMeta {
  const fixture = createDashboardFixture();
  return { ...fixture.meta, selectedSlot: at ?? fixture.selectedSlot };
}
