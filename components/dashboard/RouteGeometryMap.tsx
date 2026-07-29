"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { BasemapConfig, FeatureCollection } from "@/lib/dashboard/types";
import { routeConditionStyle } from "@/lib/map/route-condition";
import { addRegencyMarkers, type RemovableMapMarker } from "@/lib/map/regency-markers";

type RouteGeometry = FeatureCollection<Record<string, unknown>>;

function coordinates(data: RouteGeometry) {
  return data.features.flatMap((feature) =>
    feature.geometry.type === "LineString" ? feature.geometry.coordinates : []
  );
}

export function RouteGeometryMap({ data, config, ratioVsTypical }: { data: RouteGeometry | null; config: BasemapConfig; ratioVsTypical: number | null }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [rendered, setRendered] = useState(false);
  const condition = routeConditionStyle(ratioVsTypical);

  useEffect(() => {
    let disposed = false;
    let revealTimer: number | undefined;
    const markerController = new AbortController();
    let regencyMarkers: RemovableMapMarker[] = [];
    setUnavailable(false);
    setRendered(false);
    async function initialize() {
      const maplibregl = await import("maplibre-gl");
      if (disposed || !container.current) return;
      const canvas = document.createElement("canvas");
      if (!canvas.getContext("webgl2") && !canvas.getContext("webgl")) {
        setUnavailable(true);
        return;
      }
      const map = new maplibregl.Map({
        container: container.current,
        center: [115.15, -8.45], zoom: 8.4, minZoom: config.minZoom, maxZoom: config.maxZoom,
        maxBounds: [[113.9, -9.4], [116.3, -7.55]], renderWorldCopies: false,
        attributionControl: { compact: true },
        style: {
          version: 8,
          sources: { basemap: { type: "raster", tiles: [config.tileUrl], tileSize: 256, attribution: config.attribution } },
          layers: [{ id: "osm", type: "raster", source: "basemap", paint: {
            "raster-saturation": -1,
            "raster-contrast": -0.14,
            "raster-brightness-min": 0.02,
            "raster-brightness-max": 0.42
          } }]
        }
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        if (disposed) return;
        map.addSource("bali-boundary", { type: "geojson", data: config.boundaryUrl });
        map.addLayer({ id: "bali-boundary-fill", type: "fill", source: "bali-boundary", paint: { "fill-color": "#626866", "fill-opacity": 0.72 } });
        map.addSource("bali-regencies", { type: "geojson", data: config.regencyBoundaryUrl });
        map.addLayer({ id: "bali-regencies-fill", type: "fill", source: "bali-regencies", paint: {
          "fill-color": ["match", ["get", "zoneKey"],
            "bali-badung", "#555b59", "bali-bangli", "#626866", "bali-buleleng", "#5b615f",
            "bali-denpasar", "#686e6c", "bali-gianyar", "#5f6563", "bali-jembrana", "#515755",
            "bali-karangasem", "#646a68", "bali-klungkung", "#595f5d", "bali-tabanan", "#575d5b", "#5b615f"],
          "fill-opacity": 0.42
        } });
        map.addLayer({ id: "bali-regencies-line", type: "line", source: "bali-regencies", paint: {
          "line-color": "#c2cbc8",
          "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.45, 10, 0.75, 14, 1.2],
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.46, 11, 0.64, 15, 0.78]
        } });
        map.addLayer({ id: "bali-boundary-line", type: "line", source: "bali-boundary", paint: {
          "line-color": "#e2e9e6",
          "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1, 12, 1.7, 16, 2.2],
          "line-opacity": 0.9
        } });
        void addRegencyMarkers(maplibregl, map, config.regencyBoundaryUrl, markerController.signal)
          .then((markers) => {
            if (disposed) markers.forEach((marker) => marker.remove());
            else regencyMarkers = markers;
          })
          .catch(() => undefined);
        map.addSource("route", { type: "geojson", data: data ?? { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "route-casing", type: "line", source: "route", paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, condition.width * .68 + 3, 14, condition.width + 3],
          "line-opacity": .9
        } });
        map.addLayer({ id: "route-line", type: "line", source: "route", paint: {
          "line-color": condition.color,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, condition.width * .68, 14, condition.width]
        } });
        const points = data ? coordinates(data) : [];
        if (points.length) {
          const bounds = points.reduce((bounds, point) => bounds.extend(point), new maplibregl.LngLatBounds(points[0], points[0]));
          map.fitBounds(bounds, { padding: 45, maxZoom: 13, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500 });
        }
        const reveal = () => {
          if (!disposed) setRendered(true);
        };
        map.once("idle", reveal);
        // A slow or unavailable raster basemap must not hold the useful HERE
        // geometry behind the loading state indefinitely.
        revealTimer = window.setTimeout(reveal, 1_500);
      });
    }
    void initialize().catch(() => setUnavailable(true));
    return () => {
      disposed = true;
      if (revealTimer !== undefined) window.clearTimeout(revealTimer);
      markerController.abort();
      regencyMarkers.forEach((marker) => marker.remove());
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [condition.color, condition.width, config.attribution, config.boundaryUrl, config.maxZoom, config.minZoom, config.regencyBoundaryUrl, config.tileUrl, data]);

  if (unavailable) return <div className="grid h-72 place-items-center bg-[#eef2ef] px-6 text-center text-sm text-[#687872]">WebGL is unavailable. The ordered route geometry remains available.</div>;
  return <div className="relative bg-[#252827]" aria-busy={!rendered} data-testid="route-geometry-stage"><div ref={container} className="h-72 w-full" aria-label="Actual route geometry" data-testid="route-geometry-map" data-map-ready={rendered || undefined} data-admin-boundaries="administrative-regencies" />{!rendered ? <RouteGeometrySkeleton overlay /> : null}<div className={`pointer-events-none absolute bottom-3 left-3 rounded-xl border border-white/80 bg-white/95 px-3 py-2 text-xs font-bold shadow-sm transition-opacity ${rendered ? "opacity-100" : "opacity-0"}`}><span className="mr-2 inline-block h-1.5 w-7 rounded-full align-middle" style={{ backgroundColor: condition.color }} />{condition.label}</div></div>;
}

export function RouteGeometrySkeleton({ overlay = false }: { overlay?: boolean }) {
  return <div className={`${overlay ? "absolute inset-0 z-20" : "relative h-72"} overflow-hidden bg-[#eef2ef] p-4`} role="status" aria-label="Loading route map">
    <div className="route-map-skeleton-frame h-full w-full rounded-xl" aria-hidden="true" />
    <span className="sr-only">Preparing cached route geometry and map layers…</span>
  </div>;
}
