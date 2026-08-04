"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Database, Info, Layers3, Map, Maximize2, Minimize2,
  Navigation, RefreshCw, ShieldCheck
} from "lucide-react";
import {
  BaliMobilityMap,
  type MapDataset,
  type MapLayers,
  type MapSelection
} from "@/components/dashboard/BaliMobilityMap";
import type {
  ApiMeta, BasemapConfig, CenterProperties, DisplayGridProperties,
  FeatureCollection, FlowProperties, MobilityFlowProperties
} from "@/lib/dashboard/types";
import type {
  CatchmentCenterSummary, CatchmentFlow, CatchmentPreviewMeta, CatchmentZoneProperties
} from "@/lib/api/internal-catchment-preview";
import {
  GENERAL_OD_EXCLUDED_CATCHMENT_KEYS,
  GENERAL_OD_MINIMUM_PREDICTED_SHARE,
  isGeneralOdPair,
  selectGeneralOdFlows
} from "@/lib/map/general-catchment-od";
import { guideOdFlowsByTraffic } from "@/lib/map/traffic-guided-od";
import { clearCachedJson, fetchCachedJson } from "@/lib/ui/client-data-cache";
import { publicDataMessage, publicModelVersion } from "@/lib/ui/public-data-message";
import { nextDashboardRefreshDelayMs } from "@/lib/snapshot/refresh-schedule";
import { withBasePath } from "@/lib/urls/base-path";

type Metric = "presence" | "inbound" | "outbound";
type FlowDirection = "both" | "outbound" | "inbound";
type Overview = {
  displayedCatchmentCount: number; modeledCatchmentCount: number;
  displayOnlyCatchmentCount: number; odPairCount: number;
};
type Payload<T> = { meta: CatchmentPreviewMeta; data: T };
type FlowData = {
  run?: {
    modelRunId: number; flowRunId: number; modelVersion: string;
    predictionForUtc: string; status: "success"; zoneCount: number;
    odCount: number; inputCoverage: number; semantics: string; disclaimer: string;
  };
  originCatchmentKey: string | null; destinationCatchmentKey: string | null;
  minScore: number; totalAvailablePairCount: number;
  returnedPairCount: number; flows: CatchmentFlow[];
};
type CenterData = { category: string | null; summaries: CatchmentCenterSummary[] };
type DisplayGridData = {
  metric: "attraction" | "placeDensity";
  category: string;
  cells: FeatureCollection<DisplayGridProperties>;
};

const BALI_BBOX = "114.34,-8.90,115.78,-8.03";
const PLACE_CATEGORIES = ["dining", "accommodation", "attraction", "culture", "beach", "shopping", "nightlife", "recreation", "transport"] as const;
const DEFAULT_FOCUS_CATCHMENT = "dps-airport-gateway";
function catchmentUrls(servingMode: "internal" | "public") {
  const base = servingMode === "public"
    ? "/api/v1/mobility/catchments"
    : "/api/internal/v1/mobility/catchments";
  return {
    overview: `${base}/overview`,
    zones: `${base}/zones`,
    flows: `${base}/flows?minScore=0&limit=420`
  };
}

function clearPreviewCache(urls: ReturnType<typeof catchmentUrls>) {
  Object.values(urls).forEach(clearCachedJson);
}

function emptyCollection<P extends Record<string, unknown>>(): FeatureCollection<P> {
  return { type: "FeatureCollection", features: [] };
}

function formatWita(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Makassar", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date(iso)).replace(",", " ·");
}

function percent(value: number | null | undefined) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const payload = await fetchCachedJson<T>(url, {
    ttlMs: 5 * 60_000,
    timeoutMs: 30_000,
    maxAttempts: 2
  });
  if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
  return payload;
}

function flowCollection(flows: CatchmentFlow[]): FeatureCollection<MobilityFlowProperties> {
  return {
    type: "FeatureCollection",
    features: flows.map((flow) => ({
      type: "Feature",
      id: `catchment-od-${flow.originZoneId}-${flow.destinationZoneId}`,
      geometry: {
        type: "LineString",
        coordinates: [
          [flow.originLongitude, flow.originLatitude],
          [flow.destinationLongitude, flow.destinationLatitude]
        ]
      },
      properties: {
        ...flow,
        flowVisualMode: "general_od"
      }
    }))
  };
}

function displayGridCenterCollection(
  cells: FeatureCollection<DisplayGridProperties>,
  category: string,
  meta: ApiMeta
): FeatureCollection<CenterProperties> {
  return {
    type: "FeatureCollection",
    features: cells.features.map((cell, index) => ({
      type: "Feature",
      id: `saturated-place-cell-${cell.properties.cellId}`,
      geometry: {
        type: "Point",
        coordinates: [
          Number(cell.properties.centerLongitude),
          Number(cell.properties.centerLatitude)
        ]
      },
      properties: {
        centerId: Number(cell.properties.cellId ?? index),
        zoneId: 0,
        zoneKey: cell.properties.cellKey,
        name: `${category === "all" ? "All categories" : category} · aggregated Places cell`,
        category,
        attractionScore: Number(cell.properties.rawAttractionWeight),
        centerCount: Number(cell.properties.activePlaceCount),
        source: "saturated_places_display_grid",
        relativeIndex: Number(cell.properties.relativeIndex),
        attractionIndex: Number(cell.properties.attractionIndex),
        placeDensityIndex: Number(cell.properties.placeDensityIndex),
        modelEligiblePlaceCount: Number(cell.properties.modelEligiblePlaceCount),
        displayGridBuildId: meta.displayGridBuildId,
        sourceImportRunId: meta.sourceImportRunId,
        sourceSaturatedTaskCount: meta.sourceSaturatedTaskCount
      }
    }))
  };
}

function evidenceCenterCollection(
  summaries: CatchmentCenterSummary[],
  metric: "attraction" | "placeDensity"
): FeatureCollection<CenterProperties> {
  const rawValues = summaries.map((summary) =>
    metric === "placeDensity" ? Number(summary.centerCount ?? 0) : Number(summary.baseAttractionWeight)
  );
  const maximum = Math.max(1, ...rawValues);
  return {
    type: "FeatureCollection",
    features: summaries.map((summary, index) => ({
      type: "Feature",
      id: `places-evidence-${summary.zoneId}-${summary.category}`,
      geometry: { type: "Point", coordinates: [summary.meanLongitude, summary.meanLatitude] },
      properties: {
        ...summary,
        attractionScore: rawValues[index]! / maximum
      }
    }))
  };
}

export function HerePlacesEvidenceView({
  config,
  onBasemapError
}: {
  config: BasemapConfig;
  onBasemapError: (message: string | null) => void;
}) {
  const [metric, setMetric] = useState<"attraction" | "placeDensity">("attraction");
  const [category, setCategory] = useState("");
  const [summaries, setSummaries] = useState<CatchmentCenterSummary[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [catchmentZones, setCatchmentZones] = useState<FeatureCollection<CatchmentZoneProperties>>(emptyCollection());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const categoryQuery = category ? `?category=${encodeURIComponent(category)}` : "";
    Promise.all([
      readJson<Payload<FeatureCollection<CatchmentZoneProperties>>>(
        "/api/internal/v1/mobility/catchments/zones",
        controller.signal
      ),
      readJson<Payload<CenterData>>(
        `/api/internal/v1/mobility/catchments/centers${categoryQuery}`,
        controller.signal
      )
    ]).then(([zonePayload, centerPayload]) => {
      if (controller.signal.aborted) return;
      setCatchmentZones(zonePayload.data);
      setSummaries(centerPayload.data.summaries);
      if (!category) {
        setCategories([...new Set(centerPayload.data.summaries.map((summary) => summary.category))].sort());
      }
      setError(null);
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? publicDataMessage(caught.message) : "Aggregated places evidence is unavailable.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [category, reload]);

  const dataset = useMemo<MapDataset>(() => ({
    flow: emptyCollection(), incidents: emptyCollection(), zones: catchmentZones,
    mobilityFlows: emptyCollection(), centers: evidenceCenterCollection(summaries, metric),
    displayGrid: emptyCollection()
  }), [catchmentZones, metric, summaries]);
  const layers: MapLayers = {
    traffic: false, heatmap: false, mobility: true, flows: false,
    incidents: false, centers: true, placesHeatmap: false
  };
  const representedCatchments = new Set(summaries.map((summary) => summary.catchmentKey)).size;
  const refreshEvidence = () => {
    const categoryQuery = category ? `?category=${encodeURIComponent(category)}` : "";
    clearCachedJson("/api/internal/v1/mobility/catchments/zones");
    clearCachedJson(`/api/internal/v1/mobility/catchments/centers${categoryQuery}`);
    setReload((value) => value + 1);
  };

  return <div className="space-y-5" data-testid="here-places-evidence-view">
    <div className="rounded-xl border border-[#cddde8] bg-[#f1f7fb] px-4 py-3 text-sm text-[#315e78]">
      <span className="flex items-start gap-2"><Info className="mt-0.5 shrink-0" size={17} />Aggregated activity-center evidence is display only. It is place density and attraction context, not mobility prediction.</span>
    </div>
    <section className="grid min-h-[650px] gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="relative min-h-[650px]">
        <BaliMobilityMap active data={dataset} metric="presence" layers={layers}
          minMobilityScore={100} minTrafficConfidence={1} selection={null}
          onSelect={() => undefined} config={config}
          flowIdentity={`places-evidence|${metric}|${category}`}
          showRegencyContext={false}
          showZoneCenters
          zoneStyle="context"
          renderCentersAsHeatmap
          onBasemapError={onBasemapError} />
        {loading ? <div className="pointer-events-none absolute left-4 top-4 rounded-lg bg-white/90 px-3 py-2 text-xs font-bold text-[#315f53] shadow">Loading places evidence…</div> : null}
      </div>
      <SidePanel title="Places heatmap" icon={Layers3}>
        <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#71817b]">Display metric
          <select value={metric} onChange={(event) => setMetric(event.target.value as "attraction" | "placeDensity")} className="mt-2 w-full rounded-lg border border-[#ccd7d1] bg-white px-3 py-2 text-xs font-bold normal-case tracking-normal">
            <option value="attraction">Relative attraction</option><option value="placeDensity">Place density</option>
          </select>
        </label>
        <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#71817b]">Category
          <select value={category} onChange={(event) => setCategory(event.target.value)} className="mt-2 w-full rounded-lg border border-[#ccd7d1] bg-white px-3 py-2 text-xs font-bold normal-case tracking-normal">
            <option value="">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <div><div className="flex justify-between text-[9px] font-bold text-[#65766f]"><span>Low</span><span>Relative index</span><span>High</span></div><div className="mt-2 h-2 rounded-full" style={{ background: "linear-gradient(90deg,#2c7bb6,#77b9d6,#f1d374,#ed8c55,#df3f36)" }} /></div>
        <p className="text-[10px] leading-relaxed text-[#71817b]">{summaries.length.toLocaleString()} aggregated category summaries across {representedCatchments} catchments. Heat intensity and marker size never represent observed movement or visits.</p>
        {error ? <p className="rounded bg-[#fff1d2] px-2 py-2 text-[10px] font-semibold text-[#8b611c]">{error}</p> : null}
        <button className="control-button w-full justify-center" onClick={refreshEvidence}><RefreshCw size={14} />Refresh places evidence</button>
      </SidePanel>
    </section>
  </div>;
}

export function InternalCatchmentPreview({
  config,
  placesLayerEnabled,
  onBasemapError,
  refreshTick,
  servingMode = "internal"
}: {
  config: BasemapConfig;
  placesLayerEnabled: boolean;
  onBasemapError: (message: string | null) => void;
  refreshTick: number;
  servingMode?: "internal" | "public";
}) {
  const urls = useMemo(() => catchmentUrls(servingMode), [servingMode]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [meta, setMeta] = useState<CatchmentPreviewMeta | null>(null);
  const [zones, setZones] = useState<FeatureCollection<CatchmentZoneProperties>>(emptyCollection());
  const [flows, setFlows] = useState<CatchmentFlow[]>([]);
  const [generalFlowsLoading, setGeneralFlowsLoading] = useState(false);
  const [centerMarkers, setCenterMarkers] = useState<FeatureCollection<CenterProperties>>(emptyCollection());
  const [centerSourceMeta, setCenterSourceMeta] = useState<ApiMeta | null>(null);
  const [centerSourceError, setCenterSourceError] = useState<string | null>(null);
  const metric: Metric = "presence";
  const [origin, setOrigin] = useState(DEFAULT_FOCUS_CATCHMENT);
  const [flowDirection, setFlowDirection] = useState<FlowDirection>("both");
  const [minimumConfidence, setMinimumConfidence] = useState(0);
  const [category, setCategory] = useState("");
  const [placesMetric, setPlacesMetric] = useState<"attraction" | "placeDensity">("attraction");
  const [showPredictions, setShowPredictions] = useState(true);
  const [showFlows, setShowFlows] = useState(true);
  const [showPlacesStack, setShowPlacesStack] = useState(false);
  const [showTraffic, setShowTraffic] = useState(false);
  const [showCatchmentLabels, setShowCatchmentLabels] = useState(true);
  const [placesGrid, setPlacesGrid] = useState<FeatureCollection<DisplayGridProperties>>(emptyCollection());
  const [traffic, setTraffic] = useState<FeatureCollection<FlowProperties>>(emptyCollection());
  const [selection, setSelection] = useState<MapSelection>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [mapExpanded, setMapExpanded] = useState(false);
  const openWorkspaceRef = useRef<HTMLButtonElement>(null);
  const closeWorkspaceRef = useRef<HTMLButtonElement>(null);
  const generalResyncCountRef = useRef(0);

  useEffect(() => {
    if (!mapExpanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeWorkspaceRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMapExpanded(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => openWorkspaceRef.current?.focus());
    };
  }, [mapExpanded]);

  useEffect(() => {
    const controller = new AbortController();
    if (refreshTick > 0) clearPreviewCache(urls);
    setLoading(true);
    Promise.all([
      readJson<Payload<Overview>>(urls.overview, controller.signal),
      readJson<Payload<FeatureCollection<CatchmentZoneProperties>>>(urls.zones, controller.signal)
    ]).then(([overviewPayload, zonePayload]) => {
      if (controller.signal.aborted) return;
      const modelRunIds = new Set([
        overviewPayload.meta.modelRunId,
        zonePayload.meta.modelRunId
      ].filter((value): value is number => value != null));
      if (modelRunIds.size !== 1) {
        throw new Error("The catchment resources do not match the same prediction run.");
      }
      setOverview(overviewPayload.data);
      setMeta(overviewPayload.meta);
      setZones(zonePayload.data);
      setFlows([]);
      setError(null);
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? publicDataMessage(caught.message) : "The preview is unavailable.");
    }).finally(() => {
      if (!controller.signal.aborted) {
        setLoading(false);
        setUpdating(false);
      }
    });
    return () => controller.abort();
  }, [reload, refreshTick, urls]);

  useEffect(() => {
    let disposed = false;
    let pollTimer: number | null = null;
    const schedule = (failed: boolean) => {
      if (disposed) return;
      pollTimer = window.setTimeout(pollLatest, nextDashboardRefreshDelayMs(failed));
    };
    const pollLatest = async () => {
      clearCachedJson(urls.overview);
      try {
        const latest = await readJson<Payload<Overview>>(urls.overview);
        if (disposed) return;
        if (!meta || latest.meta.modelRunId !== meta.modelRunId || error) {
          clearPreviewCache(urls);
          setFlows([]);
          setUpdating(true);
          setReload((value) => value + 1);
        } else {
          setOverview(latest.data);
          setMeta(latest.meta);
          setError(null);
        }
        schedule(false);
      } catch (caught) {
        if (disposed) return;
        setError(caught instanceof Error
          ? `${publicDataMessage(caught.message)} Automatic recovery is running.`
          : "The preview update failed. Automatic recovery is running.");
        schedule(true);
      }
    };
    schedule(Boolean(error));
    return () => {
      disposed = true;
      if (pollTimer != null) window.clearTimeout(pollTimer);
    };
  }, [error, meta?.modelRunId, urls]);

  useEffect(() => {
    if (flows.length) return;
    const controller = new AbortController();
    setGeneralFlowsLoading(true);
    readJson<Payload<FlowData>>(
      urls.flows,
      controller.signal
    ).then((flowPayload) => {
      if (controller.signal.aborted) return;
      if (
        flowPayload.data.returnedPairCount !== 420 ||
        flowPayload.data.totalAvailablePairCount !== 420 ||
        flowPayload.data.flows.length !== 420
      ) {
        throw new Error("The complete directed flow matrix is unavailable.");
      }
      if (flowPayload.data.run?.modelRunId !== meta?.modelRunId) {
        if (generalResyncCountRef.current >= 2) {
          throw new Error("General catchment OD could not synchronize with the active prediction run.");
        }
        generalResyncCountRef.current += 1;
        [
          urls.overview,
          urls.zones,
          urls.flows
        ].forEach(clearCachedJson);
        setUpdating(true);
        setReload((value) => value + 1);
        return;
      }
      generalResyncCountRef.current = 0;
      setFlows(flowPayload.data.flows);
      setError(null);
    }).catch((caught) => {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? publicDataMessage(caught.message) : "General catchment OD is unavailable.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setGeneralFlowsLoading(false);
    });
    return () => controller.abort();
  }, [flows.length, meta?.modelRunId, urls]);

  useEffect(() => {
    if (!overview || !showPlacesStack || !placesLayerEnabled) return;
    const controller = new AbortController();
    const requestedCategory = category || "all";
    const query = new URLSearchParams({
      bbox: BALI_BBOX,
      metric: placesMetric,
      category: requestedCategory,
      limit: "5000"
    });
    readJson<{ data: DisplayGridData; meta: ApiMeta }>(
      `/api/v1/mobility/display-grid?${query}`,
      controller.signal
    )
      .then((payload) => {
        if (!controller.signal.aborted) {
          setCenterMarkers(displayGridCenterCollection(payload.data.cells, requestedCategory, payload.meta));
          setPlacesGrid(payload.data.cells);
          setCenterSourceMeta(payload.meta);
          setCenterSourceError(null);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setCenterSourceError(caught instanceof Error ? publicDataMessage(caught.message) : "Places grid is unavailable.");
        }
    });
    return () => controller.abort();
  }, [category, overview, placesLayerEnabled, placesMetric, showPlacesStack]);

  useEffect(() => {
    if (showPlacesStack) return;
    setCenterMarkers((current) => current.features.length ? emptyCollection() : current);
    setPlacesGrid((current) => current.features.length ? emptyCollection() : current);
  }, [showPlacesStack]);

  useEffect(() => {
    if ((!showTraffic && !showFlows) || traffic.features.length) return;
    const controller = new AbortController();
    readJson<FeatureCollection<FlowProperties> & { meta?: ApiMeta }>(
      `/api/v1/flow/map?bbox=${BALI_BBOX}&at=latest&minConfidence=0&limit=5000`,
      controller.signal
    ).then((collection) => {
      if (!controller.signal.aborted) {
        setTraffic({ type: "FeatureCollection", features: collection.features });
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setShowTraffic(false);
      }
    });
    return () => controller.abort();
  }, [showFlows, showTraffic, traffic.features.length]);

  const modeledZones = useMemo(
    () => zones.features.filter((feature) => feature.properties.modelEligible && feature.properties.hasPrediction),
    [zones.features]
  );
  const generalFocusZones = useMemo(
    () => modeledZones.filter(
      (feature) => !GENERAL_OD_EXCLUDED_CATCHMENT_KEYS.has(feature.properties.catchmentKey)
    ),
    [modeledZones]
  );
  const generalAvailableFlows = useMemo(
    () => flows.filter(isGeneralOdPair),
    [flows]
  );
  const generalVisibleFlows = useMemo(
    () => selectGeneralOdFlows(generalAvailableFlows, {
      focusCatchmentKey: origin,
      direction: flowDirection,
      minimumPredictedShare: GENERAL_OD_MINIMUM_PREDICTED_SHARE,
      minimumConfidence
    }),
    [flowDirection, generalAvailableFlows, minimumConfidence, origin]
  );
  const visibleFlows = generalVisibleFlows;
  const directMobilityFlows = useMemo(
    () => flowCollection(visibleFlows),
    [visibleFlows]
  );
  const mobilityFlows = useMemo<FeatureCollection<MobilityFlowProperties>>(
    () => {
      const guided = guideOdFlowsByTraffic(directMobilityFlows, traffic);
      return {
        type: "FeatureCollection",
        features: guided.features.filter(
          (feature) => feature.properties.pathSemantics === "traffic_network_guided"
        )
      };
    },
    [directMobilityFlows, traffic]
  );
  const guidedFlowCount = mobilityFlows.features.filter(
    (feature) => feature.properties.pathSemantics === "traffic_network_guided"
  ).length;
  const dataset = useMemo<MapDataset>(() => ({
    flow: showTraffic ? traffic : emptyCollection(),
    incidents: emptyCollection(),
    zones,
    mobilityFlows,
    centers: emptyCollection(),
    displayGrid: showPlacesStack ? placesGrid : emptyCollection()
  }), [mobilityFlows, placesGrid, showPlacesStack, showTraffic, traffic, zones]);
  const layers = useMemo<MapLayers>(() => ({
    traffic: showTraffic, heatmap: showTraffic, mobility: showPredictions, flows: showFlows,
    incidents: false, centers: false, placesHeatmap: showPlacesStack
  }), [showFlows, showPlacesStack, showPredictions, showTraffic]);
  const topZone = [...modeledZones].sort((left, right) =>
    Number(right.properties.presenceScore) - Number(left.properties.presenceScore)
  )[0];
  const averageConfidence = modeledZones.length
    ? modeledZones.reduce((sum, feature) => sum + Number(feature.properties.confidence), 0) / modeledZones.length
    : null;
  const generalFocusName = generalFocusZones.find(
    (feature) => feature.properties.catchmentKey === origin
  )?.properties.name ?? "All general catchments";
  const activeFocusName = generalFocusName;
  const generalCatchmentCount = generalFocusZones.length;
  const generalPairCount = generalAvailableFlows.length ||
    generalCatchmentCount * Math.max(0, generalCatchmentCount - 1);

  function handleSelection(next: MapSelection) {
    setSelection(next);
    if (next?.kind === "zone") {
      const properties = next.feature.properties as CatchmentZoneProperties;
      if (
        properties.modelEligible &&
        properties.hasPrediction &&
        !GENERAL_OD_EXCLUDED_CATCHMENT_KEYS.has(properties.catchmentKey)
      ) {
        setOrigin(properties.catchmentKey);
      }
    }
  }

  function selectFocusCatchment(catchmentKey: string) {
    setOrigin(catchmentKey);
    const feature = zones.features.find((candidate) => candidate.properties.catchmentKey === catchmentKey);
    setSelection(feature ? { kind: "zone", feature } : null);
  }

  function refreshPreview() {
    clearPreviewCache(urls);
    setFlows([]);
    setUpdating(true);
    setReload((value) => value + 1);
  }

  function resetFlowFilters() {
    setMinimumConfidence(0);
    setOrigin("");
    setFlowDirection("both");
  }

  if (loading && !overview) {
    return <div className="route-map-skeleton-frame h-[650px] rounded-2xl" role="status"><span className="sr-only">Loading catchment preview…</span></div>;
  }
  if (!overview || !meta) {
    return <PreviewNotice
      title={servingMode === "public" ? "Predicted mobility unavailable" : "Internal catchment preview unavailable"}
      body={error ?? "No complete successful v2 run is available. Automatic recovery is running."}
    />;
  }

  return <div className="space-y-5" data-testid={servingMode === "public" ? "public-catchment-v2" : "internal-catchment-preview"}>
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 shadow-sm ${meta.stale ? "border-[#efd1a6] bg-[#fffaf0]" : "border-[#dbe2dd] bg-white"}`}>
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#e5eee9] text-[#2c6657]"><Activity size={17} /></span>
        <div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#81908b]">{servingMode === "public" ? "Tourism catchments · gravity-here-v2" : "Tourism catchments · v2 preview"}</p><p className="text-sm font-bold">{formatWita(meta.slotUtc)} WITA</p></div>
      </div>
      <div className="flex items-center gap-2">
        <span className={`rounded-lg px-3 py-2 text-xs font-bold ${meta.stale ? "bg-[#fff1d2] text-[#8b611c]" : "bg-[#e5f2e9] text-[#347358]"}`}>{meta.stale ? "Stale successful run" : "Complete successful run"}</span>
        <button className="control-button" onClick={refreshPreview} aria-label={servingMode === "public" ? "Refresh predicted mobility" : "Refresh internal preview"}><RefreshCw size={16} className={updating ? "animate-spin" : ""} /></button>
      </div>
    </div>
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard icon={Layers3} label="Displayed catchments" value={String(overview.displayedCatchmentCount)} hint={`${overview.modeledCatchmentCount} modeled · ${overview.displayOnlyCatchmentCount} display only`} />
      <MetricCard
        icon={Navigation}
        label="Visible directional flows"
        value={String(visibleFlows.length)}
        hint={`${generalPairCount} directed pairs across ${generalCatchmentCount} catchments`}
      />
      <MetricCard icon={Map} label="Highest relative mobility" value={topZone?.properties.name ?? "—"} hint={topZone ? `Presence ${Number(topZone.properties.presenceScore).toFixed(1)}` : "No prediction"} />
      <MetricCard icon={ShieldCheck} label="Model confidence" value={percent(averageConfidence)} hint={`Input coverage ${percent(meta.coverage)}`} />
    </section>
    {error ? <div className="rounded-xl border border-[#efd1a6] bg-[#fff6e6] px-4 py-3 text-xs font-semibold text-[#84551a]">{error} Previous valid preview data remains visible.</div> : null}
    <section
      className={mapExpanded ? "fixed inset-0 z-[80] flex flex-col bg-[#18201e] p-2 sm:p-3" : ""}
      role={mapExpanded ? "dialog" : undefined}
      aria-modal={mapExpanded || undefined}
      aria-label={mapExpanded ? "Predicted mobility map workspace" : undefined}
      data-testid={mapExpanded ? "predicted-mobility-map-workspace" : undefined}
    >
      <header className={mapExpanded ? "mb-2 flex min-h-14 shrink-0 items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#222b28] px-3 text-white shadow-2xl sm:px-4" : "hidden"}>
        <div className="flex min-w-0 items-center gap-3">
          <Image
            src={withBasePath("/brand/bukit-vista-logo.png")}
            alt="bukitVISTA"
            width={2048}
            height={1260}
            priority
            className="h-10 w-auto shrink-0 rounded-lg bg-white px-2 py-1"
          />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold">Predicted mobility explorer</h2>
            <p className="truncate text-[10px] font-semibold text-[#a9bbb4]">{activeFocusName} · directed movement simulation</p>
          </div>
        </div>
        <button
          ref={closeWorkspaceRef}
          type="button"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-3 text-xs font-bold transition hover:bg-white/15"
          onClick={() => setMapExpanded(false)}
          aria-label="Exit predicted mobility full screen"
        >
          <Minimize2 size={16} /><span className="hidden sm:inline">Exit full screen</span>
        </button>
      </header>
      <div className={mapExpanded
        ? "grid min-h-0 flex-1 grid-rows-[minmax(280px,1fr)_minmax(180px,38vh)] gap-2 lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-1"
        : "grid min-h-[680px] gap-5 xl:grid-cols-[minmax(0,1fr)_320px]"
      }>
      <div className={mapExpanded ? "relative min-h-0" : "relative min-h-[680px]"}>
        <BaliMobilityMap active data={dataset} metric={metric} layers={layers}
          minMobilityScore={0} minTrafficConfidence={0}
          selection={selection} onSelect={handleSelection} config={config}
          showRegencyContext={false}
          showZoneCenters={showCatchmentLabels}
          zoneStyle="catchmentPrediction"
          flowVisualMode="general"
          flowIdentity={`catchment-v2|general|${meta.modelRunId}|${meta.slotUtc}`}
          onBasemapError={onBasemapError}
          expanded={mapExpanded} />
        {!mapExpanded ? <button
          ref={openWorkspaceRef}
          type="button"
          onClick={() => setMapExpanded(true)}
          className="absolute right-3 top-[76px] z-20 grid h-9 w-9 place-items-center rounded-lg border border-[#cbd5d0] bg-white/95 text-[#29483f] shadow-lg backdrop-blur transition hover:bg-white"
          aria-label="Open predicted mobility map full screen"
          title="Open full-screen predicted mobility explorer"
        ><Maximize2 size={17} /></button> : null}
      </div>
      <aside className={mapExpanded ? "min-h-0 space-y-3 overflow-y-auto rounded-xl bg-[#eef1ef] p-2 lg:p-3" : "space-y-4"}>
        <SidePanel title="Preview controls" icon={Layers3}>
          <div className="space-y-3 rounded-xl border border-[#dce4df] bg-[#f8faf8] p-3">
            <p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#52645d]">Visible layers</p>
            <Toggle checked={showPredictions} label="Catchment boundaries" onChange={setShowPredictions} />
            <Toggle checked={showFlows} label="Directional OD flows" onChange={setShowFlows} />
            <Toggle checked={showCatchmentLabels} label="Catchment center labels" onChange={setShowCatchmentLabels} />
            <Toggle checked={showTraffic} label="Traffic conditions" onChange={setShowTraffic} />
          </div>
          <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#71817b]">Focus catchment
            <select value={origin} onChange={(event) => selectFocusCatchment(event.target.value)} className="mt-2 w-full rounded-lg border border-[#ccd7d1] bg-white px-3 py-2 text-xs font-bold normal-case tracking-normal text-[#344b43]">
              <option value="">All catchments</option>
              {generalFocusZones.map((feature) => <option key={feature.properties.catchmentKey} value={feature.properties.catchmentKey}>{feature.properties.name}</option>)}
            </select>
          </label>
          {origin ? <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#71817b]">Flow direction
            <select value={flowDirection} onChange={(event) => setFlowDirection(event.target.value as FlowDirection)} className="mt-2 w-full rounded-lg border border-[#ccd7d1] bg-white px-3 py-2 text-xs font-bold normal-case tracking-normal text-[#344b43]">
              <option value="both">Inbound and outbound</option>
              <option value="outbound">Outbound from selected catchment</option>
              <option value="inbound">Inbound to selected catchment</option>
            </select>
          </label> : null}
          <p className="rounded bg-[#e8f1f6] px-3 py-2 text-[10px] font-semibold leading-relaxed text-[#315e78]">
            {generalFlowsLoading
              ? <>Loading the complete catchment OD matrix…</>
              : traffic.features.length
                ? <>Showing authoritative {flowDirection === "both" ? "inbound and outbound" : flowDirection} records
                  for {generalFocusName} that pass the predicted share-from-origin filter (&gt; 1%) and confidence filter.
                  {" "}{guidedFlowCount}/{visibleFlows.length} paths follow the traffic network using short-route
                  cost with a jam-factor preference. Reverse directions are never generated in the browser.</>
                : <>Loading the traffic network before drawing guided OD lines.</>}
          </p>
          <RangeControl label="Minimum confidence" value={minimumConfidence} max={1} step={0.05} format={percent} onChange={setMinimumConfidence} />
          <button type="button" className="control-button w-full justify-center" onClick={resetFlowFilters}>
            <RefreshCw size={14} />Reset flow filters
          </button>
          {placesLayerEnabled ? <div className="space-y-3 rounded-xl border border-[#dce4df] bg-[#f8faf8] p-3">
            <p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#52645d]">Places filters · display only</p>
            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#71817b]">Display metric
              <select value={placesMetric} onChange={(event) => setPlacesMetric(event.target.value as "attraction" | "placeDensity")} className="mt-2 w-full rounded-lg border border-[#ccd7d1] bg-white px-3 py-2 text-xs font-bold normal-case tracking-normal text-[#344b43]">
                <option value="attraction">Relative attraction</option>
                <option value="placeDensity">Place density</option>
              </select>
            </label>
            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#71817b]">Category
            <select value={category} onChange={(event) => setCategory(event.target.value)} className="mt-2 w-full rounded-lg border border-[#ccd7d1] bg-white px-3 py-2 text-xs font-bold normal-case tracking-normal text-[#344b43]">
              <option value="">All aggregated categories</option>
              {PLACE_CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            </label>
            <Toggle checked={showPlacesStack} label="Places 3D stack" onChange={setShowPlacesStack} />
          </div> : null}
          {showPlacesStack && centerSourceMeta ? <p className="rounded bg-[#e8f1f6] px-2 py-2 text-[9px] leading-relaxed text-[#315e78]">
            {centerMarkers.features.length.toLocaleString()} places grid-cell aggregates · build {String(centerSourceMeta.displayGridBuildId ?? "—")}
          </p> : null}
          {showPlacesStack && Number(centerSourceMeta?.sourceSaturatedTaskCount ?? 0) > 0 ? <p className="rounded bg-[#fff1d2] px-2 py-2 text-[9px] leading-relaxed text-[#8b611c]">
            Partial coverage: {Number(centerSourceMeta?.sourceSaturatedTaskCount)} search tasks reached their result ceiling.
          </p> : null}
          {showPlacesStack && centerSourceError ? <p className="rounded bg-[#fff1d2] px-2 py-2 text-[9px] font-semibold text-[#8b611c]">{centerSourceError}</p> : null}
        </SidePanel>
        <SidePanel title="Model identity" icon={Database}>
          <dl className="space-y-3 text-xs">
            <Pair label="Run" value={String(meta.modelRunId)} />
            <Pair label="Version" value={publicModelVersion(meta.modelVersion)} /><Pair label="Status" value={meta.status} />
            <Pair label="Coverage" value={percent(meta.coverage)} /><Pair label="Semantics" value="Relative predicted mobility" />
            <Pair label="Public serving" value={meta.publicServing ? "Yes" : "No"} />
          </dl>
        </SidePanel>
      </aside>
      </div>
    </section>
  </div>;
}

function MetricCard({ icon: Icon, label, value, hint }: { icon: typeof Activity; label: string; value: string; hint: string }) {
  return <div className="rounded-2xl border border-[#dbe2dd] bg-white p-4 shadow-sm"><span className="grid h-8 w-8 place-items-center rounded-lg bg-[#e8f0ec] text-[#315f53]"><Icon size={15} /></span><p className="mt-3 text-[10px] font-bold uppercase tracking-[.12em] text-[#7a8984]">{label}</p><p className="mt-1 text-lg font-bold text-[#263f37]">{value}</p><p className="mt-1 text-[10px] text-[#71817b]">{hint}</p></div>;
}

function SidePanel({ title, icon: Icon, children }: { title: string; icon: typeof Activity; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-[#dbe2dd] bg-white p-4 shadow-sm"><h3 className="mb-4 flex items-center gap-2 text-sm font-bold"><Icon size={16} className="text-[#37685b]" />{title}</h3><div className="space-y-4">{children}</div></section>;
}

function Pair({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-3"><dt className="text-[#71817b]">{label}</dt><dd className="text-right font-bold text-[#344b43]">{value}</dd></div>;
}

function RangeControl({ label, value, max, step, format = String, onChange }: { label: string; value: number; max: number; step: number; format?: (value: number) => string; onChange: (value: number) => void }) {
  return <label className="block"><span className="flex justify-between text-[10px] font-bold uppercase tracking-[.1em] text-[#71817b]"><span>{label}</span><span>{format(value)}</span></span><input className="mobility-range mt-2 w-full" type="range" aria-label={label} min={0} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="flex items-center justify-between gap-3 text-xs font-semibold text-[#52645d]"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-[#315f53]" /></label>;
}

function PreviewNotice({ title, body }: { title: string; body: string }) {
  return <section className="rounded-2xl border border-[#efd1a6] bg-[#fffaf0] p-6"><Info size={22} className="text-[#9b6812]" /><h2 className="mt-3 text-lg font-bold">{title}</h2><p className="mt-2 text-sm text-[#6c665a]">{body}</p></section>;
}
