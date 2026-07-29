import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BaliBoundaryProperties,
  FeatureCollection,
  GeoJsonFeature,
  Position
} from "@/lib/dashboard/types";

const RELATION_ID = 1615621 as const;
const OUTPUT_PATH = path.join(process.cwd(), "public/geography/bali-province.geojson");
const SOURCE_URL = `https://www.openstreetmap.org/relation/${RELATION_ID}`;
const USER_AGENT = "AtlasBaliBoundaryImporter/1.0 (Bali mobility dashboard boundary snapshot)";

type OsmRelation = {
  type: "relation";
  id: number;
  version: number;
  timestamp: string;
  tags: Record<string, string>;
  members: Array<{
    type: string;
    role: string;
    geometry?: Array<{ lat: number; lon: number }>;
  }>;
};

type RawGeometry =
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };

function positionsFromGeometry(geometry: RawGeometry) {
  return geometry.type === "Polygon"
    ? geometry.coordinates.flat()
    : geometry.coordinates.flat(2);
}

function geometryBbox(geometry: RawGeometry): [number, number, number, number] {
  const positions = positionsFromGeometry(geometry);
  if (positions.length === 0) throw new Error("Boundary contains no coordinates");
  return positions.reduce<[number, number, number, number]>(
    (bbox, [longitude, latitude]) => [
      Math.min(bbox[0], longitude),
      Math.min(bbox[1], latitude),
      Math.max(bbox[2], longitude),
      Math.max(bbox[3], latitude)
    ],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
}

function validateRing(ring: Position[], label: string) {
  if (ring.length < 4) throw new Error(`${label} has fewer than four positions`);
  const first = ring[0];
  const last = ring.at(-1);
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
    throw new Error(`${label} is not closed`);
  }
  for (const [longitude, latitude] of ring) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new Error(`${label} contains a non-numeric position`);
    }
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      throw new Error(`${label} contains a coordinate outside WGS84 bounds`);
    }
  }
}

function samePosition(first: Position, second: Position) {
  return first[0] === second[0] && first[1] === second[1];
}

function relationRings(relation: OsmRelation, role: "outer" | "inner") {
  const segments = relation.members
    .filter((member) => member.type === "way" && member.role === role && member.geometry?.length)
    .map((member) => member.geometry!.map(({ lon, lat }) => [lon, lat] as Position));
  const rings: Position[][] = [];

  while (segments.length) {
    const ring = segments.shift()!;
    while (!samePosition(ring[0]!, ring.at(-1)!)) {
      const start = ring[0]!;
      const end = ring.at(-1)!;
      const matchIndex = segments.findIndex((segment) => {
        const segmentStart = segment[0]!;
        const segmentEnd = segment.at(-1)!;
        return samePosition(end, segmentStart) || samePosition(end, segmentEnd) ||
          samePosition(start, segmentEnd) || samePosition(start, segmentStart);
      });
      if (matchIndex < 0) throw new Error(`Unable to close ${role} boundary ring from OSM relation members`);
      const segment = segments.splice(matchIndex, 1)[0]!;
      const segmentStart = segment[0]!;
      const segmentEnd = segment.at(-1)!;
      if (samePosition(end, segmentStart)) ring.push(...segment.slice(1));
      else if (samePosition(end, segmentEnd)) ring.push(...segment.slice(0, -1).reverse());
      else if (samePosition(start, segmentEnd)) ring.unshift(...segment.slice(0, -1));
      else ring.unshift(...segment.slice(1).reverse());
    }
    rings.push(ring);
  }
  return rings;
}

function pointInRing([longitude, latitude]: Position, ring: Position[]) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[index]!;
    const [x2, y2] = ring[previous]!;
    const crosses = (y1 > latitude) !== (y2 > latitude) &&
      longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonArea(ring: Position[]) {
  return Math.abs(ring.reduce((area, point, index) => {
    const next = ring[(index + 1) % ring.length]!;
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
}

function relationGeometry(relation: OsmRelation): { type: "MultiPolygon"; coordinates: Position[][][] } {
  const outerRings = relationRings(relation, "outer");
  const innerRings = relationRings(relation, "inner");
  if (!outerRings.length) throw new Error("OSM relation contains no outer boundary rings");
  const polygons = outerRings.map((outer) => [outer]);
  for (const inner of innerRings) {
    const candidates = outerRings
      .map((outer, index) => ({ outer, index, area: polygonArea(outer) }))
      .filter(({ outer }) => pointInRing(inner[0]!, outer))
      .sort((first, second) => first.area - second.area);
    const container = candidates[0];
    if (!container) throw new Error("OSM relation contains an inner ring outside every outer ring");
    polygons[container.index]!.push(inner);
  }
  return { type: "MultiPolygon", coordinates: polygons };
}

export function validateBaliBoundary(
  collection: FeatureCollection<BaliBoundaryProperties>
) {
  if (collection.type !== "FeatureCollection" || collection.features.length !== 1) {
    throw new Error("Boundary snapshot must contain exactly one feature");
  }
  const feature = collection.features[0];
  if (!feature || feature.geometry.type !== "MultiPolygon") {
    throw new Error("Bali Province boundary must be a MultiPolygon");
  }
  if (feature.properties.osmRelationId !== RELATION_ID) {
    throw new Error(`Expected OSM relation ${RELATION_ID}`);
  }
  if (!feature.properties.source || !feature.properties.license || !feature.properties.sourceUrl) {
    throw new Error("Boundary source and licence metadata are required");
  }
  feature.geometry.coordinates.forEach((polygon, polygonIndex) => {
    if (polygon.length === 0) throw new Error(`Polygon ${polygonIndex} has no rings`);
    polygon.forEach((ring, ringIndex) => validateRing(ring, `Polygon ${polygonIndex} ring ${ringIndex}`));
  });
  const [west, south, east, north] = geometryBbox(feature.geometry);
  if (west > 114.5 || south > -8.8 || east < 115.65 || north < -8.15) {
    throw new Error(`Boundary does not cover the expected Bali Province extent: ${[west, south, east, north].join(",")}`);
  }
  if (feature.geometry.coordinates.length < 3) {
    throw new Error("Boundary must retain mainland Bali and multiple offshore island polygons");
  }
  return { bbox: [west, south, east, north] as [number, number, number, number], polygonCount: feature.geometry.coordinates.length };
}

async function fetchRelation(): Promise<OsmRelation> {
  const query = `[out:json][timeout:120];relation(${RELATION_ID});out meta geom;`;
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];
  let lastError: unknown;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: query,
        headers: { Accept: "application/json", "Content-Type": "text/plain", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(90_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { elements: OsmRelation[] };
      const relation = payload.elements.find((element) => element.type === "relation" && element.id === RELATION_ID);
      if (!relation) throw new Error(`OSM relation ${RELATION_ID} was not returned`);
      return relation;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to fetch OSM relation geometry: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function importBoundary() {
  const relation = await fetchRelation();
  if (relation.tags.boundary !== "administrative" || relation.tags.admin_level !== "4") {
    throw new Error("Pinned relation is no longer the Bali province administrative boundary");
  }
  if (!/^bali$/i.test(relation.tags.name ?? "")) {
    throw new Error(`Pinned relation name changed to ${relation.tags.name ?? "missing"}`);
  }

  const rawGeometry = relationGeometry(relation);
  const geometry = { type: "MultiPolygon" as const, coordinates: rawGeometry.coordinates };
  const bbox = geometryBbox(geometry);
  const importedAt = new Date().toISOString();
  const feature: GeoJsonFeature<BaliBoundaryProperties> = {
    type: "Feature",
    id: "bali-province",
    geometry,
    properties: {
      boundaryKey: "bali-province",
      name: relation.tags.official_name ?? relation.tags.name,
      source: "OpenStreetMap",
      osmRelationId: RELATION_ID,
      osmVersion: relation.version,
      osmTimestamp: relation.timestamp,
      osmRelationUrl: SOURCE_URL,
      sourceUrl: SOURCE_URL,
      license: "ODbL-1.0",
      attribution: "© OpenStreetMap contributors",
      importedAt,
      bbox
    }
  };
  const collection: FeatureCollection<BaliBoundaryProperties> = {
    type: "FeatureCollection",
    features: [feature]
  };
  const validation = validateBaliBoundary(collection);
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(collection)}\n`, "utf8");
  console.log(JSON.stringify({ event: "bali_boundary_imported", output: OUTPUT_PATH, relationId: RELATION_ID, osmVersion: relation.version, ...validation }));
}

async function importBootstrapBoundary(inputPath: string) {
  const raw = JSON.parse(await readFile(inputPath, "utf8")) as FeatureCollection;
  const inputFeature = raw.features[0];
  if (!inputFeature || (inputFeature.geometry.type !== "Polygon" && inputFeature.geometry.type !== "MultiPolygon")) {
    throw new Error("Bootstrap boundary must contain a Polygon or MultiPolygon feature");
  }
  const geometry = inputFeature.geometry.type === "MultiPolygon"
    ? inputFeature.geometry
    : { type: "MultiPolygon" as const, coordinates: [inputFeature.geometry.coordinates] };
  const bbox = geometryBbox(geometry);
  const collection: FeatureCollection<BaliBoundaryProperties> = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      id: "bali-province",
      geometry,
      properties: {
        boundaryKey: "bali-province",
        name: "Provinsi Bali",
        source: "GADM 4.0",
        osmRelationId: RELATION_ID,
        osmVersion: 43,
        osmTimestamp: "2026-05-17T06:38:57Z",
        osmRelationUrl: SOURCE_URL,
        sourceUrl: "https://gadm.org/download_country.html",
        license: "GADM data licence",
        attribution: "GADM 4.0 land geometry; province reference OpenStreetMap relation 1615621",
        importedAt: new Date().toISOString(),
        bbox,
        geometrySource: "GADM 4.0 land polygons",
        geometrySourceUrl: "https://github.com/mahendrayudha/indonesia-geojson/tree/main/Bali/Provinsi",
        relationBoundaryKind: "maritime-administrative"
      }
    }]
  };
  const validation = validateBaliBoundary(collection);
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(collection)}\n`, "utf8");
  console.log(JSON.stringify({ event: "bali_boundary_bootstrapped", output: OUTPUT_PATH, relationId: RELATION_ID, ...validation }));
}

async function checkBoundary() {
  const collection = JSON.parse(await readFile(OUTPUT_PATH, "utf8")) as FeatureCollection<BaliBoundaryProperties>;
  const validation = validateBaliBoundary(collection);
  console.log(JSON.stringify({ event: "bali_boundary_valid", output: OUTPUT_PATH, ...validation }));
}

const checkOnly = process.argv.includes("--check");
const bootstrapIndex = process.argv.indexOf("--bootstrap");
const task = checkOnly
  ? checkBoundary()
  : bootstrapIndex >= 0 && process.argv[bootstrapIndex + 1]
    ? importBootstrapBoundary(process.argv[bootstrapIndex + 1]!)
    : importBoundary();
void task.catch((error) => {
  console.error(JSON.stringify({ event: "bali_boundary_failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
