import type { FeatureCollection, RegencyBoundaryProperties } from "@/lib/dashboard/types";
import type { Map as MapLibreMap } from "maplibre-gl";

export type RemovableMapMarker = { remove: () => void };

const LABEL_ANCHOR_OVERRIDES: Record<string, [number, number]> = {
  // The polygon centroid is pulled toward Nusa Penida. Semarapura is the
  // mainland administrative and road-network anchor for Klungkung.
  "bali-klungkung": [115.39737, -8.53443]
};

export async function addRegencyMarkers(
  maplibregl: typeof import("maplibre-gl"),
  map: MapLibreMap,
  boundaryUrl: string,
  signal: AbortSignal
): Promise<RemovableMapMarker[]> {
  const response = await fetch(boundaryUrl, { signal });
  if (!response.ok) throw new Error("Regency boundary labels are unavailable.");
  const collection = await response.json() as FeatureCollection<RegencyBoundaryProperties>;
  return collection.features.flatMap((feature) => {
    const center = LABEL_ANCHOR_OVERRIDES[feature.properties.zoneKey] ??
      feature.properties.center;
    if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) return [];
    const element = document.createElement("div");
    element.className = "bali-regency-marker";
    element.dataset.regencyLabel = feature.properties.zoneKey;
    element.setAttribute("aria-label", `${feature.properties.name} administrative area`);
    const dot = document.createElement("span");
    dot.className = "bali-regency-marker__dot";
    const label = document.createElement("span");
    label.textContent = feature.properties.name;
    element.append(dot, label);
    return [new maplibregl.Marker({ element, anchor: "center" }).setLngLat(center).addTo(map)];
  });
}
