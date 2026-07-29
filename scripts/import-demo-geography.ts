import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Position } from "@/lib/dashboard/types";

const OUTPUT_DIRECTORY = path.join(process.cwd(), "public/geography");
const REGENCY_OUTPUT = path.join(OUTPUT_DIRECTORY, "bali-regencies.geojson");
const ROAD_OUTPUT = path.join(OUTPUT_DIRECTORY, "bali-osm-roads.geojson");
const POI_OUTPUT = path.join(OUTPUT_DIRECTORY, "bali-osm-activity-centers.geojson");
const GADM_URL = "https://raw.githubusercontent.com/mahendrayudha/indonesia-geojson/main/Bali/Kabupaten-Kota%20(Provinsi%20Bali)/Kabupaten-Kota%20(Provinsi%20Bali).geojson";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const ROAD_QUERY = '[out:json][timeout:90];way[highway][name~"Sunset Road|Bypass Ngurah Rai|Raya Kerobokan|Raya Canggu|Gilimanuk|Raya Ubud|Ida Bagus Mantra",i](-8.90,114.40,-8.00,115.80);out tags geom;';
const AIRPORT_QUERY = '[out:json][timeout:60];way[highway][name~"Airport|Bandara|Ngurah Rai",i](-8.82,115.12,-8.68,115.24);out tags geom;';
const SIMPLIFY_TOLERANCE = 0.00025;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

type GadmFeature = {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: Position[][] } | { type: "MultiPolygon"; coordinates: Position[][][] };
  properties: { NAME_2: string; GID_2?: string };
};

type OverpassWay = {
  type: "way";
  id: number;
  tags?: { name?: string; highway?: string };
  geometry?: Array<{ lat: number; lon: number }>;
};

type RoadProfile = {
  id: number;
  key: string;
  name: string;
  functionalClass: number;
  matches: (name: string) => boolean;
  source: "roads" | "airport";
};

const ZONE_IDS: Record<string, number> = {
  Badung: 101,
  Bangli: 102,
  Buleleng: 103,
  Denpasar: 104,
  Gianyar: 105,
  Jembrana: 106,
  Karangasem: 107,
  Klungkung: 108,
  Tabanan: 109
};

const ROAD_PROFILES: RoadProfile[] = [
  { id: 301, key: "osm-sunset-road", name: "Sunset Road", functionalClass: 2, matches: (name) => /sunset road/i.test(name), source: "roads" },
  { id: 302, key: "osm-bypass-ngurah-rai", name: "Jalan Bypass Ngurah Rai", functionalClass: 1, matches: (name) => name === "Jalan Bypass Ngurah Rai", source: "roads" },
  { id: 303, key: "osm-raya-kerobokan", name: "Jalan Raya Kerobokan", functionalClass: 3, matches: (name) => name === "Jalan Raya Kerobokan", source: "roads" },
  { id: 304, key: "osm-raya-canggu", name: "Jalan Raya Canggu", functionalClass: 3, matches: (name) => name === "Jalan Raya Canggu", source: "roads" },
  { id: 305, key: "osm-denpasar-gilimanuk", name: "Jalan Raya Denpasar–Gilimanuk", functionalClass: 1, matches: (name) => /Raya Denpasar-Gilimanuk$/.test(name), source: "roads" },
  { id: 306, key: "osm-raya-ubud", name: "Jalan Raya Ubud", functionalClass: 3, matches: (name) => name === "Jalan Raya Ubud", source: "roads" },
  { id: 307, key: "osm-ida-bagus-mantra", name: "Jalan Ida Bagus Mantra", functionalClass: 1, matches: (name) => /Ida Bagus Mantra/i.test(name), source: "roads" },
  { id: 308, key: "osm-airport-access", name: "Ngurah Rai Airport access", functionalClass: 2, matches: (name) => /Airport|Bandara/i.test(name) && !/Pedestrian/i.test(name), source: "airport" }
];

const POI_PROFILES = [
  { id: 601, zoneId: 101, name: "Ngurah Rai International Airport", category: "transport", attractionScore: 96, query: "", fixed: { lat: -8.7465762, lon: 115.1673505, osm_type: "way", osm_id: 82162575, display_name: "Ngurah Rai International Airport, Badung, Bali, Indonesia" } },
  { id: 602, zoneId: 105, name: "Ubud Palace", category: "culture", attractionScore: 86, query: "Ubud Palace, Bali, Indonesia" },
  { id: 603, zoneId: 101, name: "Batu Bolong Beach", category: "tourism", attractionScore: 90, query: "Batu Bolong Beach, Canggu, Bali, Indonesia" },
  { id: 604, zoneId: 104, name: "Sanur Harbour", category: "transport", attractionScore: 78, query: "Pelabuhan Sanur, Bali, Indonesia" },
  { id: 605, zoneId: 104, name: "Level 21 Mall Bali", category: "retail", attractionScore: 69, query: "Level 21 Mall, Bali, Indonesia" },
  { id: 606, zoneId: 101, name: "Bali Collection", category: "retail", attractionScore: 74, query: "Bali Collection, Nusa Dua, Bali, Indonesia" }
] as const;

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function loadJson<T>(filePath: string | undefined, url: string, query?: string): Promise<T> {
  if (filePath) return JSON.parse(await readFile(filePath, "utf8")) as T;
  const target = query ? `${url}?data=${encodeURIComponent(query)}` : url;
  const response = await fetch(target, { headers: { "User-Agent": "AtlasBaliDemoGeographyImporter/1.0" }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function squaredDistance(first: Position, second: Position) {
  const dx = first[0] - second[0];
  const dy = first[1] - second[1];
  return dx * dx + dy * dy;
}

function squaredSegmentDistance(point: Position, start: Position, end: Position) {
  let x = start[0];
  let y = start[1];
  let dx = end[0] - x;
  let dy = end[1] - y;
  if (dx !== 0 || dy !== 0) {
    const ratio = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (ratio > 1) { x = end[0]; y = end[1]; }
    else if (ratio > 0) { x += dx * ratio; y += dy * ratio; }
  }
  dx = point[0] - x;
  dy = point[1] - y;
  return dx * dx + dy * dy;
}

function simplifyStep(points: Position[], first: number, last: number, toleranceSquared: number, kept: Position[]) {
  let maximum = toleranceSquared;
  let index = -1;
  for (let cursor = first + 1; cursor < last; cursor += 1) {
    const distance = squaredSegmentDistance(points[cursor]!, points[first]!, points[last]!);
    if (distance > maximum) { index = cursor; maximum = distance; }
  }
  if (index < 0) return;
  if (index - first > 1) simplifyStep(points, first, index, toleranceSquared, kept);
  kept.push(points[index]!);
  if (last - index > 1) simplifyStep(points, index, last, toleranceSquared, kept);
}

function simplifyRing(ring: Position[]) {
  if (ring.length <= 8) return ring;
  const open = squaredDistance(ring[0]!, ring.at(-1)!) === 0 ? ring.slice(0, -1) : [...ring];
  let split = 1;
  for (let index = 2; index < open.length; index += 1) {
    if (squaredDistance(open[0]!, open[index]!) > squaredDistance(open[0]!, open[split]!)) split = index;
  }
  const rotated = [...open.slice(split), ...open.slice(0, split), open[split]!];
  const kept = [rotated[0]!];
  simplifyStep(rotated, 0, rotated.length - 1, SIMPLIFY_TOLERANCE ** 2, kept);
  kept.push(rotated.at(-1)!);
  return kept.length >= 4 ? kept : ring;
}

function normalizeGeometry(geometry: GadmFeature["geometry"]) {
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  return { type: "MultiPolygon" as const, coordinates: polygons.map((polygon) => polygon.map(simplifyRing)) };
}

function signedArea(ring: Position[]) {
  return ring.reduce((area, point, index) => {
    const next = ring[(index + 1) % ring.length]!;
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function ringCentroid(ring: Position[]): Position {
  const area = signedArea(ring);
  if (Math.abs(area) < Number.EPSILON) return ring[Math.floor(ring.length / 2)]!;
  let longitude = 0;
  let latitude = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const point = ring[index]!;
    const next = ring[(index + 1) % ring.length]!;
    const cross = point[0] * next[1] - next[0] * point[1];
    longitude += (point[0] + next[0]) * cross;
    latitude += (point[1] + next[1]) * cross;
  }
  return [longitude / (6 * area), latitude / (6 * area)];
}

async function main() {
  const [gadm, roads, airport] = await Promise.all([
    loadJson<{ features: GadmFeature[] }>(argument("--regencies"), GADM_URL),
    loadJson<{ elements: OverpassWay[] }>(argument("--roads"), OVERPASS_URL, ROAD_QUERY),
    loadJson<{ elements: OverpassWay[] }>(argument("--airport-roads"), OVERPASS_URL, AIRPORT_QUERY)
  ]);
  const importedAt = new Date().toISOString();
  const regencies = {
    type: "FeatureCollection" as const,
    metadata: { source: "GADM 4.0", sourceUrl: GADM_URL, importedAt, crs: "EPSG:4326", simplificationToleranceDegrees: SIMPLIFY_TOLERANCE },
    features: gadm.features.map((feature) => {
      const geometry = normalizeGeometry(feature.geometry);
      const largestRing = geometry.coordinates.flatMap((polygon) => polygon.slice(0, 1)).sort((first, second) => Math.abs(signedArea(second!)) - Math.abs(signedArea(first!)))[0]!;
      const name = feature.properties.NAME_2;
      return {
        type: "Feature" as const,
        id: ZONE_IDS[name],
        geometry,
        properties: { zoneId: ZONE_IDS[name], zoneKey: `bali-${name.toLowerCase().replaceAll(" ", "-")}`, name, regencyName: name, center: ringCentroid(largestRing), sourceId: feature.properties.GID_2 ?? null }
      };
    })
  };

  const roadSources = { roads: roads.elements, airport: airport.elements };
  const roadFeatures = ROAD_PROFILES.map((profile) => {
    const ways = roadSources[profile.source].filter((way) => way.geometry?.length && profile.matches(way.tags?.name ?? ""));
    if (!ways.length) throw new Error(`No OSM geometry found for ${profile.name}`);
    return {
      type: "Feature" as const,
      id: profile.key,
      geometry: { type: "MultiLineString" as const, coordinates: ways.map((way) => way.geometry!.map(({ lon, lat }) => [lon, lat] as Position)) },
      properties: { segmentId: profile.id, segmentKey: profile.key, roadName: profile.name, functionalClass: profile.functionalClass, osmWayIds: ways.map((way) => way.id), source: "OpenStreetMap", importedAt }
    };
  });
  const roadCollection = { type: "FeatureCollection" as const, metadata: { source: "OpenStreetMap", license: "ODbL-1.0", attribution: "© OpenStreetMap contributors", importedAt, queries: [ROAD_QUERY, AIRPORT_QUERY] }, features: roadFeatures };

  const poiFeatures = [];
  for (const profile of POI_PROFILES) {
    let result: { lat: string | number; lon: string | number; osm_type: string; osm_id: number; display_name: string } | undefined = "fixed" in profile ? profile.fixed : undefined;
    if (!result) {
      const url = new URL(NOMINATIM_URL);
      url.searchParams.set("q", profile.query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      const response = await fetch(url, { headers: { "User-Agent": "AtlasBaliDemoGeographyImporter/1.0" }, signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(`Unable to geocode ${profile.name}: HTTP ${response.status}`);
      const results = await response.json() as Array<{ lat: string; lon: string; osm_type: string; osm_id: number; display_name: string }>;
      result = results[0];
    }
    if (!result) throw new Error(`No OSM result found for ${profile.name}`);
    const longitude = Number(result.lon);
    const latitude = Number(result.lat);
    if (longitude < 114.4 || longitude > 115.8 || latitude < -8.9 || latitude > -8.0) throw new Error(`${profile.name} resolved outside Bali`);
    poiFeatures.push({
      type: "Feature" as const,
      id: profile.id,
      geometry: { type: "Point" as const, coordinates: [longitude, latitude] as Position },
      properties: { centerId: profile.id, zoneId: profile.zoneId, name: profile.name, category: profile.category, attractionScore: profile.attractionScore, source: "OpenStreetMap Nominatim", osmType: result.osm_type, osmId: result.osm_id, displayName: result.display_name }
    });
    if (!("fixed" in profile)) await new Promise((resolve) => setTimeout(resolve, 1_100));
  }
  const poiCollection = { type: "FeatureCollection" as const, metadata: { source: "OpenStreetMap Nominatim", license: "ODbL-1.0", attribution: "© OpenStreetMap contributors", importedAt }, features: poiFeatures };

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await Promise.all([
    writeFile(REGENCY_OUTPUT, `${JSON.stringify(regencies)}\n`, "utf8"),
    writeFile(ROAD_OUTPUT, `${JSON.stringify(roadCollection)}\n`, "utf8"),
    writeFile(POI_OUTPUT, `${JSON.stringify(poiCollection)}\n`, "utf8")
  ]);
  console.log(JSON.stringify({ event: "demo_geography_imported", regencies: regencies.features.length, roads: roadFeatures.length, activityCenters: poiFeatures.length, regencyOutput: REGENCY_OUTPUT, roadOutput: ROAD_OUTPUT, poiOutput: POI_OUTPUT }));
}

void main().catch((error) => {
  console.error(JSON.stringify({ event: "demo_geography_failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
