import type { BasemapConfig } from "@/lib/dashboard/types";

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>';

type MapEnv = {
  [key: string]: string | undefined;
  BASEMAP_TILE_URL?: string;
  BASEMAP_ATTRIBUTION?: string;
  BASEMAP_DEPLOYMENT_MODE?: string;
};

function validTileUrl(value: string | undefined) {
  if (!value) return OSM_TILE_URL;
  if (!value.startsWith("https://") || !value.includes("{z}") || !value.includes("{x}") || !value.includes("{y}")) {
    return OSM_TILE_URL;
  }
  return value;
}

export function getBasemapConfig(env: MapEnv = process.env): BasemapConfig {
  return {
    tileUrl: validTileUrl(env.BASEMAP_TILE_URL),
    attribution: env.BASEMAP_ATTRIBUTION?.trim() || OSM_ATTRIBUTION,
    minZoom: 7,
    maxZoom: 19,
    deploymentMode: env.BASEMAP_DEPLOYMENT_MODE === "managed" ? "managed" : "demo-internal",
    boundaryUrl: "/geography/bali-province.geojson",
    regencyBoundaryUrl: "/geography/bali-regencies.geojson"
  };
}
