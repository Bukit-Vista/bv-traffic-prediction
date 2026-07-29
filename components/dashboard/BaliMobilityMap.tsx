"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature, VectorTileSource } from "maplibre-gl";
import type {
  BaliBoundaryProperties,
  BasemapConfig,
  CenterProperties,
  DisplayGridProperties,
  FeatureCollection,
  FlowProperties,
  Geometry,
  GeoJsonFeature,
  IncidentProperties,
  MobilityFlowProperties,
  MobilityZoneProperties,
  TrafficTileSnapshot
} from "@/lib/dashboard/types";
import {
  createOdEndpointCollection,
  createOdParticleCollection,
  OD_ANIMATION_FPS
} from "@/lib/map/od-animation";
import { addRegencyMarkers, type RemovableMapMarker } from "@/lib/map/regency-markers";
import { appendTrafficTileClientRevision, resolveTrafficTileUrlTemplate } from "@/lib/map/traffic-tile-url";
import { TrafficJamLegend } from "@/components/dashboard/TrafficJamLegend";
import type { Bbox } from "@/lib/map/viewport";
import {
  PULSE_MIN_JAM_FACTOR,
  TRAFFIC_HEARTBEAT_ENABLED,
  TRAFFIC_HEARTBEAT_FPS,
  getCachedTrafficHeatmap,
  getOrCreateTrafficHeatmap,
  trafficHeatmapLodForZoom,
  trafficJamColorExpression,
  trafficJamPointRadiusExpression,
  trafficHeartbeatOpacityExpression,
  trafficHeartbeatRadiusExpression,
  type TrafficHeatmapLod,
  type TrafficHeatPointProperties
} from "@/lib/map/traffic-heatmap";

export type MapLayers = {
  mobility: boolean;
  flows: boolean;
  traffic: boolean;
  heatmap: boolean;
  incidents: boolean;
  centers: boolean;
  placesHeatmap: boolean;
};

export type FlowVisualMode = "general";

export type MapSelection =
  | { kind: "zone"; feature: GeoJsonFeature<MobilityZoneProperties> }
  | { kind: "flow"; feature: GeoJsonFeature<MobilityFlowProperties> }
  | { kind: "traffic"; feature: GeoJsonFeature<FlowProperties> }
  | { kind: "incident"; feature: GeoJsonFeature<IncidentProperties> }
  | { kind: "center"; feature: GeoJsonFeature<CenterProperties> }
  | { kind: "displayGrid"; feature: GeoJsonFeature<DisplayGridProperties> }
  | null;

export type MapDataset = {
  flow: FeatureCollection<FlowProperties>;
  incidents: FeatureCollection<IncidentProperties>;
  zones: FeatureCollection<MobilityZoneProperties>;
  mobilityFlows: FeatureCollection<MobilityFlowProperties>;
  centers: FeatureCollection<CenterProperties>;
  displayGrid: FeatureCollection<DisplayGridProperties>;
};

type Metric = "presence" | "inbound" | "outbound" | "attraction";

const OD_ARROW_SIZE_MULTIPLIER = 1.25;

const SOURCE = {
  boundary: "bali-boundary-source",
  regencies: "bali-regencies-source",
  zones: "mobility-zones-source",
  flows: "mobility-flows-source",
  flowEndpoints: "mobility-flow-endpoints-source",
  flowParticles: "mobility-flow-particles-source",
  traffic: "traffic-flow-source",
  trafficHeatmap: "traffic-heatmap-source",
  trafficTiles: "traffic-vector-tile-source",
  trafficFallbackTiles: "traffic-vector-tile-fallback-source",
  centers: "activity-centers-source",
  displayGridCells: "places-display-grid-cells-source",
  incidents: "incidents-source",
  selection: "selection-source"
} as const;

const LAYER = {
  basemap: "osm-basemap",
  boundaryFill: "bali-boundary-focus",
  regenciesFill: "bali-regencies-fill",
  regenciesLine: "bali-regencies-line",
  boundaryLine: "bali-boundary-outline",
  zonesFill: "mobility-zones-fill",
  zonesLine: "mobility-zones-line",
  flows: "mobility-flows-line",
  flowArrows: "mobility-flow-arrows",
  flowOrigins: "mobility-flow-origins",
  flowDestinations: "mobility-flow-destinations",
  flowDestinationArrows: "mobility-flow-destination-arrows",
  flowParticleHalo: "mobility-flow-particle-halo",
  flowParticles: "mobility-flow-particles",
  trafficHeatmap: "traffic-jam-heatmap",
  trafficHeatPulse: "traffic-jam-heartbeat",
  trafficFallbackCasing: "traffic-flow-fallback-casing",
  trafficFallback: "traffic-flow-fallback-line",
  trafficCasing: "traffic-flow-casing",
  traffic: "traffic-flow-line",
  trafficHit: "traffic-flow-hit-area",
  centersHeatmap: "activity-centers-heatmap",
  centers: "activity-centers-circle",
  displayGridStack: "places-display-grid-stack",
  displayGridCells: "places-display-grid-cells",
  displayGridOutline: "places-display-grid-outline",
  incidentsHalo: "incidents-halo",
  incidents: "incidents-circle",
  selectionFill: "selection-fill",
  selectionHalo: "selection-halo",
  selectionLine: "selection-line",
  selectionPoint: "selection-point"
} as const;

const EMPTY_COLLECTION = { type: "FeatureCollection", features: [] } as const;
const INTERACTIVE_LAYERS = [
  LAYER.incidents,
  LAYER.centers,
  LAYER.displayGridCells,
  LAYER.trafficHit,
  LAYER.traffic,
  LAYER.trafficFallback,
  LAYER.flows,
  LAYER.zonesFill
];
const TRAFFIC_RENDER_LAYERS = new Set<string>([
  LAYER.trafficHit,
  LAYER.traffic,
  LAYER.trafficFallback,
  LAYER.trafficCasing,
  LAYER.trafficFallbackCasing
]);

function asMapData(value: unknown) {
  return value as Parameters<GeoJSONSource["setData"]>[0];
}

function setSourceData(map: MapLibreMap, sourceId: string, data: unknown) {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(asMapData(data));
}

function addZoneCenterMarkers(
  maplibregl: typeof import("maplibre-gl"),
  map: MapLibreMap,
  zones: MapDataset["zones"],
  onSelect: (selection: MapSelection) => void
) {
  return zones.features.flatMap((feature) => {
    const longitude = Number(feature.properties.longitude);
    const latitude = Number(feature.properties.latitude);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];
    const element = document.createElement("button");
    element.type = "button";
    element.className = `catchment-area-marker${feature.properties.displayOnly ? " catchment-area-marker--display-only" : ""}`;
    element.dataset.catchmentKey = String(feature.properties.catchmentKey ?? feature.properties.zoneKey);
    element.setAttribute("aria-label", `${feature.properties.name} catchment`);
    const dot = document.createElement("span");
    dot.className = "catchment-area-marker__dot";
    const label = document.createElement("span");
    label.textContent = feature.properties.name;
    element.append(dot, label);
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect({ kind: "zone", feature });
    });
    return [new maplibregl.Marker({ element, anchor: "center" })
      .setLngLat([longitude, latitude])
      .addTo(map)];
  });
}

function interactiveFeatureNearPoint(
  map: MapLibreMap,
  point: { x: number; y: number },
  padding: number
) {
  const availableLayers = INTERACTIVE_LAYERS.filter((layerId) => map.getLayer(layerId));
  const trafficLayers = availableLayers.filter((layerId) => TRAFFIC_RENDER_LAYERS.has(layerId));
  const queryPoint = [point.x, point.y] as [number, number];
  const queryArea = [
    [point.x - padding, point.y - padding],
    [point.x + padding, point.y + padding]
  ] as [[number, number], [number, number]];
  const directRoadHit = trafficLayers.length
    ? map.queryRenderedFeatures(queryPoint, { layers: trafficLayers })[0]
    : undefined;
  if (directRoadHit) return directRoadHit;
  const directHit = availableLayers.length
    ? map.queryRenderedFeatures(queryPoint, { layers: availableLayers })[0]
    : undefined;
  if (directHit) return directHit;
  const nearbyRoadHit = trafficLayers.length
    ? map.queryRenderedFeatures(queryArea, { layers: trafficLayers })[0]
    : undefined;
  if (nearbyRoadHit) return nearbyRoadHit;
  return availableLayers.length
    ? map.queryRenderedFeatures(queryArea, { layers: availableLayers })[0]
    : undefined;
}

function findFeature<T extends Record<string, unknown>>(
  collection: FeatureCollection<T>,
  id: string | number | undefined
) {
  return collection.features.find((feature) => String(feature.id) === String(id));
}

function renderedTrafficFeature(feature: MapGeoJSONFeature): GeoJsonFeature<FlowProperties> {
  const properties = feature.properties as Record<string, unknown>;
  const numberOrNull = (value: unknown) => value == null || value === "" ? null : Number(value);
  return {
    type: "Feature",
    id: feature.id,
    geometry: feature.geometry as Geometry,
    properties: {
      ...properties,
      segmentId: Number(properties.segmentId ?? feature.id),
      segmentKey: String(properties.segmentKey ?? feature.id ?? "unknown-segment"),
      roadName: String(properties.roadName ?? "Unnamed road"),
      functionalClass: numberOrNull(properties.functionalClass),
      lengthMeters: numberOrNull(properties.lengthMeters),
      collectionSlotUtc: properties.collectionSlotUtc == null ? undefined : String(properties.collectionSlotUtc),
      sourceUpdatedUtc: properties.sourceUpdatedUtc == null ? null : String(properties.sourceUpdatedUtc),
      fetchedAtUtc: properties.fetchedAtUtc == null ? undefined : String(properties.fetchedAtUtc),
      speedKph: numberOrNull(properties.speedKph),
      freeFlowKph: numberOrNull(properties.freeFlowKph),
      relativeSpeed: numberOrNull(properties.relativeSpeed),
      jamFactor: numberOrNull(properties.jamFactor),
      jamTendency: numberOrNull(properties.jamTendency),
      confidence: numberOrNull(properties.confidence),
      traversability: properties.traversability == null ? null : String(properties.traversability),
      roadClosure: properties.roadClosure === true || properties.roadClosure === 1
    }
  };
}

function resolveSelection(source: string, id: string | number | undefined, data: MapDataset, rendered?: MapGeoJSONFeature): MapSelection {
  if (source === SOURCE.zones) {
    const feature = findFeature(data.zones, id);
    return feature ? { kind: "zone", feature } : null;
  }
  if (source === SOURCE.flows) {
    const feature = findFeature(data.mobilityFlows, id);
    return feature ? { kind: "flow", feature } : null;
  }
  if (source === SOURCE.traffic) {
    const feature = data.flow.features.find((candidate) =>
      String(candidate.id) === String(id) ||
      String(candidate.properties.segmentId) === String(id) ||
      candidate.properties.segmentKey === String(id));
    if (feature) return { kind: "traffic", feature };
    return rendered ? { kind: "traffic", feature: renderedTrafficFeature(rendered) } : null;
  }
  if (
    source === SOURCE.trafficTiles ||
    source === SOURCE.trafficFallbackTiles ||
    Boolean(rendered && TRAFFIC_RENDER_LAYERS.has(rendered.layer.id))
  ) {
    const feature = data.flow.features.find((candidate) =>
      String(candidate.id) === String(id) ||
      String(candidate.properties.segmentId) === String(id) ||
      candidate.properties.segmentKey === String(id));
    if (feature) return { kind: "traffic", feature };
    return rendered ? { kind: "traffic", feature: renderedTrafficFeature(rendered) } : null;
  }
  if (source === SOURCE.incidents) {
    const feature = findFeature(data.incidents, id);
    return feature ? { kind: "incident", feature } : null;
  }
  if (source === SOURCE.centers) {
    const feature = findFeature(data.centers, id);
    return feature ? { kind: "center", feature } : null;
  }
  if (source === SOURCE.displayGridCells) {
    const feature = findFeature(data.displayGrid, id);
    return feature ? { kind: "displayGrid", feature } : null;
  }
  return null;
}

function visibility(value: boolean) {
  return value ? "visible" : "none";
}

function odRouteJamArrowExpression() {
  return [
    "step",
    ["coalesce", ["get", "directionalCongestionIndex"], -1],
    "mobility-od-arrow-neutral",
    0, "mobility-od-arrow-free",
    0.2, "mobility-od-arrow-light",
    0.4, "mobility-od-arrow-moderate",
    0.6, "mobility-od-arrow-high",
    0.8, "mobility-od-arrow-severe"
  ];
}

export function BaliMobilityMap({
  active = true,
  data,
  metric,
  layers,
  minMobilityScore,
  minTrafficConfidence,
  selection,
  onSelect,
  config,
  flowIdentity,
  trafficTiles = null,
  onViewportChange,
  onBasemapError,
  onDisplayGridRendered,
  showRegencyContext = true,
  showZoneCenters = false,
  zoneStyle = "prediction",
  flowVisualMode = "general",
  renderCentersAsHeatmap = false,
  compact = false,
  expanded = false
}: {
  active?: boolean;
  data: MapDataset;
  metric: Metric;
  layers: MapLayers;
  minMobilityScore: number;
  minTrafficConfidence: number;
  selection: MapSelection;
  onSelect: (selection: MapSelection) => void;
  config: BasemapConfig;
  flowIdentity: string;
  trafficTiles?: TrafficTileSnapshot | null;
  onViewportChange?: (bbox: Bbox, zoom: number) => void;
  onBasemapError?: (message: string | null) => void;
  onDisplayGridRendered?: () => void;
  showRegencyContext?: boolean;
  showZoneCenters?: boolean;
  zoneStyle?: "prediction" | "context" | "catchmentPrediction";
  flowVisualMode?: FlowVisualMode;
  renderCentersAsHeatmap?: boolean;
  compact?: boolean;
  expanded?: boolean;
}) {
  const usesTrafficTiles = Boolean(trafficTiles);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dataRef = useRef(data);
  const onSelectRef = useRef(onSelect);
  const onViewportChangeRef = useRef(onViewportChange);
  const onBasemapErrorRef = useRef(onBasemapError);
  const onDisplayGridRenderedRef = useRef(onDisplayGridRendered);
  const refreshZoneCenterMarkersRef = useRef<(zones: MapDataset["zones"]) => void>(() => undefined);
  const flowIdentityRef = useRef(flowIdentity);
  const trafficTilesRef = useRef(trafficTiles);
  const appliedTrafficTileVersionRef = useRef<string | null>(null);
  const appliedFlowIdentityRef = useRef<string | null>(null);
  const appliedFlowCollectionRef = useRef<FeatureCollection<FlowProperties> | null>(null);
  const appliedHeatmapKeyRef = useRef<string | null>(null);
  const acknowledgedDisplayGridRef = useRef<MapDataset["displayGrid"] | null>(null);
  const sourceUpdateStartedAtRef = useRef({ traffic: 0, heatmap: 0 });
  const appliedAuxCollectionsRef = useRef<{
    zones: MapDataset["zones"] | null;
    mobilityFlows: MapDataset["mobilityFlows"] | null;
    centers: MapDataset["centers"] | null;
    displayGrid: MapDataset["displayGrid"] | null;
    incidents: MapDataset["incidents"] | null;
  }>({ zones: null, mobilityFlows: null, centers: null, displayGrid: null, incidents: null });
  const requestHeatmapForZoomRef = useRef<(zoom: number) => void>(() => undefined);
  const resumeHeartbeatRef = useRef<() => void>(() => undefined);
  const [ready, setReady] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [renderRecoveryCount, setRenderRecoveryCount] = useState(0);
  const [renderedOdParticleCount, setRenderedOdParticleCount] = useState(0);
  const [trafficHeatmapState, setTrafficHeatmapState] = useState(() => {
    const lod = trafficHeatmapLodForZoom(8.5);
    const collection: FeatureCollection<TrafficHeatPointProperties> = trafficTiles
      ? { type: "FeatureCollection", features: [] }
      : getOrCreateTrafficHeatmap(flowIdentity, data.flow, lod);
    return { identity: flowIdentity, lod, collection };
  });
  const trafficHeatmap = trafficHeatmapState.collection;
  const trafficHeatmapKey = `${trafficHeatmapState.identity}|${trafficHeatmapState.lod}`;
  const hasHeartbeatPoints = useMemo(
    () => TRAFFIC_HEARTBEAT_ENABLED && (trafficTiles
      ? trafficTiles.pulsePointCount > 0
      : trafficHeatmap.features.some((feature) =>
        feature.properties.jamFactor >= PULSE_MIN_JAM_FACTOR &&
        (feature.properties.confidence ?? 0) >= minTrafficConfidence
      )),
    [minTrafficConfidence, trafficHeatmap, trafficTiles]
  );
  const trafficHeatmapRef = useRef(trafficHeatmap);
  const trafficHeatmapKeyRef = useRef(trafficHeatmapKey);

  dataRef.current = data;
  flowIdentityRef.current = flowIdentity;
  trafficTilesRef.current = trafficTiles;
  trafficHeatmapRef.current = trafficHeatmap;
  trafficHeatmapKeyRef.current = trafficHeatmapKey;
  onSelectRef.current = onSelect;
  onViewportChangeRef.current = onViewportChange;
  onBasemapErrorRef.current = onBasemapError;
  onDisplayGridRenderedRef.current = onDisplayGridRendered;

  useEffect(() => {
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(motionPreference.matches);
    updatePreference();
    motionPreference.addEventListener("change", updatePreference);
    return () => motionPreference.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    let disposed = false;
    let idleId: number | undefined;
    let timerId: number | undefined;

    const cancelPendingBuild = () => {
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (timerId !== undefined) window.clearTimeout(timerId);
      idleId = undefined;
      timerId = undefined;
    };

    if (trafficTiles) {
      requestHeatmapForZoomRef.current = () => undefined;
      return () => {
        disposed = true;
        cancelPendingBuild();
      };
    }

    const requestLod = (zoom: number) => {
      const lod = trafficHeatmapLodForZoom(zoom);
      const cached = getCachedTrafficHeatmap(flowIdentity, lod, data.flow);
      cancelPendingBuild();
      if (cached) {
        setTrafficHeatmapState((current) => current.identity === flowIdentity && current.lod === lod
          ? current
          : { identity: flowIdentity, lod, collection: cached });
        return;
      }
      const build = () => {
        if (disposed) return;
        const collection = getOrCreateTrafficHeatmap(flowIdentity, data.flow, lod);
        if (!disposed && flowIdentityRef.current === flowIdentity) {
          setTrafficHeatmapState({ identity: flowIdentity, lod, collection });
        }
      };
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(build, { timeout: 300 });
      } else {
        timerId = window.setTimeout(build, 0);
      }
    };

    requestHeatmapForZoomRef.current = requestLod;
    requestLod(mapRef.current?.getZoom() ?? 8.5);
    return () => {
      disposed = true;
      cancelPendingBuild();
      requestHeatmapForZoomRef.current = () => undefined;
    };
  }, [data.flow, flowIdentity, trafficTiles]);

  useEffect(() => {
    // Readiness belongs to the MapLibre instance lifecycle. Data/heatmap
    // refreshes update existing sources and must never hide a live canvas.
    setReady(false);
    setRendered(false);
    let disposed = false;
    let moveTimer: number | undefined;
    let recoveryTimer: number | undefined;
    let trafficRetryTimer: number | undefined;
    let revealFrame: number | undefined;
    let selectionFrame: number | undefined;
    let trafficRetryAttempts = 0;
    let requestedHeatmapLod: TrafficHeatmapLod = trafficHeatmapLodForZoom(8.5);
    let resizeObserver: ResizeObserver | undefined;
    const markerController = new AbortController();
    let regencyMarkers: RemovableMapMarker[] = [];
    let zoneCenterMarkers: RemovableMapMarker[] = [];

    async function initialize() {
      try {
        const maplibregl = await import("maplibre-gl");
        if (disposed || !containerRef.current) return;
        const probe = document.createElement("canvas");
        if (!probe.getContext("webgl2") && !probe.getContext("webgl")) {
          setFallback(true);
          return;
        }
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const map = new maplibregl.Map({
          container: containerRef.current,
          center: [115.15, -8.45],
          zoom: 8.5,
          minZoom: config.minZoom,
          maxZoom: config.maxZoom,
          maxBounds: [[113.9, -9.4], [116.3, -7.55]],
          renderWorldCopies: false,
          maxTileCacheZoomLevels: 8,
          cancelPendingTileRequestsWhileZooming: false,
          attributionControl: { compact: true },
          fadeDuration: reducedMotion ? 0 : 150,
          style: {
            version: 8,
            sources: {
              basemap: {
                type: "raster",
                tiles: [config.tileUrl],
                tileSize: 256,
                minzoom: config.minZoom,
                maxzoom: config.maxZoom,
                attribution: config.attribution
              }
            },
            layers: [{
              id: LAYER.basemap,
              type: "raster",
              source: "basemap",
              paint: {
                "raster-saturation": -1,
                "raster-contrast": -0.14,
                "raster-brightness-min": 0.02,
                "raster-brightness-max": 0.42
              }
            }]
          }
        });
        mapRef.current = map;
        resizeObserver = new ResizeObserver(() => map.resize());
        resizeObserver.observe(containerRef.current);
        requestedHeatmapLod = trafficHeatmapLodForZoom(map.getZoom());
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
        map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

        const markTrafficFeedReady = () => {
          if (containerRef.current?.dataset.trafficFeedState !== "updating") return;
          const startedAt = Number(containerRef.current.dataset.trafficFeedStartedAt);
          containerRef.current.dataset.trafficFeedState = "ready";
          containerRef.current.dataset.trafficFeedMs = Number.isFinite(startedAt)
            ? String(Math.max(0, Math.round(performance.now() - startedAt)))
            : "0";
        };

        map.once("style.load", () => {
          if (disposed) return;
          map.addSource(SOURCE.boundary, { type: "geojson", data: config.boundaryUrl });
          map.addLayer({ id: LAYER.boundaryFill, type: "fill", source: SOURCE.boundary, paint: { "fill-color": "#626866", "fill-opacity": 0.72 } });
          map.addSource(SOURCE.regencies, { type: "geojson", data: config.regencyBoundaryUrl });
          map.addLayer({
            id: LAYER.regenciesFill,
            type: "fill",
            source: SOURCE.regencies,
            layout: { visibility: showRegencyContext ? "visible" : "none" },
            paint: {
              "fill-color": ["match", ["get", "zoneKey"],
                "bali-badung", "#555b59", "bali-bangli", "#626866", "bali-buleleng", "#5b615f",
                "bali-denpasar", "#686e6c", "bali-gianyar", "#5f6563", "bali-jembrana", "#515755",
                "bali-karangasem", "#646a68", "bali-klungkung", "#595f5d", "bali-tabanan", "#575d5b", "#5b615f"],
              "fill-opacity": 0.42
            }
          });
          map.addLayer({
            id: LAYER.regenciesLine,
            type: "line",
            source: SOURCE.regencies,
            layout: { visibility: showRegencyContext ? "visible" : "none" },
            paint: {
              "line-color": "#c2cbc8",
              "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.45, 10, 0.75, 14, 1.2],
              "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.46, 11, 0.64, 15, 0.78]
            }
          });
          map.addLayer({ id: LAYER.boundaryLine, type: "line", source: SOURCE.boundary, paint: { "line-color": "#e2e9e6", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1, 12, 1.7, 16, 2.2], "line-opacity": 0.9 } });
          if (showRegencyContext) {
            void addRegencyMarkers(maplibregl, map, config.regencyBoundaryUrl, markerController.signal)
              .then((markers) => {
                if (disposed) markers.forEach((marker) => marker.remove());
                else regencyMarkers = markers;
              })
              .catch(() => undefined);
          }
          if (showZoneCenters) {
            refreshZoneCenterMarkersRef.current = (zones) => {
              zoneCenterMarkers.forEach((marker) => marker.remove());
              zoneCenterMarkers = addZoneCenterMarkers(
                maplibregl,
                map,
                zones,
                (nextSelection) => onSelectRef.current(nextSelection)
              );
            };
            refreshZoneCenterMarkersRef.current(dataRef.current.zones);
          }

          map.addSource(SOURCE.zones, { type: "geojson", data: asMapData(dataRef.current.zones) });
          map.addLayer({
            id: LAYER.zonesFill,
            type: "fill",
            source: SOURCE.zones,
            paint: {
              // Retain an imperceptible fill so the full polygon remains an
              // accessible click target without competing with roads/stacks.
              "fill-color": "#ffffff",
              "fill-opacity": 0.001
            }
          });
          map.addLayer({
            id: LAYER.zonesLine,
            type: "line",
            source: SOURCE.zones,
            paint: {
              "line-color": ["case", ["boolean", ["get", "displayOnly"], false], "#5f6c67", "#ffffff"],
              "line-width": ["case", ["boolean", ["get", "displayOnly"], false], 2.25, ["interpolate", ["linear"], ["zoom"], 7, 0.45, 12, 0.9]],
              "line-opacity": 0.78
            }
          });

          map.addSource(SOURCE.flows, { type: "geojson", data: asMapData(dataRef.current.mobilityFlows) });
          map.addLayer({ id: LAYER.flows, type: "line", source: SOURCE.flows, paint: {
            "line-color": ["interpolate", ["linear"], ["get", "mobilityScore"],
              0, "#f3c96b", 35, "#eea348", 70, "#eb773d", 100, "#d94a38"],
            "line-opacity": ["interpolate", ["linear"], ["get", "confidence"], 0, 0.3, 1, 0.72],
            "line-dasharray": [2, 2],
            "line-width": ["interpolate", ["linear"], ["get", "mobilityScore"], 0, 0.8, 100, 2.4]
          } });
          const addArrowImage = (name: string, color: string) => {
            const arrowCanvas = document.createElement("canvas");
            arrowCanvas.width = 32;
            arrowCanvas.height = 32;
            const arrowContext = arrowCanvas.getContext("2d");
            if (!arrowContext) return;
            arrowContext.clearRect(0, 0, 32, 32);
            arrowContext.fillStyle = color;
            arrowContext.strokeStyle = "#ffffff";
            arrowContext.lineWidth = 3;
            arrowContext.lineJoin = "round";
            arrowContext.beginPath();
            arrowContext.moveTo(5, 7);
            arrowContext.lineTo(27, 16);
            arrowContext.lineTo(5, 25);
            arrowContext.lineTo(11, 16);
            arrowContext.closePath();
            arrowContext.stroke();
            arrowContext.fill();
            map.addImage(name, arrowContext.getImageData(0, 0, 32, 32), { pixelRatio: 2 });
          };
          [
            ["mobility-od-arrow", "#f06f3c"],
            ["mobility-od-arrow-neutral", "#667a73"],
            ["mobility-od-arrow-free", "#2f8f64"],
            ["mobility-od-arrow-light", "#d4a72c"],
            ["mobility-od-arrow-moderate", "#e67e32"],
            ["mobility-od-arrow-high", "#d6453d"],
            ["mobility-od-arrow-severe", "#8f1d2c"]
          ].forEach(([name, color]) => addArrowImage(name!, color!));
          map.addSource(SOURCE.flowEndpoints, { type: "geojson", data: asMapData(createOdEndpointCollection(dataRef.current.mobilityFlows)) });
          map.addLayer({ id: LAYER.flowOrigins, type: "circle", source: SOURCE.flowEndpoints, filter: ["==", ["get", "endpointType"], "origin"], paint: {
            "circle-radius": ["interpolate", ["linear"], ["get", "mobilityScore"], 0, 3.2, 100, 5],
            "circle-color": "#ffffff",
            "circle-opacity": 0.94,
            "circle-stroke-color": "#176657",
            "circle-stroke-width": 2
          } });
          map.addLayer({ id: LAYER.flowDestinations, type: "circle", source: SOURCE.flowEndpoints, filter: ["==", ["get", "endpointType"], "destination"], paint: {
            "circle-radius": ["interpolate", ["linear"], ["get", "mobilityScore"], 0, 4, 100, 6.2],
            "circle-color": "#f39a52",
            "circle-opacity": 0.98,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2
          } });
          map.addLayer({
            id: LAYER.flowDestinationArrows,
            type: "symbol",
            source: SOURCE.flowEndpoints,
            filter: ["==", ["get", "endpointType"], "destination"],
            layout: {
              "symbol-placement": "point",
              "icon-image": odRouteJamArrowExpression() as never,
              "icon-size": ["interpolate", ["linear"], ["get", "mobilityScore"],
                0, 0.72 * OD_ARROW_SIZE_MULTIPLIER,
                100, 1.15 * OD_ARROW_SIZE_MULTIPLIER],
              "icon-rotate": ["get", "arrowRotation"],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "icon-rotation-alignment": "map",
              "visibility": "visible"
            },
            paint: {
              "icon-opacity": ["interpolate", ["linear"], ["get", "confidence"], 0, 0.55, 1, 1]
            }
          });

          map.addSource(SOURCE.flowParticles, { type: "geojson", data: asMapData(EMPTY_COLLECTION) });
          map.addLayer({
            id: LAYER.flowArrows,
            type: "symbol",
            source: SOURCE.flowParticles,
            layout: {
              "symbol-placement": "point",
              "icon-image": odRouteJamArrowExpression() as never,
              "icon-size": ["interpolate", ["linear"], ["get", "mobilityScore"],
                0, 0.68 * OD_ARROW_SIZE_MULTIPLIER,
                100, 1.25 * OD_ARROW_SIZE_MULTIPLIER],
              "icon-rotate": ["get", "arrowRotation"],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "icon-rotation-alignment": "map",
              "visibility": "visible"
            },
            paint: {
              "icon-opacity": ["get", "particleOpacity"]
            }
          });
          map.addLayer({ id: LAYER.flowParticleHalo, type: "circle", source: SOURCE.flowParticles, layout: { visibility: "none" }, paint: {
            "circle-radius": ["interpolate", ["linear"], ["get", "mobilityScore"], 0, 7, 100, 11],
            "circle-color": "#ffffff",
            "circle-opacity": ["*", ["get", "particleOpacity"], 0.88],
            "circle-blur": 0.12
          } });
          map.addLayer({ id: LAYER.flowParticles, type: "circle", source: SOURCE.flowParticles, layout: { visibility: "none" }, paint: {
            "circle-radius": ["interpolate", ["linear"], ["get", "mobilityScore"], 0, 4, 100, 7],
            "circle-color": ["interpolate", ["linear"], ["get", "mobilityScore"], 0, "#ffd166", 100, "#f06f3c"],
            "circle-opacity": ["get", "particleOpacity"],
            "circle-stroke-color": "#5b2d1f",
            "circle-stroke-width": 1
          } });

          const tileSnapshot = trafficTilesRef.current;
          const trafficSource = tileSnapshot ? SOURCE.trafficTiles : SOURCE.traffic;
          const heatmapSource = tileSnapshot ? SOURCE.trafficTiles : SOURCE.trafficHeatmap;
          if (tileSnapshot) {
            const tileUrlTemplate = appendTrafficTileClientRevision(resolveTrafficTileUrlTemplate(
              tileSnapshot.tileUrlTemplate,
              window.location.origin
            ));
            map.addSource(SOURCE.trafficTiles, {
              type: "vector",
              tiles: [tileUrlTemplate],
              bounds: [114.34, -8.9, 115.78, -8.03],
              minzoom: tileSnapshot.minZoom,
              maxzoom: tileSnapshot.maxZoom
            });
            map.addSource(SOURCE.trafficFallbackTiles, {
              type: "vector",
              tiles: [tileUrlTemplate],
              bounds: [114.34, -8.9, 115.78, -8.03],
              minzoom: tileSnapshot.minZoom,
              maxzoom: tileSnapshot.minZoom
            });
            appliedTrafficTileVersionRef.current = tileSnapshot.version;
          } else {
            map.addSource(SOURCE.trafficHeatmap, { type: "geojson", data: asMapData(trafficHeatmapRef.current) });
            map.addSource(SOURCE.traffic, { type: "geojson", data: asMapData(dataRef.current.flow) });
          }
          if (tileSnapshot) {
            map.addLayer({
              id: LAYER.trafficFallbackCasing,
              type: "line",
              source: SOURCE.trafficFallbackTiles,
              "source-layer": tileSnapshot.sourceLayers.lines,
              minzoom: 7,
              maxzoom: config.maxZoom,
              paint: {
                "line-color": "#ffffff",
                "line-opacity": 0.24,
                "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.5, 11, 2.1, 15, 3]
              }
            });
            map.addLayer({
              id: LAYER.trafficFallback,
              type: "line",
              source: SOURCE.trafficFallbackTiles,
              "source-layer": tileSnapshot.sourceLayers.lines,
              minzoom: 7,
              maxzoom: config.maxZoom,
              paint: {
                "line-color": ["case", ["boolean", ["get", "roadClosure"], false], "#35131b", trafficJamColorExpression()] as never,
                "line-opacity": ["case", ["<", ["coalesce", ["get", "confidence"], 0], 0.6], 0.24, 0.42],
                "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.8, 11, 1.35, 15, 2.2]
              }
            });
          }
          map.addLayer({
            id: LAYER.trafficHeatmap,
            type: "circle",
            source: heatmapSource,
            ...(tileSnapshot ? { "source-layer": tileSnapshot.sourceLayers.pulsePoints } : {}),
            minzoom: 7,
            maxzoom: config.maxZoom,
            layout: { "circle-sort-key": ["coalesce", ["get", "jamFactor"], 0] },
            paint: {
              "circle-color": trafficJamColorExpression() as never,
              "circle-radius": trafficJamPointRadiusExpression() as never,
              "circle-opacity": ["*", ["interpolate", ["linear"], ["coalesce", ["get", "jamFactor"], 0], 0, 0.12, 4, 0.2, 6, 0.3, 10, 0.44], ["interpolate", ["linear"], ["coalesce", ["get", "confidence"], 0.5], 0, 0.5, 1, 1]],
              "circle-blur": ["interpolate", ["linear"], ["zoom"], 7, 0.82, 11, 0.55, 15, 0.28, 19, 0.08]
            }
          });
          map.addLayer({
            id: LAYER.trafficHeatPulse,
            type: "circle",
            source: heatmapSource,
            ...(tileSnapshot ? { "source-layer": tileSnapshot.sourceLayers.pulsePoints } : {}),
            minzoom: 7,
            maxzoom: config.maxZoom,
            layout: { visibility: "none" },
            filter: [">=", ["coalesce", ["get", "jamFactor"], 0], PULSE_MIN_JAM_FACTOR],
            paint: {
              "circle-color": trafficJamColorExpression() as never,
              "circle-radius": trafficHeartbeatRadiusExpression(0) as never,
              "circle-opacity": trafficHeartbeatOpacityExpression(0) as never,
              "circle-blur": ["interpolate", ["linear"], ["zoom"], 7, 0.68, 11, 0.42, 15, 0.18, 19, 0.05]
            }
          });

          map.addLayer({ id: LAYER.trafficCasing, type: "line", source: trafficSource, ...(tileSnapshot ? { "source-layer": tileSnapshot.sourceLayers.lines } : {}), paint: { "line-color": "#ffffff", "line-opacity": 0.82, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 2.3, 10, 3.2, 14, 5.5] } });
          map.addLayer({ id: LAYER.traffic, type: "line", source: trafficSource, ...(tileSnapshot ? { "source-layer": tileSnapshot.sourceLayers.lines } : {}), paint: {
            "line-color": ["case", ["boolean", ["get", "roadClosure"], false], "#35131b", trafficJamColorExpression()] as never,
            "line-opacity": ["case", ["<", ["coalesce", ["get", "confidence"], 0], 0.6], 0.56, 1],
            "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.25, 10, 2, 14, 4]
          } });
          map.addLayer({
            id: LAYER.trafficHit,
            type: "line",
            source: trafficSource,
            ...(tileSnapshot ? { "source-layer": tileSnapshot.sourceLayers.lines } : {}),
            paint: {
              // Keep the visual road width unchanged while providing a
              // forgiving pointer/touch target around every HERE segment.
              "line-color": "#000000",
              "line-opacity": 0.001,
              "line-width": ["interpolate", ["linear"], ["zoom"], 7, 18, 11, 24, 15, 30]
            }
          });

          map.addSource(SOURCE.centers, { type: "geojson", data: asMapData(dataRef.current.centers) });
          map.addLayer({
            id: LAYER.centersHeatmap,
            type: "heatmap",
            source: SOURCE.centers,
            maxzoom: 15,
            layout: { visibility: renderCentersAsHeatmap ? "visible" : "none" },
            paint: {
              "heatmap-weight": ["interpolate", ["linear"], ["coalesce", ["get", "attractionScore"], 0], 0, 0, 1, 1],
              "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 7, 0.75, 12, 1.35, 15, 1.8],
              "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 7, 16, 11, 30, 15, 46],
              "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.7, 13, 0.82, 15, 0.45],
              "heatmap-color": [
                "interpolate", ["linear"], ["heatmap-density"],
                0, "rgba(44,123,182,0)",
                0.18, "rgba(44,123,182,0.72)",
                0.38, "rgba(119,185,214,0.82)",
                0.58, "rgba(241,211,116,0.88)",
                0.78, "rgba(237,140,85,0.92)",
                1, "rgba(223,63,54,0.96)"
              ]
            }
          });
          map.addLayer({ id: LAYER.centers, type: "circle", source: SOURCE.centers, paint: {
            "circle-radius": ["case",
              ["==", ["get", "kind"], "place"], 2.4,
              ["interpolate", ["linear"], ["coalesce", ["get", "centerCount"], 1],
                1, 2.6, 25, 3.5, 250, 5.3, 2000, 7.2]
            ],
            "circle-color": ["match", ["get", "category"],
              "dining", "#ef4444", "accommodation", "#8b5cf6", "attraction", "#f59e0b",
              "culture", "#a855f7", "beach", "#06b6d4", "shopping", "#ec4899",
              "nightlife", "#6366f1", "recreation", "#22c55e", "transport", "#64748b", "#8b5cf6"],
            "circle-opacity": 0.72,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 0.9
          } });

          map.addSource(SOURCE.displayGridCells, { type: "geojson", data: asMapData(dataRef.current.displayGrid) });
          map.addLayer({
            id: LAYER.displayGridStack,
            type: "fill-extrusion",
            source: SOURCE.displayGridCells,
            layout: { visibility: "none" },
            paint: {
              "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "relativeIndex"], 0],
                0, "#2c7bb6", 20, "#2c7bb6", 40, "#77b9d6", 60, "#f1d374",
                80, "#ed8c55", 100, "#df3f36"],
              "fill-extrusion-height": ["interpolate", ["linear"], ["coalesce", ["get", "relativeIndex"], 0],
                0, 0, 20, 180, 40, 480, 60, 1050, 80, 2050, 100, 3500],
              "fill-extrusion-base": 0,
              "fill-extrusion-opacity": 0.82,
              "fill-extrusion-vertical-gradient": true
            }
          });
          map.addLayer({
            id: LAYER.displayGridCells,
            type: "fill",
            source: SOURCE.displayGridCells,
            minzoom: 9.5,
            layout: { visibility: "none" },
            paint: {
              // Transparent hit surface for hover/click. Rendering the fill
              // above the extrusion can visually flatten or cover 3D columns.
              "fill-color": "#000000",
              "fill-opacity": 0.001
            }
          });
          map.addLayer({
            id: LAYER.displayGridOutline,
            type: "line",
            source: SOURCE.displayGridCells,
            minzoom: 10.5,
            layout: { visibility: "none" },
            paint: { "line-color": "#ffffff", "line-opacity": 0.44, "line-width": 0.65 }
          });
          // The display grid is contextual. Keep measured roads and discrete
          // HERE Places legible above it.
          for (const layerId of [
            LAYER.trafficFallbackCasing, LAYER.trafficFallback,
            LAYER.trafficCasing, LAYER.traffic, LAYER.trafficHit, LAYER.centersHeatmap, LAYER.centers,
            LAYER.flows, LAYER.flowOrigins, LAYER.flowDestinations, LAYER.flowDestinationArrows,
            LAYER.flowParticleHalo, LAYER.flowArrows
          ]) {
            if (map.getLayer(layerId)) map.moveLayer(layerId);
          }
          // Keep directional predictions above the reference Places layer.
          for (const layerId of [LAYER.flows, LAYER.flowArrows, LAYER.flowOrigins, LAYER.flowDestinations, LAYER.flowDestinationArrows]) {
            map.moveLayer(layerId);
          }

          map.addSource(SOURCE.incidents, { type: "geojson", data: asMapData(dataRef.current.incidents) });
          map.addLayer({ id: LAYER.incidentsHalo, type: "circle", source: SOURCE.incidents, paint: { "circle-radius": 11, "circle-color": "#ffffff", "circle-stroke-color": "#bd3c38", "circle-stroke-width": 2 } });
          map.addLayer({ id: LAYER.incidents, type: "circle", source: SOURCE.incidents, paint: { "circle-radius": 4.5, "circle-color": "#bd3c38" } });

          map.addSource(SOURCE.selection, { type: "geojson", data: asMapData(EMPTY_COLLECTION) });
          map.addLayer({ id: LAYER.selectionFill, type: "fill", source: SOURCE.selection, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#ffffff", "fill-opacity": 0.001 } });
          map.addLayer({ id: LAYER.selectionHalo, type: "line", source: SOURCE.selection, filter: ["in", ["geometry-type"], ["literal", ["Polygon", "LineString"]]], paint: { "line-color": "#ffffff", "line-opacity": 0.95, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 5, 14, 9] } });
          map.addLayer({ id: LAYER.selectionLine, type: "line", source: SOURCE.selection, filter: ["in", ["geometry-type"], ["literal", ["Polygon", "LineString"]]], paint: { "line-color": "#087ea4", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 2.5, 14, 5] } });
          map.addLayer({ id: LAYER.selectionPoint, type: "circle", source: SOURCE.selection, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 11, "circle-color": "rgba(255,255,255,0.75)", "circle-stroke-color": "#102e27", "circle-stroke-width": 3 } });

          appliedFlowIdentityRef.current = flowIdentityRef.current;
          appliedFlowCollectionRef.current = dataRef.current.flow;
          appliedHeatmapKeyRef.current = trafficHeatmapKeyRef.current;
          sourceUpdateStartedAtRef.current = { traffic: performance.now(), heatmap: performance.now() };
          appliedAuxCollectionsRef.current = {
            zones: dataRef.current.zones,
            mobilityFlows: dataRef.current.mobilityFlows,
            centers: dataRef.current.centers,
            displayGrid: dataRef.current.displayGrid,
            incidents: dataRef.current.incidents
          };
          setReady(true);
          // The local boundary and overlay layers are now installed. Do not
          // keep the whole map behind the loading frame while a remote OSM
          // raster tile or a vector tile finishes (or retries). Reveal the
          // canvas on the next paint; source-specific warnings remain visible
          // and late tiles are drawn by MapLibre as they arrive.
          map.triggerRepaint();
          revealFrame = window.requestAnimationFrame(() => {
            if (!disposed) setRendered(true);
          });
        });

        map.on("click", (event) => {
          const hit = interactiveFeatureNearPoint(map, event.point, 18);
          const nextSelection = hit
            ? resolveSelection(String(hit.source), hit.id, dataRef.current, hit)
            : null;
          if (selectionFrame !== undefined) window.cancelAnimationFrame(selectionFrame);
          selectionFrame = window.requestAnimationFrame(() => {
            selectionFrame = undefined;
            onSelectRef.current(nextSelection);
          });
        });
        map.on("mousemove", (event) => {
          const hit = interactiveFeatureNearPoint(map, event.point, 8);
          map.getCanvas().style.cursor = hit ? "pointer" : "";
        });
        const verifyOverlaySources = () => {
          if (disposed || map.isMoving()) return;
          const now = performance.now();
          let recovered = false;
          let processing = false;
          if (map.getSource(SOURCE.traffic) && !map.isSourceLoaded(SOURCE.traffic)) {
            if (now - sourceUpdateStartedAtRef.current.traffic < 1_600) {
              processing = true;
            } else {
              setSourceData(map, SOURCE.traffic, dataRef.current.flow);
              sourceUpdateStartedAtRef.current.traffic = now;
              appliedFlowIdentityRef.current = flowIdentityRef.current;
              appliedFlowCollectionRef.current = dataRef.current.flow;
              recovered = true;
            }
          }
          if (map.getSource(SOURCE.trafficHeatmap) && !map.isSourceLoaded(SOURCE.trafficHeatmap)) {
            if (now - sourceUpdateStartedAtRef.current.heatmap < 1_600) {
              processing = true;
            } else {
              setSourceData(map, SOURCE.trafficHeatmap, trafficHeatmapRef.current);
              sourceUpdateStartedAtRef.current.heatmap = now;
              appliedHeatmapKeyRef.current = trafficHeatmapKeyRef.current;
              recovered = true;
            }
          }
          if (recovered) {
            setRenderRecoveryCount((count) => count + 1);
            map.triggerRepaint();
          } else if (processing) {
            recoveryTimer = window.setTimeout(verifyOverlaySources, 800);
          }
        };
        map.on("movestart", () => {
          window.clearTimeout(recoveryTimer);
        });
        map.on("zoomstart", () => {
          if (!trafficTilesRef.current || !containerRef.current) return;
          containerRef.current.dataset.trafficFeedState = "updating";
          containerRef.current.dataset.trafficFeedStartedAt = String(Math.round(performance.now()));
        });
        map.on("zoom", () => {
          const currentZoom = map.getZoom();
          const nextLod = trafficHeatmapLodForZoom(currentZoom);
          if (nextLod !== requestedHeatmapLod) {
            requestedHeatmapLod = nextLod;
            requestHeatmapForZoomRef.current(currentZoom);
          }
        });
        map.on("moveend", () => {
          window.clearTimeout(moveTimer);
          window.clearTimeout(recoveryTimer);
          requestHeatmapForZoomRef.current(map.getZoom());
          resumeHeartbeatRef.current();
          map.triggerRepaint();
          if (trafficTilesRef.current && map.isSourceLoaded(SOURCE.trafficTiles)) markTrafficFeedReady();
          moveTimer = window.setTimeout(() => {
            const bounds = map.getBounds();
            onViewportChangeRef.current?.(
              [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
              map.getZoom()
            );
          }, 100);
          recoveryTimer = window.setTimeout(verifyOverlaySources, 900);
        });
        map.on("idle", () => {
          if (!disposed) {
            setRendered(true);
            const collection = dataRef.current.displayGrid;
            if (appliedAuxCollectionsRef.current.displayGrid === collection &&
                acknowledgedDisplayGridRef.current !== collection &&
                map.getLayoutProperty(LAYER.displayGridStack, "visibility") === "visible") {
              acknowledgedDisplayGridRef.current = collection;
              onDisplayGridRenderedRef.current?.();
            }
          }
        });
        map.on("sourcedata", (event) => {
          if (!event.isSourceLoaded) return;
          if (event.sourceId === SOURCE.displayGridCells) {
            const collection = dataRef.current.displayGrid;
            if (appliedAuxCollectionsRef.current.displayGrid === collection &&
                acknowledgedDisplayGridRef.current !== collection) {
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                  if (!disposed && appliedAuxCollectionsRef.current.displayGrid === collection) {
                    acknowledgedDisplayGridRef.current = collection;
                    onDisplayGridRenderedRef.current?.();
                  }
                });
              });
            }
          }
          if (event.sourceId === SOURCE.trafficTiles) {
            window.clearTimeout(trafficRetryTimer);
            trafficRetryTimer = undefined;
            trafficRetryAttempts = 0;
            setWarning((current) => current?.startsWith("The traffic overlay") ? null : current);
            markTrafficFeedReady();
            setRendered(true);
          }
          if (event.sourceId === SOURCE.trafficFallbackTiles && containerRef.current) {
            containerRef.current.dataset.trafficFallbackState = "ready";
            setRendered(true);
          }
          if (event.sourceId === "basemap") {
            setWarning((current) => current?.startsWith("The basemap") ? null : current);
            onBasemapErrorRef.current?.(null);
          }
        });
        map.on("error", (event) => {
          const sourceId = (event as typeof event & { sourceId?: string }).sourceId;
          const errorMessage = String(event.error?.message ?? "");
          const activeTrafficSnapshot = trafficTilesRef.current;
          const isTrafficTileError = sourceId === SOURCE.trafficTiles || sourceId === SOURCE.trafficFallbackTiles || Boolean(
            activeTrafficSnapshot && errorMessage.includes(`/api/v1/traffic/tiles/${activeTrafficSnapshot.version}/`)
          );
          if (isTrafficTileError) {
            setRendered(true);
            setWarning("The traffic overlay could not be loaded. Retrying automatically.");
            if (trafficRetryTimer === undefined && activeTrafficSnapshot) {
              const retryDelay = Math.min(8_000, 1_000 * 2 ** trafficRetryAttempts);
              trafficRetryAttempts += 1;
              trafficRetryTimer = window.setTimeout(() => {
                trafficRetryTimer = undefined;
                if (disposed) return;
                const source = map.getSource(SOURCE.trafficTiles) as VectorTileSource | undefined;
                const fallbackSource = map.getSource(SOURCE.trafficFallbackTiles) as VectorTileSource | undefined;
                const retryUrl = appendTrafficTileClientRevision(resolveTrafficTileUrlTemplate(
                  activeTrafficSnapshot.tileUrlTemplate,
                  window.location.origin
                ), `2-retry-${trafficRetryAttempts}`);
                source?.setTiles([retryUrl]);
                fallbackSource?.setTiles([retryUrl]);
                map.triggerRepaint();
              }, retryDelay);
            }
            return;
          }
          if (sourceId === "basemap") {
            setRendered(true);
            const message = "The basemap is temporarily unavailable. Data overlays remain active.";
            setWarning(message);
            onBasemapErrorRef.current?.(message);
          }
        });
        map.getCanvas().addEventListener("webglcontextlost", (event) => {
          event.preventDefault();
          if (!disposed) setFallback(true);
        });
      } catch {
        if (!disposed) setFallback(true);
      }
    }

    void initialize();
    return () => {
      disposed = true;
      window.clearTimeout(moveTimer);
      window.clearTimeout(recoveryTimer);
      window.clearTimeout(trafficRetryTimer);
      if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
      if (selectionFrame !== undefined) window.cancelAnimationFrame(selectionFrame);
      markerController.abort();
      regencyMarkers.forEach((marker) => marker.remove());
      zoneCenterMarkers.forEach((marker) => marker.remove());
      refreshZoneCenterMarkersRef.current = () => undefined;
      resizeObserver?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [config, renderCentersAsHeatmap, showRegencyContext, showZoneCenters, usesTrafficTiles, zoneStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || trafficTiles) return;
    if (appliedFlowIdentityRef.current !== flowIdentity || appliedFlowCollectionRef.current !== data.flow) {
      setSourceData(map, SOURCE.traffic, data.flow);
      sourceUpdateStartedAtRef.current.traffic = performance.now();
      appliedFlowIdentityRef.current = flowIdentity;
      appliedFlowCollectionRef.current = data.flow;
    }
  }, [data.flow, flowIdentity, ready, trafficTiles]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || trafficTiles || appliedHeatmapKeyRef.current === trafficHeatmapKey) return;
    setSourceData(map, SOURCE.trafficHeatmap, trafficHeatmap);
    sourceUpdateStartedAtRef.current.heatmap = performance.now();
    appliedHeatmapKeyRef.current = trafficHeatmapKey;
    map.triggerRepaint();
  }, [ready, trafficHeatmap, trafficHeatmapKey, trafficTiles]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !trafficTiles || appliedTrafficTileVersionRef.current === trafficTiles.version) return;
    const source = map.getSource(SOURCE.trafficTiles) as VectorTileSource | undefined;
    const fallbackSource = map.getSource(SOURCE.trafficFallbackTiles) as VectorTileSource | undefined;
    const tileUrl = appendTrafficTileClientRevision(resolveTrafficTileUrlTemplate(
      trafficTiles.tileUrlTemplate,
      window.location.origin
    ));
    source?.setTiles([tileUrl]);
    fallbackSource?.setTiles([tileUrl]);
    appliedTrafficTileVersionRef.current = trafficTiles.version;
    map.triggerRepaint();
  }, [ready, trafficTiles]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !active) return;
    const applied = appliedAuxCollectionsRef.current;
    if (applied.zones !== data.zones) {
      setSourceData(map, SOURCE.zones, data.zones);
      refreshZoneCenterMarkersRef.current(data.zones);
    }
    if (applied.mobilityFlows !== data.mobilityFlows) {
      setSourceData(map, SOURCE.flows, data.mobilityFlows);
    }
    if (applied.incidents !== data.incidents) setSourceData(map, SOURCE.incidents, data.incidents);
    appliedAuxCollectionsRef.current = {
      zones: data.zones,
      mobilityFlows: data.mobilityFlows,
      centers: applied.centers,
      displayGrid: applied.displayGrid,
      incidents: data.incidents
    };
  }, [active, data.incidents, data.mobilityFlows, data.zones, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !active || appliedAuxCollectionsRef.current.centers === data.centers) return;
    let idleId: number | undefined;
    let waitingForMove = false;
    let cancelled = false;

    const applyPlaces = () => {
      if (cancelled || mapRef.current !== map) return;
      setSourceData(map, SOURCE.centers, data.centers);
      appliedAuxCollectionsRef.current.centers = data.centers;
      map.triggerRepaint();
    };
    const schedule = () => {
      if (cancelled) return;
      idleId = window.requestIdleCallback(applyPlaces, { timeout: 500 });
    };
    const afterMove = () => {
      waitingForMove = false;
      schedule();
    };

    if (map.isMoving()) {
      waitingForMove = true;
      map.once("moveend", afterMove);
    } else {
      schedule();
    }

    return () => {
      cancelled = true;
      if (waitingForMove) map.off("moveend", afterMove);
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
    };
  }, [active, data.centers, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !active || appliedAuxCollectionsRef.current.displayGrid === data.displayGrid) return;
    let idleId: number | undefined;
    let waitingForMove = false;
    let cancelled = false;
    const applyGrid = () => {
      if (cancelled || mapRef.current !== map) return;
      const renderedCollection = data.displayGrid;
      map.setLayoutProperty(LAYER.displayGridStack, "visibility", visibility(layers.placesHeatmap));
      map.setLayoutProperty(LAYER.displayGridCells, "visibility", visibility(layers.placesHeatmap));
      map.setLayoutProperty(LAYER.displayGridOutline, "visibility", visibility(layers.placesHeatmap));
      if (layers.placesHeatmap && map.getPitch() < 35) {
        map.easeTo({ pitch: 45, duration: reducedMotion ? 0 : 400 });
      }
      map.once("idle", () => {
        if (!cancelled &&
            appliedAuxCollectionsRef.current.displayGrid === renderedCollection &&
            map.getLayoutProperty(LAYER.displayGridStack, "visibility") === "visible") {
          acknowledgedDisplayGridRef.current = renderedCollection;
          onDisplayGridRenderedRef.current?.();
        }
      });
      setSourceData(map, SOURCE.displayGridCells, data.displayGrid);
      appliedAuxCollectionsRef.current.displayGrid = data.displayGrid;
      map.triggerRepaint();
    };
    const schedule = () => {
      if (!cancelled) idleId = window.requestIdleCallback(applyGrid, { timeout: 500 });
    };
    const afterMove = () => {
      waitingForMove = false;
      schedule();
    };
    if (map.isMoving()) {
      waitingForMove = true;
      map.once("moveend", afterMove);
    } else {
      schedule();
    }
    return () => {
      cancelled = true;
      if (waitingForMove) map.off("moveend", afterMove);
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
    };
  }, [active, data.displayGrid, layers.placesHeatmap, ready, reducedMotion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !active) return;
    const particleSource = map.getSource(SOURCE.flowParticles) as GeoJSONSource | undefined;
    const endpointSource = map.getSource(SOURCE.flowEndpoints) as GeoJSONSource | undefined;

    // Keep OD visibility self-contained. A failure while configuring an
    // unrelated traffic layer must not prevent these model layers rendering.
    for (const layerId of [LAYER.flows, LAYER.flowArrows, LAYER.flowOrigins, LAYER.flowDestinations, LAYER.flowDestinationArrows]) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visibility(layers.flows));
      }
    }

    const endpoints = layers.flows
      ? createOdEndpointCollection(data.mobilityFlows, minMobilityScore)
      : EMPTY_COLLECTION;
    endpointSource?.setData(asMapData(endpoints));

    if (!layers.flows) {
      particleSource?.setData(asMapData(EMPTY_COLLECTION));
      setRenderedOdParticleCount(0);
      return;
    }

    const updateArrows = (elapsedMs: number, staticMotion = false) => {
      const arrows = createOdParticleCollection(data.mobilityFlows, elapsedMs, {
        minimumScore: minMobilityScore,
        reducedMotion: staticMotion
      });
      particleSource?.setData(asMapData(arrows));
      setRenderedOdParticleCount((current) => current === arrows.features.length
        ? current
        : arrows.features.length);
    };

    if (reducedMotion) {
      updateArrows(0, true);
      return;
    }

    let animationFrame: number | undefined;
    let lastRenderedAt = -Infinity;
    const startedAt = performance.now();
    const animate = (timestamp: number) => {
      if (timestamp - lastRenderedAt >= 1000 / OD_ANIMATION_FPS) {
        updateArrows(timestamp - startedAt);
        lastRenderedAt = timestamp;
      }
      animationFrame = window.requestAnimationFrame(animate);
    };
    updateArrows(0);
    animationFrame = window.requestAnimationFrame(animate);
    return () => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
    };
  }, [
    active,
    data.mobilityFlows,
    layers.flows,
    minMobilityScore,
    ready,
    reducedMotion
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !active) return;
    let animationFrame: number | undefined;
    let lastRenderedAt = -Infinity;
    let previousFrameAt: number | undefined;
    let animationElapsedMs = 0;

    resumeHeartbeatRef.current = () => undefined;
    if (!TRAFFIC_HEARTBEAT_ENABLED || !layers.heatmap || layers.placesHeatmap || reducedMotion || !hasHeartbeatPoints) {
      return () => { resumeHeartbeatRef.current = () => undefined; };
    }

    resumeHeartbeatRef.current = () => {
      previousFrameAt = undefined;
      lastRenderedAt = -Infinity;
      map.triggerRepaint();
    };

    const renderHeartbeat = (timestamp: number) => {
      const frameDelta = previousFrameAt == null ? 0 : Math.min(100, timestamp - previousFrameAt);
      previousFrameAt = timestamp;
      if (map.isMoving()) {
        animationFrame = window.requestAnimationFrame(renderHeartbeat);
        return;
      }
      animationElapsedMs += frameDelta;
      if (timestamp - lastRenderedAt >= 1000 / TRAFFIC_HEARTBEAT_FPS) {
        map.setPaintProperty(
          LAYER.trafficHeatPulse,
          "circle-radius",
          trafficHeartbeatRadiusExpression(animationElapsedMs)
        );
        map.setPaintProperty(
          LAYER.trafficHeatPulse,
          "circle-opacity",
          trafficHeartbeatOpacityExpression(animationElapsedMs)
        );
        lastRenderedAt = timestamp;
      }
      animationFrame = window.requestAnimationFrame(renderHeartbeat);
    };

    animationFrame = window.requestAnimationFrame(renderHeartbeat);
    return () => {
      resumeHeartbeatRef.current = () => undefined;
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      if (mapRef.current === map && map.getLayer(LAYER.trafficHeatmap)) {
        map.setPaintProperty(LAYER.trafficHeatPulse, "circle-radius", trafficHeartbeatRadiusExpression(0));
        map.setPaintProperty(LAYER.trafficHeatPulse, "circle-opacity", trafficHeartbeatOpacityExpression(0));
      }
    };
  }, [active, hasHeartbeatPoints, layers.heatmap, layers.placesHeatmap, ready, reducedMotion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (zoneStyle === "catchmentPrediction") {
      const scoreProperty = metric === "inbound"
        ? "inboundScore"
        : metric === "outbound"
          ? "outboundScore"
          : metric === "attraction"
            ? "attractionScore"
            : "presenceScore";
      map.setPaintProperty(LAYER.zonesFill, "fill-color", [
        "case",
        ["boolean", ["get", "displayOnly"], false],
        "#9aa6a1",
        ["interpolate", ["linear"], ["coalesce", ["get", scoreProperty], 0],
          0, "#2c7bb6", 35, "#77b9d6", 60, "#f1d374", 80, "#ed8c55", 100, "#df3f36"]
      ]);
      map.setPaintProperty(LAYER.zonesFill, "fill-opacity", [
        "case",
        ["boolean", ["get", "displayOnly"], false],
        0.14,
        0.42
      ]);
    } else {
      map.setPaintProperty(LAYER.zonesFill, "fill-color", "#ffffff");
      map.setPaintProperty(LAYER.zonesFill, "fill-opacity", 0.001);
    }
    map.setPaintProperty(LAYER.zonesLine, "line-color", [
      "case",
      ["boolean", ["get", "displayOnly"], false],
      "#9eaaa5",
      zoneStyle === "context" ? "#aebdb7" : "#dce8e3"
    ]);
    map.setPaintProperty(LAYER.zonesLine, "line-opacity", zoneStyle === "context" ? 0.55 : 0.82);
  }, [metric, ready, zoneStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setPaintProperty(
      LAYER.flows,
      "line-color",
      ["interpolate", ["linear"], ["get", "mobilityScore"],
        0, "#f3c96b", 35, "#eea348", 70, "#eb773d", 100, "#d94a38"]
    );
    map.setPaintProperty(
      LAYER.flows,
      "line-width",
      ["interpolate", ["linear"], ["get", "mobilityScore"], 0, 0.8, 100, 2.4]
    );
    map.setPaintProperty(
      LAYER.flows,
      "line-opacity",
      ["interpolate", ["linear"], ["get", "confidence"], 0, 0.3, 1, 0.72]
    );
    const arrowImage = odRouteJamArrowExpression();
    map.setLayoutProperty(LAYER.flowArrows, "icon-image", arrowImage as never);
    map.setLayoutProperty(LAYER.flowDestinationArrows, "icon-image", arrowImage as never);
    map.setPaintProperty(
      LAYER.flowDestinations,
      "circle-color",
      "#f39a52"
    );
  }, [flowVisualMode, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setFilter(LAYER.flows, [">=", ["get", "mobilityScore"], minMobilityScore]);
    map.setFilter(LAYER.flowArrows, [">=", ["get", "mobilityScore"], minMobilityScore]);
    const confidenceFilter = [">=", ["coalesce", ["get", "confidence"], 0], minTrafficConfidence] as never;
    map.setFilter(LAYER.trafficCasing, confidenceFilter);
    map.setFilter(LAYER.traffic, confidenceFilter);
    map.setFilter(LAYER.trafficHit, confidenceFilter);
    map.setFilter(LAYER.trafficHeatmap, confidenceFilter);
    map.setFilter(LAYER.trafficHeatPulse, ["all", confidenceFilter, [">=", ["coalesce", ["get", "jamFactor"], 0], PULSE_MIN_JAM_FACTOR]] as never);
    if (map.getLayer(LAYER.trafficFallbackCasing)) map.setFilter(LAYER.trafficFallbackCasing, confidenceFilter);
    if (map.getLayer(LAYER.trafficFallback)) map.setFilter(LAYER.trafficFallback, confidenceFilter);
    for (const layerId of [LAYER.zonesFill, LAYER.zonesLine]) map.setLayoutProperty(layerId, "visibility", visibility(layers.mobility));
    for (const layerId of [LAYER.flows, LAYER.flowArrows, LAYER.flowOrigins, LAYER.flowDestinations, LAYER.flowDestinationArrows]) {
      map.setLayoutProperty(layerId, "visibility", visibility(layers.flows));
    }
    for (const layerId of [LAYER.trafficCasing, LAYER.traffic, LAYER.trafficHit]) map.setLayoutProperty(layerId, "visibility", visibility(layers.traffic));
    map.setLayoutProperty(LAYER.trafficHeatmap, "visibility", visibility(layers.heatmap));
    map.setLayoutProperty(LAYER.trafficHeatPulse, "visibility", visibility(
      TRAFFIC_HEARTBEAT_ENABLED && layers.heatmap && !reducedMotion
    ));
    if (map.getLayer(LAYER.trafficFallbackCasing)) map.setLayoutProperty(LAYER.trafficFallbackCasing, "visibility", visibility(layers.traffic));
    if (map.getLayer(LAYER.trafficFallback)) map.setLayoutProperty(LAYER.trafficFallback, "visibility", visibility(layers.traffic));
    map.setLayoutProperty(LAYER.centers, "visibility", visibility(layers.centers));
    map.setLayoutProperty(LAYER.centersHeatmap, "visibility", visibility(layers.centers && renderCentersAsHeatmap));
    map.setLayoutProperty(LAYER.displayGridStack, "visibility", visibility(layers.placesHeatmap));
    map.setLayoutProperty(LAYER.displayGridCells, "visibility", visibility(layers.placesHeatmap));
    map.setLayoutProperty(LAYER.displayGridOutline, "visibility", visibility(layers.placesHeatmap));
    for (const layerId of [LAYER.incidentsHalo, LAYER.incidents]) map.setLayoutProperty(layerId, "visibility", visibility(layers.incidents));
  }, [layers, minMobilityScore, minTrafficConfidence, ready, reducedMotion, renderCentersAsHeatmap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !active) return;
    map.easeTo({
      pitch: layers.placesHeatmap ? 45 : 0,
      duration: reducedMotion ? 0 : 550
    });
  }, [active, layers.placesHeatmap, ready, reducedMotion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !active) return;
    const frame = window.requestAnimationFrame(() => {
      setSourceData(map, SOURCE.selection, selection ? { type: "FeatureCollection", features: [selection.feature] } : EMPTY_COLLECTION);
      map.triggerRepaint();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, selection, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !active) return;
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      map.resize();
      secondFrame = window.requestAnimationFrame(() => {
        map.resize();
        map.triggerRepaint();
        resumeHeartbeatRef.current();
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
  }, [active, expanded, ready]);

  return (
    <div className={`relative overflow-hidden border border-[#d9e0dc] bg-[#252827] ${expanded ? "h-full min-h-0 rounded-xl" : compact ? "h-[420px] rounded-[22px]" : "h-full min-h-[550px] rounded-[22px]"}`} data-testid="bali-mobility-map" data-map-active={active} data-map-ready={ready || undefined} data-map-rendered={rendered || undefined} data-map-workspace={expanded ? "expanded" : "embedded"} data-flow-loading={trafficTiles ? "redis-vector-tiles" : "province-snapshot"} data-traffic-fallback={trafficTiles ? "persistent-minzoom" : "geojson"} data-flow-source-version={trafficTiles?.version ?? flowIdentity} data-flow-feature-count={trafficTiles?.featureCount ?? data.flow.features.length} data-heatmap-lod={trafficTiles ? "vector-tiles" : trafficHeatmapState.lod} data-heatmap-point-count={trafficTiles?.pulsePointCount ?? trafficHeatmap.features.length} data-od-flow-count={data.mobilityFlows.features.length} data-od-arrow-count={renderedOdParticleCount} data-od-flow-mode={flowVisualMode} data-od-tempo="1.000" data-od-animation-fps={OD_ANIMATION_FPS} data-render-recoveries={renderRecoveryCount} data-admin-boundaries="gadm-regencies" data-heartbeat-fps={TRAFFIC_HEARTBEAT_ENABLED ? TRAFFIC_HEARTBEAT_FPS : 0} data-od-animation={active && ready && layers.flows ? (reducedMotion ? "reduced" : "running") : undefined} data-heatmap-animation={TRAFFIC_HEARTBEAT_ENABLED && active && ready && layers.heatmap ? (reducedMotion ? "reduced" : hasHeartbeatPoints ? "running" : "idle") : "off"}>
      <div ref={containerRef} className={compact ? "h-[420px] w-full" : "absolute inset-0 h-full w-full"} role="application" aria-label="Interactive Bali traffic map" />
      {!ready && !rendered && !fallback ? <div className="absolute inset-0 z-30 bg-[#eef2ef] p-4" role="status" aria-label="Loading live traffic map"><div className="route-map-skeleton-frame h-full w-full rounded-xl" /><span className="sr-only">Preparing cached traffic tiles and map layers…</span></div> : null}
      {fallback ? <BoundaryFallback boundaryUrl={config.boundaryUrl} compact={compact} /> : null}
      {warning ? <div className="pointer-events-none absolute left-4 right-16 top-4 rounded-xl border border-[#efd1a6] bg-[#fff6e6]/95 px-3 py-2 text-xs font-semibold text-[#84551a] shadow-sm">{warning}</div> : null}
      {selection ? <MapSelectionDetails selection={selection} close={() => onSelect(null)} /> : null}
      <div className="pointer-events-none absolute left-4 top-4 rounded-xl border border-white/70 bg-white/90 px-3 py-2 shadow-sm backdrop-blur">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#60736d]">Real basemap</p>
        <p className="mt-0.5 text-xs font-semibold text-[#203c35]">{showRegencyContext ? "Map context · administrative boundaries" : "Map context · tourism catchments"}</p>
        {layers.traffic ? <p className="mt-1 text-[10px] font-semibold text-[#526b63]">Click or tap a colored road for details</p> : null}
      </div>
      {layers.flows ? (
        <div className={`pointer-events-none absolute left-4 max-w-[min(360px,calc(100%-2rem))] rounded-xl border border-[#d8e0dc] bg-white/95 px-4 py-3 shadow-lg backdrop-blur ${layers.traffic || layers.heatmap ? "bottom-[132px]" : "bottom-6"}`}>
          <>
            <p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#52645d]">Directional OD flows</p>
            <div className="mt-2 grid grid-cols-5 gap-1 text-center text-[8px] font-bold text-[#66766f]">
              {[
                ["#2f8f64", "Free"],
                ["#d4a72c", "Light"],
                ["#e67e32", "Medium"],
                ["#d6453d", "High"],
                ["#8f1d2c", "Severe"]
              ].map(([color, label]) => <span key={label}><i className="mb-1 block h-2 rounded" style={{ backgroundColor: color }} />{label}</span>)}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[#66766f]">
              {reducedMotion ? "Arrows show travel direction." : "Arrows animate along traffic-guided routes."} {renderedOdParticleCount} visible. Redder, longer arrow trains indicate heavier route jam.
            </p>
          </>
        </div>
      ) : null}
      {layers.traffic || layers.heatmap ? (
        <div className="pointer-events-none absolute bottom-8 left-4 rounded-xl border border-[#d8e0dc] bg-white/95 p-3 shadow-lg backdrop-blur">
          <TrafficJamLegend testId="traffic-legend" compact />
        </div>
      ) : null}
    </div>
  );
}

function detailPercent(value: number | null | undefined) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
}

function detailNumber(value: number | null | undefined, suffix = "") {
  return value == null || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toFixed(1)}${suffix}`;
}

function detailDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Makassar",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(parsed).replace(",", " ·");
}

function titleCase(value: string | null | undefined) {
  if (!value) return "Open";
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function jamLabel(jamFactor: number | null, roadClosure = false) {
  if (roadClosure) return "Confirmed closed";
  if (jamFactor == null) return "Unknown";
  if (jamFactor >= 10) return "Maximum congestion";
  if (jamFactor >= 8) return "Severe congestion";
  if (jamFactor >= 6) return "Congested";
  if (jamFactor >= 4) return "Moderate";
  if (jamFactor >= 2) return "Light";
  return "Free flowing";
}

function DetailRows({ rows }: { rows: Array<[string, string]> }) {
  return <dl className="mt-4 space-y-2 text-xs">
    {rows.map(([label, value]) => <div key={label} className="flex items-start justify-between gap-3">
      <dt className="text-[#71817b]">{label}</dt>
      <dd className="max-w-[58%] text-right font-bold text-[#344b43]">{value}</dd>
    </div>)}
  </dl>;
}

function MapSelectionDetails({ selection, close }: { selection: Exclude<MapSelection, null>; close: () => void }) {
  let eyebrow = "Map detail";
  let title = "Selected feature";
  let subtitle: string | null = null;
  let rows: Array<[string, string]> = [];

  if (selection.kind === "traffic") {
    const feature = selection.feature.properties;
    eyebrow = "Road segment";
    title = feature.roadName || `Road segment ${feature.segmentId}`;
    subtitle = feature.collectionSlotUtc ? `Collection ${detailDate(feature.collectionSlotUtc)} WITA` : null;
    rows = [
      ["Congestion", jamLabel(feature.jamFactor, feature.roadClosure)],
      ["Jam factor", detailNumber(feature.jamFactor)],
      ["Road status", feature.roadClosure ? "Closed" : titleCase(feature.traversability)],
      ["Speed", detailNumber(feature.speedKph, " km/h")],
      ["Free flow", detailNumber(feature.freeFlowKph, " km/h")],
      ["Confidence", detailPercent(feature.confidence)],
      ["Updated", detailDate(feature.sourceUpdatedUtc)]
    ];
  } else if (selection.kind === "zone") {
    const feature = selection.feature.properties;
    eyebrow = "Catchment area";
    title = feature.name;
    subtitle = feature.regencyName || null;
    rows = [
      ["Presence", detailNumber(feature.presenceScore)],
      ["Inbound", detailNumber(feature.inboundScore)],
      ["Outbound", detailNumber(feature.outboundScore)],
      ["Attraction", detailNumber(feature.attractionScore)],
      ["Hotspot rank", feature.hotspotRank == null ? "—" : String(feature.hotspotRank)],
      ["Confidence", detailPercent(feature.confidence)],
      ["Average jam", detailNumber(feature.meanJamFactor)]
    ];
  } else if (selection.kind === "flow") {
    const feature = selection.feature.properties;
    eyebrow = "Directional OD flow";
    title = `${feature.originName} → ${feature.destinationName}`;
    subtitle = feature.disclaimer || "Relative modeled movement";
    rows = [
      ["From", feature.originName],
      ["To", feature.destinationName],
      ["Relative mobility score", detailNumber(feature.mobilityScore)],
      ["Predicted share from origin", detailPercent(feature.predictedShare)],
      ["Estimated driving duration", feature.durationSeconds == null && feature.travelTimeSeconds == null ? "—" : `${Math.round(Number(feature.durationSeconds ?? feature.travelTimeSeconds) / 60)} min`],
      ["Estimated driving distance", feature.distanceMeters == null ? "—" : `${(feature.distanceMeters / 1000).toFixed(1)} km`],
      ["Confidence", detailPercent(feature.confidence)],
      ["Prediction time", detailDate(feature.predictionForUtc)],
      ["Path", feature.pathSemantics === "traffic_network_guided" ? "Traffic-guided road route" : "Modeled route"]
    ];
  } else if (selection.kind === "incident") {
    const feature = selection.feature.properties;
    eyebrow = "Traffic incident";
    title = feature.category || "Incident";
    subtitle = feature.description || null;
    rows = [
      ["Severity", titleCase(feature.severity)],
      ["Road status", feature.roadClosure ? "Closed" : "Open"],
      ["Length", feature.lengthMeters == null ? "—" : `${feature.lengthMeters.toLocaleString()} m`],
      ["Started", detailDate(feature.startTime)],
      ["Ends", detailDate(feature.endTime)]
    ];
  } else if (selection.kind === "center") {
    const feature = selection.feature.properties;
    eyebrow = Number(feature.centerCount ?? 1) > 1 ? "Place group" : "Place";
    title = feature.name;
    subtitle = String(feature.zoneName ?? "") || null;
    rows = [
      ["Category", feature.category],
      ["Attraction weight", detailNumber(feature.attractionScore)],
      ["Places in group", Number(feature.centerCount ?? 1).toLocaleString()],
      ["Model eligible", feature.modelEligible == null ? "—" : feature.modelEligible ? "Yes" : "No"],
      ["Last update", detailDate(feature.lastSeenAtUtc == null ? null : String(feature.lastSeenAtUtc))]
    ];
  } else {
    const feature = selection.feature.properties;
    eyebrow = "Activity grid cell";
    title = feature.category === "all" ? "All categories" : feature.category;
    rows = [
      ["Relative index", `${detailNumber(feature.relativeIndex)} / 100`],
      ["Place count", feature.activePlaceCount.toLocaleString()],
      ["Model-eligible places", feature.modelEligiblePlaceCount.toLocaleString()],
      ["Cell", feature.cellKey]
    ];
  }

  return <section
    className="map-edge-detail-card absolute right-3 top-3 z-20 w-[min(320px,calc(100%-24px))] rounded-2xl border border-[#d4ddd8] bg-white p-4 text-[#203a33] shadow-xl"
    aria-live="polite"
    data-testid="map-selection-details"
  >
    <button type="button" className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-lg leading-none text-[#52645d] transition hover:bg-[#edf2ef]" onClick={close} aria-label="Close map details">×</button>
    <p className="pr-9 text-[10px] font-bold uppercase tracking-[.14em] text-[#6e837b]">{eyebrow}</p>
    <h3 className="mt-1 pr-9 text-lg font-bold">{title}</h3>
    {subtitle ? <p className="mt-1 text-[10px] leading-relaxed text-[#7b8984]">{subtitle}</p> : null}
    <DetailRows rows={rows} />
  </section>;
}

function BoundaryFallback({ boundaryUrl, compact }: { boundaryUrl: string; compact: boolean }) {
  const [boundary, setBoundary] = useState<FeatureCollection<BaliBoundaryProperties> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(boundaryUrl, { signal: controller.signal }).then((response) => response.json()).then(setBoundary).catch(() => undefined);
    return () => controller.abort();
  }, [boundaryUrl]);
  const feature = boundary?.features[0];
  const geometry = feature?.geometry.type === "MultiPolygon" ? feature.geometry : null;
  const bbox = feature?.properties.bbox;
  const width = 900;
  const height = compact ? 420 : 550;
  const path = geometry && bbox ? geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(([longitude, latitude], index) => {
    const x = 22 + ((longitude - bbox[0]) / (bbox[2] - bbox[0])) * (width - 44);
    const y = 22 + ((bbox[3] - latitude) / (bbox[3] - bbox[1])) * (height - 44);
    return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ") + " Z").join(" ")).join(" ") : "";
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#dbe9e5]">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="Bali Province boundary fallback">
        <rect width={width} height={height} fill="#dbe9e5" />
        <path d={path} fill="#f5f1e8" fillRule="evenodd" stroke="#24584b" strokeWidth="2" />
      </svg>
      <p className="absolute bottom-4 right-4 rounded-lg bg-white/90 px-3 py-2 text-[10px] font-semibold text-[#596e67]">Boundary-only fallback · WebGL unavailable</p>
    </div>
  );
}
