"use client";

import Image from "next/image";
import {
  Activity, Bell, CalendarClock, CarFront, ChevronRight, Clock3, Database,
  Gauge, HeartPulse, Info, Layers3, Map, Maximize2, Menu, Minimize2, Navigation,
  Pause, Play, RefreshCw, Route as RouteIcon, ShieldCheck, TriangleAlert, X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import { BaliMobilityMap, type MapDataset, type MapLayers, type MapSelection } from "@/components/dashboard/BaliMobilityMap";
import { InternalCatchmentPreview } from "@/components/dashboard/InternalCatchmentPreview";
import { RouteGeometryMap, RouteGeometrySkeleton } from "@/components/dashboard/RouteGeometryMap";
import { TrafficJamLegend } from "@/components/dashboard/TrafficJamLegend";
import type {
  ApiMeta, BasemapConfig, CenterProperties, CollectionRun, DashboardResourceVersions, DisplayGridProperties, FeatureCollection, FlowProperties,
  FlowSlot, HistoryCoverage, MobilityFlowProperties, MobilityPredictionReadiness, MobilityZoneProperties,
  MvpWindowStatus, RouteHistoryPoint, RouteSummary, SourceDashboardData, TrafficOverview, TrafficTileSnapshot
} from "@/lib/dashboard/types";
import { clampBaliQueryBbox, DEFAULT_BALI_BBOX, formatBbox, parseBbox, type Bbox } from "@/lib/map/viewport";
import { routeConditionStyle } from "@/lib/map/route-condition";
import { formatCongestedRoadShare } from "@/lib/map/traffic-summary";
import { calculateViewportTrafficOverview } from "@/lib/map/viewport-traffic";
import { clearCachedJson, fetchCachedJson } from "@/lib/ui/client-data-cache";
import { publicDataMessage, publicModelVersion } from "@/lib/ui/public-data-message";
import { conditionalFetchJson } from "@/lib/api/conditional-client";
import { fetchJsonWithTimeoutRetry } from "@/lib/api/retry-client";
import { createDashboardRefreshPlan, createProvinceFlowScope } from "@/lib/dashboard/refresh-plan";
import { AIRPORT_CORRIDOR_DISCLAIMER, groupAirportTourismCorridors } from "@/lib/routes/airport-corridors";
import {
  DASHBOARD_VERSION_POLL_MS,
  nextDashboardRefreshDelayMs
} from "@/lib/snapshot/refresh-schedule";

type View = "live" | "mobility" | "routes" | "health";
type Mode = "latest" | "historical";
type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
type RouteGeometry = FeatureCollection<Record<string, unknown>>;

type RouteDetailCacheEntry = {
  geometry?: RouteGeometry;
  history?: RouteHistoryPoint[];
  historyCoverage?: HistoryCoverage;
};

const MOBILITY_SHADOW_DISCLAIMER = "Relative mobility prediction based on traffic, accessibility, and attraction signals. It does not represent actual people, vehicles, or trip counts.";
const DISPLAY_GRID_DISCLAIMER = "Contextual places heatmap. It does not represent predicted movement, visits, people, vehicles, or trips.";
const ROUTE_DETAIL_CACHE_LIMIT = 24;
const routeDetailCache = new globalThis.Map<string, RouteDetailCacheEntry>();

function getCachedRouteDetail(key: string) {
  const entry = routeDetailCache.get(key);
  if (!entry) return undefined;
  routeDetailCache.delete(key);
  routeDetailCache.set(key, entry);
  return entry;
}

function cacheRouteDetail(key: string, value: Partial<RouteDetailCacheEntry>) {
  const entry = { ...routeDetailCache.get(key), ...value };
  routeDetailCache.delete(key);
  routeDetailCache.set(key, entry);
  while (routeDetailCache.size > ROUTE_DETAIL_CACHE_LIMIT) {
    const oldest = routeDetailCache.keys().next().value as string | undefined;
    if (!oldest) break;
    routeDetailCache.delete(oldest);
  }
}

const VIEWS: Record<View, { label: string; eyebrow: string; icon: Icon }> = {
  live: { label: "Live traffic", eyebrow: "Network operations", icon: Map },
  mobility: { label: "Predicted mobility", eyebrow: "Model-derived movement", icon: Activity },
  routes: { label: "Route performance", eyebrow: "Airport corridor conditions", icon: RouteIcon },
  health: { label: "Data health", eyebrow: "Collection operations", icon: HeartPulse }
};

const DEFAULT_MAP_LAYERS: MapLayers = { traffic: true, heatmap: true, mobility: false, flows: false, incidents: false, centers: false, placesHeatmap: false };
function emptyCollection<T extends Record<string, unknown>>(): FeatureCollection<T> {
  return { type: "FeatureCollection", features: [] };
}

function formatWita(iso: string | null | undefined, compact = false) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Makassar", day: "2-digit", month: "short", year: compact ? undefined : "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date(iso));
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.round((absolute % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes} min`;
}

function delayLabel(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  if (seconds < 0) return `${formatDuration(seconds)} faster than typical`;
  if (seconds === 0) return "On typical time";
  return `+${formatDuration(seconds)}`;
}

function percent(value: number | null | undefined) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function ageLabel(slotUtc: string | null | undefined) {
  if (!slotUtc) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(slotUtc).getTime()) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusTone(status: string) {
  if (["success", "complete", "fresh"].includes(status)) return "bg-[#e2f2e9] text-[#277151]";
  if (["partial", "running", "stale"].includes(status)) return "bg-[#fff1d2] text-[#9b6812]";
  return "bg-[#fde5e2] text-[#a9433e]";
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(publicDataMessage(body?.error?.message ?? `Request failed with ${response.status}`));
  }
  return response.json() as Promise<T>;
}

function waitForInitialMap(timeoutMs = 10_000) {
  return new Promise<void>((resolve) => {
    const readyMap = () => document.querySelector('[data-testid="bali-mobility-map"][data-map-rendered="true"]');
    if (readyMap()) {
      resolve();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!readyMap()) return;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      resolve();
    }, timeoutMs);
  });
}

export function DashboardShell({ initialData, basemapConfig, airportTourismRoutesEnabled, mobilityShadowUiEnabled, mobilityPlacesLayerEnabled, mobilityCatchmentPreviewEnabled, mobilityCatchmentV2PublicEnabled }: { initialData: SourceDashboardData; basemapConfig: BasemapConfig; airportTourismRoutesEnabled: boolean; mobilityShadowUiEnabled: boolean; mobilityPlacesLayerEnabled: boolean; mobilityCatchmentPreviewEnabled: boolean; mobilityCatchmentV2PublicEnabled: boolean }) {
  const mobilityViewEnabled = mobilityShadowUiEnabled || mobilityCatchmentPreviewEnabled || mobilityCatchmentV2PublicEnabled;
  const [data, setData] = useState(initialData);
  const [view, setView] = useState<View>(mobilityViewEnabled ? "mobility" : "live");
  const [mode, setMode] = useState<Mode>("latest");
  const [historicalSlot, setHistoricalSlot] = useState<string | null>(null);
  const [bbox, setBbox] = useState<Bbox>(DEFAULT_BALI_BBOX);
  const [minConfidence, setMinConfidence] = useState(0);
  const [selection, setSelection] = useState<MapSelection>(null);
  const [selectedRouteId, setSelectedRouteId] = useState(initialData.routes[0]?.id ?? 0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [latestDataTick, setLatestDataTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [basemapWarning, setBasemapWarning] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [boot, setBoot] = useState({ ready: false, completed: 0, total: 1, label: "Preparing dashboard" });
  const etagCacheRef = useRef(new globalThis.Map<string, string>());
  const serverVersionsRef = useRef<DashboardResourceVersions | null>(initialData.versions);
  const appliedVersionsRef = useRef<DashboardResourceVersions | null>(initialData.versions);
  const appliedScopeRef = useRef<string | null>(initialData.versions ? "latest|latest" : null);
  const appliedRouteScopeRef = useRef<string | null>(initialData.versions ? "latest|latest" : null);
  const trafficTileVersionRef = useRef(initialData.trafficTiles?.version ?? null);
  const sourceHealthLoadedRef = useRef(Boolean(initialData.sourceStates?.length));
  const lastAutomaticRefreshAtRef = useRef(Date.now());

  trafficTileVersionRef.current = data.trafficTiles?.version ?? null;

  const at = mode === "latest" ? "latest" : historicalSlot ?? data.meta.slotUtc ?? "latest";
  const shownSlot = mode === "latest" ? data.meta.slotUtc : historicalSlot;
  const selectedRoute = data.routes.find((route) => route.id === selectedRouteId) ?? data.routes[0] ?? null;
  const sourceWarning = useMemo(() => {
    const states = data.sourceStates ?? [];
    if (states.some((state) => state.isStuck || state.healthState === "critical")) return "A data update is critical or stuck. The last valid measurements remain visible.";
    if (states.some((state) => state.isFailed)) return "The newest data update failed. The last valid measurements remain visible.";
    if (states.some((state) => state.isPartial)) return "A data update completed partially; coverage shown in Data health is the measured coverage.";
    if (states.some((state) => state.isRunning)) return "A new collection is running. The current complete layer remains visible until it is ready.";
    if (states.some((state) => state.isStale)) return "One or more data sources are stale. The collection slot remains visible for context.";
    return null;
  }, [data.sourceStates]);
  const mapData = useMemo<MapDataset>(() => ({
    flow: data.flow,
    incidents: emptyCollection(),
    zones: emptyCollection(),
    mobilityFlows: emptyCollection(),
    centers: emptyCollection(),
    displayGrid: emptyCollection()
  }), [data.flow]);
  const viewportOverview = useMemo(() => calculateViewportTrafficOverview({
    flow: data.flow,
    routes: data.routes,
    bbox,
    minimumConfidence: minConfidence,
    coverage: data.meta.coverage
  }), [bbox, data.flow, data.meta.coverage, data.routes, minConfidence]);
  const navigationViews = useMemo(() => {
    const available = (Object.entries(VIEWS) as Array<[View, (typeof VIEWS)[View]]>).filter(([key]) =>
      (key !== "routes" || airportTourismRoutesEnabled) &&
      (key !== "mobility" || mobilityViewEnabled)
    );
    const selected = available.find(([key]) => key === view);
    return selected ? [selected, ...available.filter(([key]) => key !== view)] : available;
  }, [airportTourismRoutesEnabled, mobilityViewEnabled, view]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get("view") as View | null;
    const requestedAt = params.get("at");
    const requestedBbox = parseBbox(params.get("bbox"));
    const confidence = Number(params.get("confidence"));
    const routeId = Number(params.get("route"));
    if (
      requestedView &&
      requestedView in VIEWS &&
      (requestedView !== "routes" || airportTourismRoutesEnabled) &&
      (requestedView !== "mobility" || mobilityViewEnabled)
    ) setView(requestedView);
    if (requestedAt && requestedAt !== "latest" && Number.isFinite(new Date(requestedAt).getTime())) {
      setMode("historical"); setHistoricalSlot(new Date(requestedAt).toISOString());
    }
    if (requestedBbox) setBbox(requestedBbox);
    if (Number.isFinite(confidence)) setMinConfidence(Math.max(0, Math.min(1, confidence)));
    if (Number.isFinite(routeId)) setSelectedRouteId(routeId);
  }, [airportTourismRoutesEnabled, mobilityViewEnabled]);

  useEffect(() => {
    let disposed = false;
    const startedAt = performance.now();
    const tasks: Array<{ label: string; run: () => Promise<unknown> }> = [
      { label: "Rendering map", run: () => waitForInitialMap() }
    ];

    if (mobilityPlacesLayerEnabled) {
      tasks.push(
        {
          label: "Preparing places",
          run: () => fetchSourceContext<PlacesPayload>(
            placesRequestUrl(DEFAULT_BALI_BBOX, 8.5, "", false)
          )
        },
        {
          label: "Preparing 3D grid",
          run: () => fetchSourceContext<DisplayGridPayload>(
            displayGridRequestUrl(DEFAULT_BALI_BBOX, 8.5, "attraction", "all")
          )
        }
      );
    }

    if (mobilityCatchmentV2PublicEnabled || mobilityCatchmentPreviewEnabled) {
      const catchmentBase = mobilityCatchmentV2PublicEnabled
        ? "/api/v1/mobility/catchments"
        : "/api/internal/v1/mobility/catchments";
      const previewUrls = [
        [`${catchmentBase}/overview`, "Preparing catchments"],
        [`${catchmentBase}/zones`, "Preparing map areas"],
        ["/api/v1/flow/map?bbox=114.34,-8.90,115.78,-8.03&at=latest&minConfidence=0&limit=5000", "Preparing traffic paths"]
      ] as const;
      tasks.push(...previewUrls.map(([url, label]) => ({
        label,
        run: () => fetchCachedJson<unknown>(url, {
          ttlMs: url.startsWith("/api/internal/") ? 30_000 : 5 * 60_000
        })
      })));
    } else if (mobilityShadowUiEnabled) {
      tasks.push({
        label: "Preparing mobility",
        run: async () => {
          const readiness = await fetchCachedJson<{ data: MobilityPredictionReadiness }>(
            "/api/v1/mobility/readiness",
            { ttlMs: 15_000, timeoutMs: 5_000, maxAttempts: 2 }
          );
          if (!readiness.data.ready) return readiness;
          const viewport = formatBbox(clampBaliQueryBbox(DEFAULT_BALI_BBOX));
          await Promise.all([
            fetchCachedJson(`/api/v1/mobility/zones?bbox=${viewport}&at=latest&limit=5000`),
            fetchCachedJson(`/api/v1/mobility/flows?bbox=${viewport}&at=latest&minScore=0&limit=5000`),
            fetchCachedJson("/api/v1/mobility/slots?limit=48", { ttlMs: 60_000 })
          ]);
          return readiness;
        }
      });
    }

    setBoot((current) => ({ ...current, total: tasks.length }));
    const preload = tasks.map(async (task) => {
      try {
        return await task.run();
      } finally {
        if (!disposed) {
          setBoot((current) => ({
            ...current,
            completed: Math.min(current.total, current.completed + 1),
            label: task.label
          }));
        }
      }
    });
    void Promise.allSettled(preload).then(async () => {
      const remaining = Math.max(0, 650 - (performance.now() - startedAt));
      if (remaining) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      if (!disposed) setBoot((current) => ({ ...current, ready: true, completed: current.total, label: "Ready" }));
    });
    return () => {
      disposed = true;
    };
  }, [
    mobilityCatchmentPreviewEnabled,
    mobilityCatchmentV2PublicEnabled,
    mobilityPlacesLayerEnabled,
    mobilityShadowUiEnabled
  ]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    url.searchParams.set("at", at);
    url.searchParams.set("mode", mode);
    url.searchParams.set("bbox", formatBbox(bbox));
    url.searchParams.set("confidence", String(minConfidence));
    if (selectedRoute) url.searchParams.set("route", String(selectedRoute.id));
    window.history.replaceState(null, "", url);
  }, [at, bbox, minConfidence, mode, selectedRoute, view]);

  useEffect(() => {
    const clockTimer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(clockTimer);
  }, []);

  useEffect(() => {
    if (mode !== "latest") return;
    const refreshOnReturn = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastAutomaticRefreshAtRef.current < DASHBOARD_VERSION_POLL_MS) return;
      lastAutomaticRefreshAtRef.current = now;
      setClock(new Date(now));
      setRefreshTick((value) => value + 1);
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") refreshOnReturn();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("focus", refreshOnReturn);
    window.addEventListener("online", refreshOnReturn);
    window.addEventListener("pageshow", refreshOnReturn);
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("focus", refreshOnReturn);
      window.removeEventListener("online", refreshOnReturn);
      window.removeEventListener("pageshow", refreshOnReturn);
    };
  }, [mode]);

  useEffect(() => {
    const controller = new AbortController();
    let pollTimer: number | null = null;
    const scheduleNextRefresh = (failed: boolean) => {
      if (mode !== "latest" || controller.signal.aborted) return;
      pollTimer = window.setTimeout(() => {
        lastAutomaticRefreshAtRef.current = Date.now();
        setRefreshTick((value) => value + 1);
      }, nextDashboardRefreshDelayMs(failed));
    };
    async function refresh(): Promise<boolean> {
      const scope = createProvinceFlowScope(mode, at);
      const routeScope = `${mode}|${at}`;
      const scopeChanged = appliedScopeRef.current !== scope;
      const routeScopeChanged = appliedRouteScopeRef.current !== routeScope;
      let versions = serverVersionsRef.current;
      let syncFailed = false;
      let invalidateTrafficTiles = false;

      if (mode === "latest") {
        try {
          const sync = await conditionalFetchJson<{ data: { versions: DashboardResourceVersions; trafficTiles?: TrafficTileSnapshot | null } }>(
            "/api/v1/dashboard/version", etagCacheRef.current, controller.signal
          );
          if (sync.modified) {
            versions = sync.value.data.versions;
            serverVersionsRef.current = versions;
            const announcedTiles = sync.value.data.trafficTiles ?? null;
            invalidateTrafficTiles = !announcedTiles && Boolean(trafficTileVersionRef.current);
            if (announcedTiles && announcedTiles.version !== trafficTileVersionRef.current) {
              setRefreshing(true);
              const snapshot = await conditionalFetchJson<{ data: SourceDashboardData }>(
                "/api/v1/traffic/snapshot", etagCacheRef.current, controller.signal
              );
              if (snapshot.modified) {
                setData(snapshot.value.data);
                trafficTileVersionRef.current = snapshot.value.data.trafficTiles?.version ?? null;
                appliedVersionsRef.current = snapshot.value.data.versions;
                appliedScopeRef.current = "latest|latest";
                appliedRouteScopeRef.current = "latest|latest";
                setSelectedRouteId((current) => snapshot.value.data.routes.some((route) => route.id === current)
                  ? current
                  : snapshot.value.data.routes[0]?.id ?? 0);
                setLatestDataTick((value) => value + 1);
                setRefreshError(null);
                setRefreshing(false);
                return false;
              }
            }
          }
        } catch {
          syncFailed = true;
        }
      }
      if (controller.signal.aborted) return false;
      if (syncFailed) {
        setRefreshError("The latest-data check failed. The previous valid snapshot remains visible; an authorized manual refresh may be required.");
        setRefreshing(false);
        return true;
      }

      const applied = appliedVersionsRef.current;
      const { flowVersionChanged, routeVersionChanged, flowHealthChanged, routeHealthChanged, flowNeeded, routesNeeded } = createDashboardRefreshPlan({
        mode, scopeChanged, routeScopeChanged, serverVersions: versions, appliedVersions: applied, syncFailed
      });

      type ResourceKey = "flow" | "routes" | "slots" | "sourceHealth";
      const requests: Array<{ key: ResourceKey; url: string }> = [];
      if (flowNeeded) requests.push({ key: "flow", url: `/api/v1/flow/map?bbox=${formatBbox(DEFAULT_BALI_BBOX)}&at=${encodeURIComponent(at)}&minConfidence=0&limit=5000` });
      if (routesNeeded) requests.push({ key: "routes", url: `/api/v1/routes/latest?at=${encodeURIComponent(at)}` });
      if (flowVersionChanged) requests.push({ key: "slots", url: "/api/v1/flow/slots?hours=12" });
      if (!sourceHealthLoadedRef.current || flowHealthChanged || routeHealthChanged) requests.push({ key: "sourceHealth", url: "/api/v1/traffic/overview" });

      if (!requests.length) {
        setRefreshError(null);
        setRefreshing(false);
        return false;
      }
      setRefreshing(true);
      const results = await Promise.allSettled(requests.map(async (resource) => ({
        ...resource,
        result: await conditionalFetchJson<unknown>(resource.url, etagCacheRef.current, controller.signal)
      })));
      if (controller.signal.aborted) return false;
      const failures = results.filter((result) => result.status === "rejected");
      const value = <T,>(key: ResourceKey) => {
        const match = results.find((result) => result.status === "fulfilled" && result.value.key === key);
        if (!match || match.status !== "fulfilled" || !match.value.result.modified) return null;
        return match.value.result.value as T;
      };
      const succeeded = (key: ResourceKey) => {
        const requested = requests.some((resource) => resource.key === key);
        return !requested || results.some((result) => result.status === "fulfilled" && result.value.key === key);
      };
      const flow = value<FeatureCollection<FlowProperties> & { meta: ApiMeta }>("flow");
      const routes = value<{ data: { routes: RouteSummary[] }; meta: ApiMeta }>("routes");
      const slots = value<{ data: { slots: FlowSlot[] } }>("slots");
      const sourceHealth = value<{ data: { sources: import("@/lib/dashboard/types").CollectorState[] } }>("sourceHealth");
      if (sourceHealth) sourceHealthLoadedRef.current = true;
      const stateRun = (state: import("@/lib/dashboard/types").CollectorState): CollectionRun => ({
        id: Number(state.runId), slotUtc: state.collectionSlotUtc, status: state.status,
        source: state.dataset === "flow" ? "Traffic" : "Routes",
        expectedCount: state.expectedCount, successCount: state.successfulCount, failedCount: state.failedCount,
        recordCount: state.recordCount, durationSeconds: state.durationSeconds, attemptCount: state.retryCount + 1,
        retryCount: state.retryCount, http429Count: state.http429Count, coverage: state.coverageRatio,
        slotAgeMinutes: state.slotAgeMinutes, alertCode: state.alertCode ?? undefined,
        finishedAtUtc: state.finishedAtUtc, healthState: state.healthState,
        isRunning: state.isRunning, isStuck: state.isStuck,
        errorMessage: state.isFailed ? "Data update failed; details are restricted to operations." : null
      });
      if (flow || routes || slots || sourceHealth) {
        if (flow && invalidateTrafficTiles) trafficTileVersionRef.current = null;
        setData((current) => ({
          ...current,
          flow: flow ? { type: "FeatureCollection", features: flow.features } : current.flow,
          meta: flow?.meta ?? current.meta,
          routes: routes?.data.routes ?? current.routes,
          slots: slots?.data.slots ?? current.slots,
          flowRuns: sourceHealth?.data.sources.filter((state) => state.dataset === "flow").map(stateRun) ?? current.flowRuns,
          routeRuns: sourceHealth?.data.sources.filter((state) => state.dataset === "routes").map(stateRun) ?? current.routeRuns,
          sourceStates: sourceHealth?.data.sources ?? current.sourceStates,
          trafficTiles: flow && invalidateTrafficTiles ? null : current.trafficTiles,
          generatedAt: new Date().toISOString()
        }));
        setLatestDataTick((value) => value + 1);
      }
      if (routes?.data.routes.length) {
        setSelectedRouteId((current) => routes.data.routes.some((route) => route.id === current) ? current : routes.data.routes[0]!.id);
      }

      if (mode === "latest" && versions) {
        const next = appliedVersionsRef.current ?? { flow: "", routes: "", flowHealth: "", routeHealth: "" };
        appliedVersionsRef.current = {
          flow: flowVersionChanged && succeeded("flow") && succeeded("slots") ? versions.flow : next.flow,
          routes: routeVersionChanged && succeeded("routes") ? versions.routes : next.routes,
          flowHealth: flowHealthChanged && succeeded("sourceHealth") ? versions.flowHealth : next.flowHealth,
          routeHealth: routeHealthChanged && succeeded("sourceHealth") ? versions.routeHealth : next.routeHealth
        };
      }
      if (scopeChanged && succeeded("flow")) {
        appliedScopeRef.current = scope;
      }
      if (routeScopeChanged && succeeded("routes")) appliedRouteScopeRef.current = routeScope;
      const failureCount = failures.length;
      setRefreshError(failureCount ? `${failureCount} source refresh ${failureCount === 1 ? "request" : "requests"} failed. Previous valid data remains visible.` : null);
      setRefreshing(false);
      return failureCount > 0;
    }
    void refresh().then(scheduleNextRefresh).catch((error) => {
      if (controller.signal.aborted) return;
      setRefreshError(error instanceof Error ? publicDataMessage(error.message) : "Data refresh failed. Previous valid data remains visible.");
      setRefreshing(false);
      scheduleNextRefresh(true);
    });
    return () => {
      controller.abort();
      if (pollTimer != null) window.clearTimeout(pollTimer);
    };
  }, [at, mode, refreshTick]);

  function returnLatest() {
    setMode("latest"); setHistoricalSlot(null); setSelection(null); setRefreshTick((value) => value + 1);
  }

  async function refreshActualData() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const response = await fetch("/api/v1/traffic/snapshot", { cache: "no-store" });
      const result = await json<{ data: SourceDashboardData }>(response);
      const dashboard = result.data;
      etagCacheRef.current.clear();
      serverVersionsRef.current = dashboard.versions;
      appliedVersionsRef.current = dashboard.versions;
      appliedScopeRef.current = "latest|latest";
      appliedRouteScopeRef.current = "latest|latest";
      trafficTileVersionRef.current = dashboard.trafficTiles?.version ?? null;
      sourceHealthLoadedRef.current = Boolean(dashboard.sourceStates?.length);
      setData(dashboard);
      setLatestDataTick((value) => value + 1);
      lastAutomaticRefreshAtRef.current = Date.now();
      setSelectedRouteId((current) => dashboard.routes.some((route) => route.id === current)
        ? current
        : dashboard.routes[0]?.id ?? 0);
      setMode("latest");
      setHistoricalSlot(null);
      setRefreshError(null);
    } catch (error) {
      setRefreshError(error instanceof Error ? publicDataMessage(error.message) : "The published snapshot refresh failed. Previous valid data remains visible.");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#f4f6f2] text-[#1b2c27]">
      {!boot.ready ? <DashboardBootOverlay completed={boot.completed} total={boot.total} label={boot.label} /> : null}
      <aside className={`fixed inset-y-0 left-0 z-40 w-[242px] border-r border-[#dce2dd] bg-[#fbfcfa] transition-transform lg:translate-x-0 ${mobileNav ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-full flex-col px-4 py-5">
          <div className="flex items-center justify-between px-2">
            <button className="rounded-xl text-left transition-opacity hover:opacity-85" onClick={() => setView(mobilityViewEnabled ? "mobility" : "live")} aria-label="Open bukitVISTA Bali Traffic home">
              <Image
                src="/brand/bukit-vista-logo.png"
                alt="bukitVISTA"
                width={2048}
                height={1260}
                priority
                className="h-auto w-[150px]"
              />
            </button>
            <button className="rounded-lg p-2 lg:hidden" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button>
          </div>
          <nav className="mt-9 space-y-1.5" aria-label="Dashboard views">
            {navigationViews.map(([key, item]) => {
              const IconComponent = item.icon;
              return <button key={key} onClick={() => { setView(key); setMobileNav(false); }} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${view === key ? "bg-[#e0ece7] text-[#194c40]" : "text-[#64736e] hover:bg-[#f0f3f0]"}`}><IconComponent size={18} />{item.label}</button>;
            })}
          </nav>
        </div>
      </aside>
      {mobileNav ? <button className="fixed inset-0 z-30 bg-black/20 lg:hidden" onClick={() => setMobileNav(false)} aria-label="Close menu overlay" /> : null}

      <div className="lg:pl-[242px]">
        <header className="sticky top-0 z-30 border-b border-[#dce2dd] bg-[#f8faf7]/95 backdrop-blur">
          <div className="flex h-[72px] items-center justify-between px-4 sm:px-7 lg:px-9">
            <div className="flex items-center gap-3">
              <button className="rounded-xl border bg-white p-2.5 lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={19} /></button>
              <div><p className="text-[10px] font-bold uppercase tracking-[.17em] text-[#7d8d87]">{VIEWS[view].eyebrow}</p><h1 className="text-2xl font-bold tracking-[-.025em]">{VIEWS[view].label}</h1></div>
            </div>
            <div className="flex items-center gap-3"><div className="hidden text-right sm:block"><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#7d8d87]">WITA local time</p><p className="text-sm font-semibold">{formatWita(clock.toISOString())}</p></div><button className="rounded-xl border bg-white p-2.5"><Bell size={18} /></button></div>
          </div>
        </header>

        <main className="px-4 py-5 sm:px-7 lg:px-9 lg:py-7">
          {data.meta.status === "unavailable" ? <Banner tone="red" text="Current data is unavailable. No fixture data was substituted." /> : null}
          {data.meta.stale ? <Banner tone="amber" text="The newest collection did not produce an eligible layer. The previous successful layer is retained and marked stale." /> : null}
          {view === "health" && data.windowStatus?.status === "partial" ? <Banner tone="amber" text={`The rolling 12-hour source window is partial: Flow ${data.windowStatus.flow.passedSlots}/${data.windowStatus.flow.expectedSlots} passed, Routes ${data.windowStatus.routes.passedSlots}/${data.windowStatus.routes.expectedSlots} passed. Latest successful data remains visible.`} /> : null}
          {sourceWarning ? <Banner tone="amber" text={sourceWarning} /> : null}
          {refreshError ? <Banner tone="amber" text={refreshError} /> : null}
          {basemapWarning ? <Banner tone="amber" text={basemapWarning} /> : null}

          {view !== "mobility" ? <TimeBar mode={mode} slot={shownSlot} refreshing={refreshing} onRefresh={() => void refreshActualData()} onLatest={returnLatest} /> : null}

          <div className={view === "live" ? "" : "hidden"} aria-hidden={view !== "live"}>
            <LiveView active={view === "live"} data={data} overview={viewportOverview} mapData={mapData} config={basemapConfig} minConfidence={minConfidence} setMinConfidence={setMinConfidence} selection={selection} setSelection={setSelection} setBbox={setBbox} setBasemapWarning={setBasemapWarning} mode={mode} placesLayerEnabled={mobilityPlacesLayerEnabled} />
          </div>
          {view === "mobility" && mobilityViewEnabled ? <PredictedMobilityView config={basemapConfig} setBasemapWarning={setBasemapWarning} placesLayerEnabled={mobilityPlacesLayerEnabled} catchmentPreviewEnabled={mobilityCatchmentPreviewEnabled} catchmentPublicEnabled={mobilityCatchmentV2PublicEnabled} refreshTick={latestDataTick} /> : null}
          {view === "routes" && airportTourismRoutesEnabled ? <RoutesView routes={data.routes} selected={selectedRoute} setSelectedRouteId={setSelectedRouteId} at={at} config={basemapConfig} /> : null}
          {view === "health" ? <HealthView flowRuns={data.flowRuns} routeRuns={data.routeRuns} windowStatus={data.windowStatus ?? null} /> : null}
        </main>
      </div>
    </div>
  );
}

function Banner({ tone, text, action }: { tone: "red" | "amber"; text: string; action?: React.ReactNode }) {
  return <div className={`mb-4 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${tone === "red" ? "border-[#efb7b1] bg-[#fff0ee] text-[#943f39]" : "border-[#efd1a6] bg-[#fff6e6] text-[#84551a]"}`}><span className="flex items-center gap-2"><TriangleAlert size={17} />{text}</span>{action}</div>;
}

function DashboardBootOverlay({ completed, total, label }: { completed: number; total: number; label: string }) {
  const progress = Math.max(4, Math.min(100, Math.round((completed / Math.max(1, total)) * 100)));
  return <div className="fixed inset-0 z-[120] grid place-items-center bg-[#eef3ef]" role="status" aria-live="polite" aria-label="Preparing dashboard">
    <div className="w-[min(420px,calc(100%-32px))] rounded-3xl border border-[#d4ded8] bg-white p-7 text-center shadow-2xl sm:p-9">
      <Image
        src="/brand/bukit-vista-logo.png"
        alt="bukitVISTA"
        width={2048}
        height={1260}
        priority
        className="mx-auto h-auto w-44 animate-pulse"
      />
      <div className="mx-auto mt-6 flex w-fit items-center gap-3 text-[#285c4e]">
        <RefreshCw size={20} className="animate-spin" />
        <p className="text-sm font-bold">Preparing your dashboard</p>
      </div>
      <p className="mt-2 min-h-5 text-xs font-semibold text-[#71817b]">{label}</p>
      <div className="mt-5 h-2.5 overflow-hidden rounded-full bg-[#e2eae5]">
        <div className="h-full rounded-full bg-gradient-to-r from-[#2d7460] via-[#4d9a81] to-[#f39a36] transition-[width] duration-500 ease-out" style={{ width: `${progress}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-[.12em] text-[#81908b]">
        <span>{completed} of {total}</span>
        <span>{progress}%</span>
      </div>
    </div>
  </div>;
}

function TimeBar({ mode, slot, refreshing, onRefresh, onLatest }: { mode: Mode; slot: string | null | undefined; refreshing: boolean; onRefresh: () => void; onLatest: () => void }) {
  return <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#dbe2dd] bg-white px-4 py-3 shadow-sm">
    <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#e5eee9] text-[#2c6657]"><CalendarClock size={17} /></span><div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#81908b]">{mode === "latest" ? "Latest successful Flow slot" : "Pinned historical slot"}</p><p className="text-sm font-bold">{formatWita(slot)} WITA</p></div></div>
    <div className="flex items-center gap-2">{mode === "historical" ? <button className="control-button" onClick={onLatest}>Return to latest</button> : <span className="rounded-lg bg-[#e5f2e9] px-3 py-2 text-xs font-bold text-[#347358]">Polling every 30 min</span>}<button className="control-button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh live data"><RefreshCw size={16} className={refreshing ? "animate-spin" : ""} /></button></div>
  </div>;
}

type OdFocus = "airport_both" | "from_airport" | "to_airport" | "all";
type MobilityCollection<P extends Record<string, unknown>> = FeatureCollection<P> & { meta: ApiMeta };
type MobilityTimelineSlot = {
  slotUtc: string;
  modelRunId: number;
  sourceRunId: number;
  status: "success" | "partial";
  coverage: number | null;
};
type PlacesMode = "aggregate" | "cluster" | "point";
type PlacesPayload = {
  data: {
    mode: PlacesMode;
    groups?: Array<Record<string, unknown>>;
    type?: "FeatureCollection";
    features?: Array<{
      type: "Feature"; id?: string | number;
      geometry: { type: "Point"; coordinates: [number, number] };
      properties: Record<string, unknown>;
    }>;
    truncated?: boolean;
    nextCursor?: string | null;
  };
  meta: ApiMeta;
};
type DisplayGridPayload = {
  data: {
    metric: "attraction" | "placeDensity";
    category: string;
    cells: FeatureCollection<DisplayGridProperties>;
  };
  meta: ApiMeta;
};
const SOURCE_CONTEXT_CACHE_TTL_MS = 24 * 60 * 60_000;
const sourceContextCache = new globalThis.Map<string, { expiresAt: number; value: unknown }>();
const sourceContextRequests = new globalThis.Map<string, Promise<unknown>>();

function displayGridCellLimit(zoom: number) {
  if (zoom < 9.5) return 5000;
  if (zoom < 11.5) return 3500;
  return 2500;
}

function displayGridRequestUrl(bbox: Bbox, zoom: number, metric: "attraction" | "placeDensity", category: string) {
  return `/api/v1/mobility/display-grid?${new URLSearchParams({
    bbox: formatBbox(clampBaliQueryBbox(bbox)), metric, category,
    limit: String(displayGridCellLimit(zoom))
  })}`;
}

function placesRequestUrl(bbox: Bbox, zoom: number, category: string, eligibleOnly: boolean) {
  const mode: PlacesMode = zoom < 10 ? "aggregate" : zoom <= 12 ? "cluster" : "point";
  const parameters = new URLSearchParams({
    mode,
    zoom: String(Math.max(0, Math.min(22, Math.round(zoom)))),
    eligibleOnly: String(eligibleOnly),
    limit: mode === "aggregate" ? "250" : mode === "cluster" ? "600" : "1000"
  });
  if (mode !== "aggregate") parameters.set("bbox", formatBbox(clampBaliQueryBbox(bbox)));
  if (category) parameters.set("category", category);
  return `/api/v1/mobility/centers?${parameters}`;
}

async function fetchSourceContext<T>(url: string): Promise<T> {
  const cached = sourceContextCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  const pending = sourceContextRequests.get(url);
  if (pending) return pending as Promise<T>;
  const controller = new AbortController();
  const request = fetchJsonWithTimeoutRetry<T>(url, {
    signal: controller.signal, timeoutMs: 15_000, maxAttempts: 2
  }).then((value) => {
    sourceContextCache.set(url, { expiresAt: Date.now() + SOURCE_CONTEXT_CACHE_TTL_MS, value });
    return value;
  }).finally(() => {
    sourceContextRequests.delete(url);
  });
  sourceContextRequests.set(url, request);
  return request;
}
const PLACE_CATEGORIES = ["dining", "accommodation", "attraction", "culture", "beach", "shopping", "nightlife", "recreation", "transport"] as const;
const AIRPORT_GATEWAY_ZONE_KEY = "bali-badung";

const MOBILITY_GATE_LABELS: Record<MobilityPredictionReadiness["missing"][number], string> = {
  scope_not_approved: "Product scope approved",
  prediction_disabled: "Production prediction flag enabled",
  active_model_missing: "Active model version registered",
  successful_model_run_missing: "Successful or partial model run available",
  active_zones_missing: "Reviewed Bali mobility zones loaded",
  activity_centers_missing: "Activity centers loaded",
  zone_road_mappings_missing: "Road segments mapped to zones",
  zone_predictions_missing: "Zone predictions produced",
  od_predictions_missing: "Origin-destination predictions produced"
};

function PredictedMobilityView({ config, setBasemapWarning, placesLayerEnabled, catchmentPreviewEnabled, catchmentPublicEnabled, refreshTick }: { config: BasemapConfig; setBasemapWarning: (message: string | null) => void; placesLayerEnabled: boolean; catchmentPreviewEnabled: boolean; catchmentPublicEnabled: boolean; refreshTick: number }) {
  return catchmentPublicEnabled || catchmentPreviewEnabled
    ? <InternalCatchmentPreview
        config={config}
        placesLayerEnabled={placesLayerEnabled}
        onBasemapError={setBasemapWarning}
        refreshTick={refreshTick}
        servingMode={catchmentPublicEnabled ? "public" : "internal"}
      />
    : <RegencyMobilityView
        config={config}
        setBasemapWarning={setBasemapWarning}
        placesLayerEnabled={placesLayerEnabled}
        refreshTick={refreshTick}
      />;
}

function RegencyMobilityView({ config, setBasemapWarning, placesLayerEnabled, refreshTick }: { config: BasemapConfig; setBasemapWarning: (message: string | null) => void; placesLayerEnabled: boolean; refreshTick: number }) {
  const [readiness, setReadiness] = useState<MobilityPredictionReadiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [dataset, setDataset] = useState<MapDataset>({
    flow: emptyCollection(), incidents: emptyCollection(), zones: emptyCollection(), mobilityFlows: emptyCollection(), centers: emptyCollection(), displayGrid: emptyCollection()
  });
  const [dataMeta, setDataMeta] = useState<ApiMeta | null>(null);
  const [bbox, setPredictionBbox] = useState<Bbox>(DEFAULT_BALI_BBOX);
  const [predictionZoom, setPredictionZoom] = useState(8.5);
  const [minimumScore, setMinimumScore] = useState(0);
  const [odFocus, setOdFocus] = useState<OdFocus>("airport_both");
  const [timelineSlots, setTimelineSlots] = useState<MobilityTimelineSlot[]>([]);
  const [timelineAt, setTimelineAt] = useState<string>("latest");
  const [timelinePlaying, setTimelinePlaying] = useState(false);
  const [timelineSpeedMs, setTimelineSpeedMs] = useState(1200);
  const [displayGridMetric, setDisplayGridMetric] = useState<"attraction" | "placeDensity">("attraction");
  const [displayGridCategory, setDisplayGridCategory] = useState("all");
  const [displayGridLoading, setDisplayGridLoading] = useState(false);
  const [displayGridError, setDisplayGridError] = useState<string | null>(null);
  const [displayGridMeta, setDisplayGridMeta] = useState<ApiMeta | null>(null);
  const [displayGridRequestTick, setDisplayGridRequestTick] = useState(0);
  const [displayGridLoadedView, setDisplayGridLoadedView] = useState<string | null>(null);
  const [displayGridApplied, setDisplayGridApplied] = useState<{ category: string; metric: "attraction" | "placeDensity"; cellCount: number } | null>(null);
  const displayGridPendingRenderRef = useRef<{ category: string; metric: "attraction" | "placeDensity"; cellCount: number } | null>(null);
  const displayGridHandledRequestRef = useRef(0);
  const [layers, setLayers] = useState<MapLayers>({ traffic: false, heatmap: false, mobility: true, flows: true, incidents: false, centers: false, placesHeatmap: false });
  const [selection, setPredictionSelection] = useState<MapSelection>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const focusedMobilityFlows = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: dataset.mobilityFlows.features.filter((feature) => {
      if (odFocus === "all") return true;
      const fromAirport = feature.properties.originZoneKey === AIRPORT_GATEWAY_ZONE_KEY;
      const toAirport = feature.properties.destinationZoneKey === AIRPORT_GATEWAY_ZONE_KEY;
      if (odFocus === "from_airport") return fromAirport;
      if (odFocus === "to_airport") return toAirport;
      return fromAirport || toAirport;
    })
  }), [dataset.mobilityFlows.features, odFocus]);
  const focusedDataset = useMemo(() => ({
    ...dataset,
    mobilityFlows: focusedMobilityFlows
  }), [dataset, focusedMobilityFlows]);
  const chronologicalSlots = useMemo(
    () => [...timelineSlots].slice(0, 48).reverse(),
    [timelineSlots]
  );
  const timelineIndex = timelineAt === "latest"
    ? Math.max(0, chronologicalSlots.length - 1)
    : Math.max(0, chronologicalSlots.findIndex((slot) => slot.slotUtc === timelineAt));
  const currentDisplayGridView = `${formatBbox(bbox)}|${displayGridMetric}|${displayGridCategory}`;
  const displayGridViewChanged = displayGridLoadedView != null && displayGridLoadedView !== currentDisplayGridView;
  const refreshPrediction = () => {
    const viewport = formatBbox(clampBaliQueryBbox(bbox));
    clearCachedJson("/api/v1/mobility/readiness");
    clearCachedJson(`/api/v1/mobility/zones?bbox=${viewport}&at=${encodeURIComponent(timelineAt)}&limit=5000`);
    clearCachedJson(`/api/v1/mobility/flows?bbox=${viewport}&at=${encodeURIComponent(timelineAt)}&minScore=0&limit=5000`);
    clearCachedJson("/api/v1/mobility/slots?limit=48");
    setReloadTick((value) => value + 1);
  };

  useEffect(() => {
    if (refreshTick === 0 || timelineAt !== "latest") return;
    refreshPrediction();
    // Refresh is intentionally driven by the parent snapshot identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  useEffect(() => {
    let controller = new AbortController();
    const load = async () => {
      controller.abort();
      controller = new AbortController();
      try {
        const response = await fetchCachedJson<{ data: MobilityPredictionReadiness }>(
          "/api/v1/mobility/readiness",
          { ttlMs: 15_000, timeoutMs: 5_000, maxAttempts: 2 }
        );
        if (controller.signal.aborted) return;
        setReadiness(response.data);
        setReadinessError(null);
      } catch (error) {
        if (!controller.signal.aborted) setReadinessError(error instanceof Error ? publicDataMessage(error.message) : "Prediction readiness is unavailable.");
      }
    };
    void load();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => { controller.abort(); window.clearInterval(poll); };
  }, [reloadTick]);

  useEffect(() => {
    if (!readiness?.ready) return;
    const controller = new AbortController();
    let retryTimer: number | null = null;
    const timer = window.setTimeout(async () => {
      setLoadingData(true);
      try {
        const viewport = formatBbox(clampBaliQueryBbox(bbox));
        const zonesUrl = `/api/v1/mobility/zones?bbox=${viewport}&at=${encodeURIComponent(timelineAt)}&limit=5000`;
        const flowsUrl = `/api/v1/mobility/flows?bbox=${viewport}&at=${encodeURIComponent(timelineAt)}&minScore=0&limit=5000`;
        if (timelineAt === "latest") {
          clearCachedJson(zonesUrl);
          clearCachedJson(flowsUrl);
        }
        const [zones, flows] = await Promise.all([
          fetchCachedJson<MobilityCollection<MobilityZoneProperties>>(
            zonesUrl,
            { ttlMs: 5 * 60_000, timeoutMs: 5_000, maxAttempts: 2 }
          ),
          fetchCachedJson<MobilityCollection<MobilityFlowProperties>>(
            flowsUrl,
            { ttlMs: 5 * 60_000, timeoutMs: 5_000, maxAttempts: 2 }
          )
        ]);
        if (controller.signal.aborted) return;
        setDataset((current) => ({
          flow: emptyCollection(), incidents: emptyCollection(),
          zones: { type: "FeatureCollection", features: zones.features },
          mobilityFlows: { type: "FeatureCollection", features: flows.features },
          centers: current.centers,
          displayGrid: current.displayGrid
        }));
        setDataMeta(zones.meta);
        setDataError(null);
      } catch (error) {
        if (!controller.signal.aborted) {
          setDataError(error instanceof Error ? publicDataMessage(error.message) : "Prediction data is unavailable.");
          retryTimer = window.setTimeout(
            () => setReloadTick((value) => value + 1),
            nextDashboardRefreshDelayMs(true)
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoadingData(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      if (retryTimer != null) window.clearTimeout(retryTimer);
      controller.abort();
    };
  }, [bbox, readiness?.latestModelRun?.id, readiness?.ready, reloadTick, timelineAt]);

  useEffect(() => {
    if (!readiness?.ready) return;
    const controller = new AbortController();
    void fetchCachedJson<{ data: { slots: MobilityTimelineSlot[] } }>(
      "/api/v1/mobility/slots?limit=48",
      { ttlMs: 60_000, timeoutMs: 5_000, maxAttempts: 2 }
    ).then((response) => {
      if (!controller.signal.aborted) setTimelineSlots(response.data.slots);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [readiness?.latestModelRun?.id, readiness?.ready, reloadTick]);

  useEffect(() => {
    if (!readiness?.ready || !placesLayerEnabled || !layers.placesHeatmap || displayGridRequestTick === 0) return;
    if (displayGridHandledRequestRef.current === displayGridRequestTick) return;
    displayGridHandledRequestRef.current = displayGridRequestTick;
    const controller = new AbortController();
    let awaitingRender = false;
    const timer = window.setTimeout(async () => {
      setDisplayGridLoading(true);
      const requestedCategory = displayGridCategory;
      const requestedMetric = displayGridMetric;
      const requestedView = `${formatBbox(bbox)}|${requestedMetric}|${requestedCategory}`;
      try {
        const response = await fetchSourceContext<DisplayGridPayload>(
          displayGridRequestUrl(bbox, predictionZoom, requestedMetric, requestedCategory)
        );
        if (controller.signal.aborted) return;
        if (response.data.category !== requestedCategory || response.data.metric !== requestedMetric) {
          throw new Error(`The display-grid response did not match the requested ${requestedCategory} ${requestedMetric} view.`);
        }
        displayGridPendingRenderRef.current = {
          category: requestedCategory,
          metric: requestedMetric,
          cellCount: response.data.cells.features.length
        };
        setDataset((current) => ({ ...current, displayGrid: response.data.cells }));
        awaitingRender = true;
        setDisplayGridMeta(response.meta);
        setDisplayGridLoadedView(requestedView);
        setDisplayGridError(null);
      } catch (error) {
        displayGridPendingRenderRef.current = null;
        if (!controller.signal.aborted) setDisplayGridError(error instanceof Error ? publicDataMessage(error.message) : "Places 3D stack is unavailable.");
      } finally {
        if (!controller.signal.aborted && !awaitingRender) setDisplayGridLoading(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // On-demand reference layer: viewport movement alone never queries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayGridRequestTick, layers.placesHeatmap, placesLayerEnabled, readiness?.ready]);

  useEffect(() => {
    if (layers.placesHeatmap && placesLayerEnabled) return;
    setDataset((current) => current.displayGrid.features.length
      ? { ...current, displayGrid: emptyCollection() }
      : current);
  }, [layers.placesHeatmap, placesLayerEnabled]);

  useEffect(() => {
    if (!timelinePlaying || chronologicalSlots.length < 2) return;
    const timer = window.setInterval(() => {
      setTimelineAt((current) => {
        if (loadingData) return current;
        const currentIndex = current === "latest"
          ? -1
          : chronologicalSlots.findIndex((slot) => slot.slotUtc === current);
        const nextIndex = currentIndex < 0 ? 0 : currentIndex + 1;
        if (nextIndex >= chronologicalSlots.length) {
          setTimelinePlaying(false);
          return chronologicalSlots.at(-1)?.slotUtc ?? "latest";
        }
        return chronologicalSlots[nextIndex]!.slotUtc;
      });
    }, timelineSpeedMs);
    return () => window.clearInterval(timer);
  }, [chronologicalSlots, loadingData, timelinePlaying, timelineSpeedMs]);

  if (!readiness && !readinessError) return <PredictionWorkspaceSkeleton />;
  if (!readiness) return <EmptyState title="Prediction readiness unavailable" body={readinessError ?? "The readiness service did not return."} />;
  if (!readiness.ready) return <PredictionGateState readiness={readiness} onRefresh={refreshPrediction} />;

  const topZone = [...dataset.zones.features].sort((left, right) => right.properties.presenceScore - left.properties.presenceScore)[0];
  const averageConfidence = dataset.zones.features.length
    ? dataset.zones.features.reduce((sum, feature) => sum + feature.properties.confidence, 0) / dataset.zones.features.length
    : readiness.latestModelRun?.inputCoverage ?? null;
  const hasData = dataset.zones.features.length > 0;
  const flowIdentity = `mobility|${readiness.latestModelRun?.id ?? "no-run"}|${dataMeta?.slotUtc ?? "latest"}`;

  return <div className="space-y-5" data-testid="predicted-mobility-workspace">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#dbe2dd] bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#e5eee9] text-[#2c6657]"><Activity size={17} /></span><div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#81908b]">{timelineAt === "latest" ? "Latest prediction" : "Pinned historical prediction"}</p><p className="text-sm font-bold">{formatWita(dataMeta?.slotUtc ?? readiness.latestModelRun?.predictionForUtc)} WITA · {publicModelVersion(dataMeta?.modelVersion ?? readiness.latestModelRun?.modelVersion)}</p></div></div>
      <div className="flex items-center gap-2"><span className="rounded-lg bg-[#fff1d2] px-3 py-2 text-xs font-bold text-[#8b611c]">Internal shadow</span><button className="control-button" onClick={refreshPrediction} aria-label="Refresh prediction"><RefreshCw size={16} className={loadingData ? "animate-spin" : ""} /></button></div>
    </div>
    <Banner tone="amber" text={MOBILITY_SHADOW_DISCLAIMER} />
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard icon={Layers3} label="Predicted zones" value={String(dataset.zones.features.length)} hint="Relative model indices" />
      <MetricCard icon={Navigation} label="Visible OD links" value={String(focusedMobilityFlows.features.length)} hint={`${dataset.mobilityFlows.features.length} total directional relationships`} />
      <MetricCard icon={Map} label="Highest activity zone" value={topZone?.properties.name ?? "—"} hint={topZone ? `Index ${topZone.properties.presenceScore.toFixed(1)}` : "No zone prediction"} />
      <MetricCard icon={ShieldCheck} label="Input confidence" value={averageConfidence == null ? "—" : `${Math.round(averageConfidence * 100)}%`} hint="Coverage quality, not accuracy" />
    </section>
    {dataError ? <Banner tone="amber" text={`${dataError} Previous valid predictions remain visible.`} action={<button className="font-bold" onClick={refreshPrediction}>Retry</button>} /> : null}
    {!hasData && loadingData ? <PredictionMapSkeleton /> : !hasData ? <EmptyState title="Prediction output unavailable" body="The model gate passed, but this viewport returned no zone predictions." /> : <section className="grid min-h-[650px] gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="relative min-h-[650px]">
        <BaliMobilityMap active data={focusedDataset} metric="presence" layers={layers} minMobilityScore={minimumScore} minTrafficConfidence={0} selection={selection} onSelect={setPredictionSelection} config={config} flowIdentity={flowIdentity} onViewportChange={(nextBbox, zoom) => { setPredictionBbox(nextBbox); setPredictionZoom(zoom); }} onBasemapError={setBasemapWarning} onDisplayGridRendered={() => { const applied = displayGridPendingRenderRef.current; if (applied) setDisplayGridApplied(applied); displayGridPendingRenderRef.current = null; setDisplayGridLoading(false); }} />
        {displayGridLoading && layers.placesHeatmap ? <DisplayGridLoadingOverlay /> : null}
      </div>
      <div className="space-y-4">
        <Panel title="Mobility timelapse" icon={CalendarClock}>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2"><button type="button" onClick={() => { if (!timelinePlaying && timelineAt === "latest") setTimelineAt(chronologicalSlots[0]?.slotUtc ?? "latest"); setTimelinePlaying((value) => !value); }} disabled={chronologicalSlots.length < 2} className="control-button">{timelinePlaying ? <Pause size={14} /> : <Play size={14} />}{timelinePlaying ? "Pause" : "Play"}</button><select value={timelineSpeedMs} onChange={(event) => setTimelineSpeedMs(Number(event.target.value))} className="rounded-lg border border-[#ccd7d1] bg-white px-2 py-2 text-[10px] font-bold"><option value={2000}>0.5×</option><option value={1200}>1×</option><option value={650}>2×</option></select></div>
            <input aria-label="Mobility timelapse slot" type="range" min="0" max={Math.max(0, chronologicalSlots.length - 1)} step="1" value={timelineIndex} disabled={!chronologicalSlots.length} onChange={(event) => { setTimelinePlaying(false); setTimelineAt(chronologicalSlots[Number(event.target.value)]?.slotUtc ?? "latest"); }} className="mobility-range w-full" />
            <div className="flex items-start justify-between gap-3 text-[10px]"><span className="text-[#71817b]">{formatWita(chronologicalSlots[0]?.slotUtc, true)}</span><span className="text-center font-bold text-[#344b43]">{formatWita(dataMeta?.slotUtc ?? timelineAt, true)} WITA<br/><span className="font-semibold text-[#71817b]">{loadingData ? "Loading frame…" : timelineAt === "latest" ? "Latest" : "Historical slot"}</span></span><span className="text-right text-[#71817b]">{formatWita(chronologicalSlots.at(-1)?.slotUtc, true)}</span></div>
            {timelineAt !== "latest" ? <button type="button" onClick={() => { setTimelinePlaying(false); setTimelineAt("latest"); }} className="w-full rounded-lg bg-[#edf2ef] px-3 py-2 text-[10px] font-bold text-[#315f53]">Return to latest</button> : null}
          </div>
        </Panel>
        <Panel title="Prediction layers" icon={Layers3}>
          <div className="space-y-4">
            <LayerToggle checked={layers.mobility} label="Zone boundaries" color="#dce8e3" onChange={() => setLayers((current) => ({ ...current, mobility: !current.mobility }))} />
            <LayerToggle checked={layers.flows} label="Animated OD arrows" color="#f06f3c" tooltip="Compact arrow trains move from model origin to destination. Stronger scores use larger and longer trains, such as >>>>. They are not observed people or trip counts." onChange={() => setLayers((current) => ({ ...current, flows: !current.flows }))} />
            <LayerToggle checked={layers.placesHeatmap} label="Places 3D stack" color="linear-gradient(90deg,#2c7bb6,#f1d374,#df3f36)" tooltip="Taller grid columns mean a higher relative index. This is display-only context, not a predicted movement surface." onChange={() => {
              if (!placesLayerEnabled) return;
              const enable = !layers.placesHeatmap;
              setLayers((current) => ({ ...current, placesHeatmap: enable }));
              if (enable) setDisplayGridRequestTick((value) => value + 1);
            }} />
            {placesLayerEnabled && layers.placesHeatmap ? <div className="space-y-2 rounded-xl border border-[#dce4df] bg-[#f8faf8] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#52645d]">Places context · not prediction</p>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setDisplayGridMetric("attraction")} className={`rounded-lg px-2 py-2 text-[10px] font-bold ${displayGridMetric === "attraction" ? "bg-[#315f53] text-white" : "bg-white text-[#425750]"}`}>Relative attraction</button>
                <button type="button" onClick={() => setDisplayGridMetric("placeDensity")} className={`rounded-lg px-2 py-2 text-[10px] font-bold ${displayGridMetric === "placeDensity" ? "bg-[#315f53] text-white" : "bg-white text-[#425750]"}`}>Place density</button>
              </div>
              <select aria-label="Prediction reference 3D stack category" value={displayGridCategory} onChange={(event) => setDisplayGridCategory(event.target.value)} className="w-full rounded-lg border border-[#ccd7d1] bg-white px-3 py-2 text-xs font-bold"><option value="all">All categories</option>{PLACE_CATEGORIES.map((category) => <option key={category} value={category}>{category[0]!.toUpperCase() + category.slice(1)}</option>)}</select>
              <DisplayGridLegend />
              <button type="button" onClick={() => { sourceContextCache.delete(displayGridRequestUrl(bbox, predictionZoom, displayGridMetric, displayGridCategory)); setDisplayGridRequestTick((value) => value + 1); }} disabled={displayGridLoading} aria-busy={displayGridLoading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#315f53] px-3 py-2 text-[10px] font-bold text-white disabled:opacity-60"><RefreshCw size={12} className={displayGridLoading ? "animate-spin" : ""} /><span>Refresh 3D stack</span></button>
              <p className={`min-h-[1.25rem] text-[9px] leading-relaxed ${displayGridViewChanged ? "text-[#8b611c]" : "invisible"}`}>{displayGridViewChanged ? "Map moved. Cached stack remains until refresh." : "3D stack view is current."}</p>
              {displayGridError ? <p className="rounded bg-[#fff1d2] px-2 py-1.5 text-[10px] font-semibold text-[#8b611c]">{displayGridError} Previous cells remain visible.</p> : null}
              {displayGridApplied ? <p className="rounded bg-[#e5eee9] px-2 py-1.5 text-[9px] font-bold text-[#315f53]">Showing {displayGridApplied.category === "all" ? "All categories" : displayGridApplied.category} · {displayGridApplied.cellCount.toLocaleString()} rendered cells</p> : null}
              {displayGridMeta?.isFallback ? <p className="rounded bg-[#e8f1f6] px-2 py-1.5 text-[9px] leading-relaxed text-[#315e78]">Fine-grid build restored from the latest completed partial source build.</p> : null}
              {Number(displayGridMeta?.sourceSaturatedTaskCount ?? 0) > 0 ? <p className="rounded bg-[#fff1d2] px-2 py-1.5 text-[10px] text-[#8b611c]">Partial coverage: {Number(displayGridMeta?.sourceSaturatedTaskCount)} search tasks reached their result ceiling.</p> : null}
              <p className="text-[9px] leading-relaxed text-[#52645d]">{DISPLAY_GRID_DISCLAIMER}</p>
            </div> : null}
            <label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-[.1em] text-[#71817b]">OD focus</span><select value={odFocus} onChange={(event) => setOdFocus(event.target.value as OdFocus)} className="w-full rounded-lg border border-[#ccd7d1] bg-white px-3 py-2 text-xs font-bold text-[#344b43]"><option value="airport_both">DPS gateway · both directions</option><option value="from_airport">From DPS gateway</option><option value="to_airport">To DPS gateway</option><option value="all">All zone relationships</option></select><span className="mt-1.5 block text-[10px] leading-relaxed text-[#71817b]">DPS is represented by its containing Badung zone. These are zone predictions, not airport trip observations.</span></label>
            <div><div className="mb-2 flex justify-between text-[10px] font-bold uppercase tracking-[.1em] text-[#71817b]"><span>Minimum OD score</span><span>{minimumScore}</span></div><input className="mobility-range w-full" aria-label="Minimum predicted OD score" type="range" min="0" max="100" step="5" value={minimumScore} onChange={(event) => setMinimumScore(Number(event.target.value))} /></div>
          </div>
        </Panel>
        <Panel title="Model identity" icon={Database}><dl className="space-y-3 text-xs"><Pair label="Run" value={String(dataMeta?.modelRunId ?? readiness.latestModelRun?.id ?? "—")} /><Pair label="Version" value={publicModelVersion(dataMeta?.modelVersion ?? readiness.latestModelRun?.modelVersion)} /><Pair label="Status" value={dataMeta?.status ?? readiness.latestModelRun?.status ?? "—"} /><Pair label="Coverage" value={percent(dataMeta?.coverage ?? readiness.latestModelRun?.inputCoverage)} /><Pair label="Semantics" value="Relative prediction" /></dl></Panel>
        {selection ? <PredictionSelection selection={selection} /> : null}
      </div>
    </section>}
  </div>;
}

const PLACE_CATEGORY_COLORS: Record<(typeof PLACE_CATEGORIES)[number], string> = {
  dining: "#ef4444", accommodation: "#8b5cf6", attraction: "#f59e0b",
  culture: "#a855f7", beach: "#06b6d4", shopping: "#ec4899",
  nightlife: "#6366f1", recreation: "#22c55e", transport: "#64748b"
};

function PlacesCategoryLegend() {
  return <div className="grid grid-cols-2 gap-x-2 gap-y-1 border-t border-[#dce4df] pt-2">
    {PLACE_CATEGORIES.map((category) => <span key={category} className="flex items-center gap-1.5 text-[9px] font-semibold capitalize text-[#61736c]"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: PLACE_CATEGORY_COLORS[category] }} />{category}</span>)}
    <p className="col-span-2 mt-1 text-[9px] leading-relaxed text-[#71817b]">Color represents the primary place category. Cluster positions are averaged locations.</p>
  </div>;
}

function DisplayGridLegend() {
  return <div className="space-y-1.5">
    <div className="flex items-center justify-between text-[9px] font-bold text-[#65766f]"><span>0 Low</span><span>Relative index</span><span>100 High</span></div>
    <div className="h-2 rounded-full" style={{ background: "linear-gradient(90deg,#2c7bb6,#77b9d6,#f1d374,#ed8c55,#df3f36)" }} />
    <p className="text-[9px] leading-relaxed text-[#71817b]">Higher relative index = taller column. Height is not a place, visitor, or trip count.</p>
  </div>;
}

function PredictionGateState({ readiness, onRefresh }: { readiness: MobilityPredictionReadiness; onRefresh: () => void }) {
  const countItems = [
    ["Active zones", readiness.counts.activeZones], ["Activity centers", readiness.counts.activityCenters],
    ["Road mappings", readiness.counts.zoneRoadMappings], ["Zone predictions", readiness.counts.zonePredictions],
    ["OD predictions", readiness.counts.odPredictions]
  ] as const;
  return <div className="space-y-5" data-testid="predicted-mobility-gate">
    <section className="rounded-2xl border border-[#efd1a6] bg-[#fffaf0] p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div className="max-w-3xl"><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#9b6812]">Workspace open · production data blocked</p><h2 className="mt-2 text-xl font-bold">Predicted movement will appear after the model data gates pass</h2><p className="mt-2 text-sm leading-relaxed text-[#6c665a]">The dashboard will not turn road congestion into people movement or substitute demo predictions. It checks production readiness every 30 seconds and will activate the map automatically.</p></div><button className="control-button" onClick={onRefresh}><RefreshCw size={15} />Check now</button></div></section>
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Panel title="Production prediction gates" icon={ShieldCheck}><div className="grid gap-3 sm:grid-cols-2">{Object.entries(MOBILITY_GATE_LABELS).map(([key, label]) => { const blocked = readiness.missing.includes(key as MobilityPredictionReadiness["missing"][number]); return <div key={key} className={`flex items-center gap-3 rounded-xl border px-3 py-3 ${blocked ? "border-[#efd1a6] bg-[#fff7e9]" : "border-[#cce3d6] bg-[#edf7f1]"}`}><span className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${blocked ? "bg-[#f5dda8] text-[#8b611c]" : "bg-[#cfe9da] text-[#277151]"}`}>{blocked ? "!" : "✓"}</span><span className="text-xs font-semibold">{label}</span></div>; })}</div></Panel>
      <div className="space-y-5"><Panel title="Current model inputs" icon={Database}><dl className="space-y-3 text-xs">{countItems.map(([label, value]) => <Pair key={label} label={label} value={value.toLocaleString()} />)}<Pair label="Scope" value={readiness.scope.status} /><Pair label="Prediction flag" value={readiness.scope.predictionEnabled ? "Enabled" : "Disabled"} /></dl></Panel><Panel title="Prediction meaning" icon={Info}><p className="text-xs leading-relaxed text-[#66766f]">{publicDataMessage(readiness.disclaimer)}</p></Panel></div>
    </section>
  </div>;
}

function PredictionWorkspaceSkeleton() {
  return <div className="space-y-5" role="status" aria-label="Checking prediction readiness"><div className="route-map-skeleton-frame h-16 rounded-2xl" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((item) => <div key={item} className="route-map-skeleton-frame h-32 rounded-2xl" />)}</div><div className="route-map-skeleton-frame h-[520px] rounded-2xl" /><span className="sr-only">Checking production model and mobility inputs…</span></div>;
}

function PredictionMapSkeleton() {
  return <div className="h-[650px] rounded-2xl border border-[#dbe2dd] bg-white p-4" role="status" aria-label="Loading predicted mobility map"><div className="route-map-skeleton-frame h-full rounded-xl" /><span className="sr-only">Loading real prediction zones and origin-destination relationships…</span></div>;
}

function DisplayGridLoadingOverlay() {
  return <div className="pointer-events-none absolute inset-0 z-[9] grid place-items-center rounded-[22px] bg-[#18201e]/35 backdrop-blur-[1px]" role="status" aria-live="polite" aria-label="Rendering places 3D stack">
    <div className="w-[min(280px,calc(100%-32px))] rounded-2xl border border-white/20 bg-[#203c35]/95 p-4 text-white shadow-2xl">
      <div className="route-map-skeleton-frame h-2.5 rounded-full opacity-80" />
      <div className="mt-3 flex items-center gap-3"><RefreshCw size={16} className="animate-spin shrink-0" /><div><p className="text-xs font-bold">Rendering 3D stack</p><p className="mt-0.5 text-[10px] text-[#c6d7d1]">Loading ends after the new cells are painted.</p></div></div>
    </div>
  </div>;
}

function PredictionSelection({ selection }: { selection: Exclude<MapSelection, null> }) {
  if (selection.kind === "zone") return <Panel title="Selected predicted zone" icon={Map}><dl className="space-y-3 text-xs"><Pair label="Zone" value={selection.feature.properties.name} /><Pair label="Presence" value={selection.feature.properties.presenceScore.toFixed(1)} /><Pair label="Inbound" value={selection.feature.properties.inboundScore.toFixed(1)} /><Pair label="Outbound" value={selection.feature.properties.outboundScore.toFixed(1)} /><Pair label="Confidence" value={`${Math.round(selection.feature.properties.confidence * 100)}%`} /></dl></Panel>;
  if (selection.kind === "flow") {
    const flow = selection.feature.properties;
    const klungkung = flow.originName === "Klungkung" || flow.destinationName === "Klungkung";
    return <Panel title="Selected predicted OD" icon={Navigation}><dl className="space-y-3 text-xs"><Pair label="Direction" value={`${flow.originName} → ${flow.destinationName}`} /><Pair label="Relative mobility score" value={flow.mobilityScore.toFixed(1)} /><Pair label="Predicted destination share from selected origin" value={`${(flow.predictedShare * 100).toFixed(1)}%`} /><Pair label="Road duration" value={formatDuration(flow.durationSeconds ?? flow.travelTimeSeconds)} /><Pair label="Road distance" value={flow.distanceMeters == null ? "—" : `${(flow.distanceMeters / 1000).toFixed(1)} km`} /><Pair label="Confidence" value={`${Math.round(flow.confidence * 100)}%`} /></dl>{klungkung ? <p className="mt-3 rounded-lg bg-[#fff1d2] px-3 py-2 text-[10px] font-semibold text-[#8b611c]">Klungkung travel time and accessibility are mainland-road estimates using Semarapura. Ferry and marine access to Nusa Penida are not modeled.</p> : null}</Panel>;
  }
  if (selection.kind === "center") {
    const place = selection.feature.properties;
    return <Panel title={place.source === "here_places_point" ? "Place" : "Places group"} icon={Map}><dl className="space-y-3 text-xs"><Pair label="Name" value={place.name} /><Pair label="Display category" value={place.category} />{place.primaryCategory ? <Pair label="Primary category" value={String(place.primaryCategory)} /> : null}{place.modelCategory ? <Pair label="Model category" value={String(place.modelCategory)} /> : null}{place.zoneName ? <Pair label="Zone" value={String(place.zoneName)} /> : null}{place.centerCount && Number(place.centerCount) > 1 ? <Pair label="Places in group" value={Number(place.centerCount).toLocaleString()} /> : null}<Pair label="Model attraction weight" value={place.attractionScore.toFixed(2)} />{place.modelEligible != null ? <Pair label="Model eligible" value={Boolean(place.modelEligible) ? "Yes" : "No"} /> : null}{place.accessScope ? <Pair label="Access scope" value={String(place.accessScope)} /> : null}{place.lastSeenAtUtc ? <Pair label="Last update" value={`${formatWita(String(place.lastSeenAtUtc))} WITA`} /> : null}</dl><p className="mt-3 text-[10px] leading-relaxed text-[#71817b]">Marker color represents the primary category. Attraction weight is a model input, not popularity, visitors, visits, or trip counts.</p></Panel>;
  }
  if (selection.kind === "displayGrid") {
    const cell = selection.feature.properties;
    return <Panel title="Places reference cell" icon={Map}><dl className="space-y-3 text-xs"><Pair label="Category" value={cell.category === "all" ? "All categories" : cell.category} /><Pair label="Relative index" value={`${cell.relativeIndex.toFixed(1)} / 100`} /><Pair label="Place count" value={cell.activePlaceCount.toLocaleString()} /><Pair label="Model-eligible center count" value={cell.modelEligiblePlaceCount.toLocaleString()} /></dl><p className="mt-3 text-[10px] leading-relaxed text-[#71817b]">{DISPLAY_GRID_DISCLAIMER}</p></Panel>;
  }
  return <></>;
}

function LiveView({ active, data, overview, mapData, config, minConfidence, setMinConfidence, selection, setSelection, setBbox, setBasemapWarning, mode, placesLayerEnabled }: {
  active: boolean;
  data: SourceDashboardData; overview: TrafficOverview; mapData: MapDataset; config: BasemapConfig; minConfidence: number; setMinConfidence: (value: number) => void;
  selection: MapSelection; setSelection: (value: MapSelection) => void; setBbox: (bbox: Bbox) => void; setBasemapWarning: (message: string | null) => void;
  mode: Mode; placesLayerEnabled: boolean;
}) {
  const [layers, setLayers] = useState(DEFAULT_MAP_LAYERS);
  const [placesCollection, setPlacesCollection] = useState<FeatureCollection<CenterProperties>>(emptyCollection());
  const [displayGrid, setDisplayGrid] = useState<FeatureCollection<DisplayGridProperties>>(emptyCollection());
  const [displayGridMetric, setDisplayGridMetric] = useState<"attraction" | "placeDensity">("attraction");
  const [displayGridCategory, setDisplayGridCategory] = useState("all");
  const [displayGridLoading, setDisplayGridLoading] = useState(false);
  const [displayGridError, setDisplayGridError] = useState<string | null>(null);
  const [displayGridMeta, setDisplayGridMeta] = useState<ApiMeta | null>(null);
  const [displayGridRequestTick, setDisplayGridRequestTick] = useState(0);
  const [displayGridLoadedView, setDisplayGridLoadedView] = useState<string | null>(null);
  const [displayGridApplied, setDisplayGridApplied] = useState<{ category: string; metric: "attraction" | "placeDensity"; cellCount: number } | null>(null);
  const displayGridPendingRenderRef = useRef<{ category: string; metric: "attraction" | "placeDensity"; cellCount: number } | null>(null);
  const displayGridHandledRequestRef = useRef(0);
  const [placesBbox, setPlacesBbox] = useState<Bbox>(DEFAULT_BALI_BBOX);
  const [placesZoom, setPlacesZoom] = useState(8.5);
  const [placesCategory, setPlacesCategory] = useState("");
  const [placesEligibleOnly, setPlacesEligibleOnly] = useState(false);
  const [placesLoading, setPlacesLoading] = useState(false);
  const [placesError, setPlacesError] = useState<string | null>(null);
  const [placesMeta, setPlacesMeta] = useState<ApiMeta | null>(null);
  const [placesRequestTick, setPlacesRequestTick] = useState(0);
  const [placesLoadedView, setPlacesLoadedView] = useState<string | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);
  const openWorkspaceRef = useRef<HTMLButtonElement>(null);
  const closeWorkspaceRef = useRef<HTMLButtonElement>(null);
  const sourceContextPrefetchedRef = useRef(false);
  const liveMapData = useMemo<MapDataset>(() => ({ ...mapData, centers: placesCollection, displayGrid }), [displayGrid, mapData, placesCollection]);
  const currentPlacesView = `${formatBbox(placesBbox)}|${placesZoom.toFixed(2)}|${placesCategory || "all"}|${placesEligibleOnly}`;
  const placesViewChanged = placesLoadedView != null && placesLoadedView !== currentPlacesView;
  const currentDisplayGridView = `${formatBbox(placesBbox)}|${displayGridMetric}|${displayGridCategory}`;
  const displayGridViewChanged = displayGridLoadedView != null && displayGridLoadedView !== currentDisplayGridView;
  const monitoredRoutes = useMemo(() => [...data.routes].sort((left, right) => {
    const leftRatio = left.ratioVsTypical;
    const rightRatio = right.ratioVsTypical;
    if (leftRatio == null) return rightRatio == null ? left.name.localeCompare(right.name) : 1;
    if (rightRatio == null) return -1;
    return rightRatio - leftRatio || left.name.localeCompare(right.name);
  }).slice(0, 5), [data.routes]);
  const flowIdentity = [
    data.meta.sourceRunId ?? "no-run",
    data.meta.slotUtc ?? "no-slot",
    data.meta.status,
    data.meta.coverage ?? "no-coverage",
    data.flow.features.length
  ].join("|");
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
    if (!active || !placesLayerEnabled || sourceContextPrefetchedRef.current) return;
    sourceContextPrefetchedRef.current = true;
    void Promise.allSettled([
      fetchSourceContext<PlacesPayload>(placesRequestUrl(placesBbox, placesZoom, "", false)),
      fetchSourceContext<DisplayGridPayload>(displayGridRequestUrl(placesBbox, placesZoom, "attraction", "all"))
    ]);
  }, [active, placesBbox, placesLayerEnabled, placesZoom]);

  useEffect(() => {
    if (!active || !placesLayerEnabled || !layers.centers) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPlacesLoading(true);
      try {
        const response = await fetchSourceContext<PlacesPayload>(
          placesRequestUrl(placesBbox, placesZoom, placesCategory, placesEligibleOnly)
        );
        if (controller.signal.aborted) return;
        const features: FeatureCollection<CenterProperties>["features"] = response.data.mode === "aggregate"
          ? (response.data.groups ?? []).map((group, index) => ({
              type: "Feature", id: `aggregate-${String(group.zoneKey)}-${String(group.category)}-${index}`,
              geometry: { type: "Point", coordinates: [Number(group.longitude), Number(group.latitude)] },
              properties: {
                ...group, centerId: index, zoneId: Number(group.zoneId), zoneKey: String(group.zoneKey),
                name: `${String(group.zoneName)} · ${String(group.category)}`,
                category: String(group.category), centerCount: Number(group.centerCount),
                attractionScore: Number(group.attractionWeight), source: "here_places_aggregate"
              }
            }))
          : (response.data.features ?? []).map((feature, index) => ({
              type: "Feature", id: feature.id, geometry: feature.geometry,
              properties: {
                ...feature.properties,
                centerId: Number(feature.id ?? index), zoneId: Number(feature.properties.zoneId ?? 0),
                name: feature.properties.kind === "cluster"
                  ? `${Number(feature.properties.centerCount)} ${String(feature.properties.category)} places`
                  : String(feature.properties.title ?? "Place"),
                category: String(feature.properties.category ?? "attraction"),
                centerCount: Number(feature.properties.centerCount ?? 1),
                attractionScore: Number(feature.properties.attractionWeight ?? feature.properties.modelAttractionWeight ?? 0),
                source: feature.properties.kind === "cluster" ? "here_places_cluster" : "here_places_point"
              }
            }));
        setPlacesCollection({ type: "FeatureCollection", features });
        setPlacesMeta(response.meta);
        setPlacesLoadedView(currentPlacesView);
        setPlacesError(null);
      } catch (error) {
        if (!controller.signal.aborted) setPlacesError(error instanceof Error ? publicDataMessage(error.message) : "Places are temporarily unavailable.");
      } finally {
        if (!controller.signal.aborted) setPlacesLoading(false);
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // Places are intentionally refreshed only when enabled or requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, layers.centers, placesLayerEnabled, placesRequestTick]);

  useEffect(() => {
    if (layers.centers && placesLayerEnabled) return;
    setPlacesCollection((current) => current.features.length ? emptyCollection() : current);
  }, [layers.centers, placesLayerEnabled]);

  useEffect(() => {
    if (!active || !layers.placesHeatmap || displayGridRequestTick === 0) return;
    if (displayGridHandledRequestRef.current === displayGridRequestTick) return;
    displayGridHandledRequestRef.current = displayGridRequestTick;
    const controller = new AbortController();
    let awaitingRender = false;
    const timer = window.setTimeout(async () => {
      setDisplayGridLoading(true);
      const requestedCategory = displayGridCategory;
      const requestedMetric = displayGridMetric;
      const requestedView = `${formatBbox(placesBbox)}|${requestedMetric}|${requestedCategory}`;
      try {
        const response = await fetchSourceContext<DisplayGridPayload>(
          displayGridRequestUrl(placesBbox, placesZoom, requestedMetric, requestedCategory)
        );
        if (controller.signal.aborted) return;
        if (response.data.category !== requestedCategory || response.data.metric !== requestedMetric) {
          throw new Error(`The display-grid response did not match the requested ${requestedCategory} ${requestedMetric} view.`);
        }
        displayGridPendingRenderRef.current = {
          category: requestedCategory,
          metric: requestedMetric,
          cellCount: response.data.cells.features.length
        };
        setDisplayGrid(response.data.cells);
        awaitingRender = true;
        setDisplayGridMeta(response.meta);
        setDisplayGridLoadedView(requestedView);
        setDisplayGridError(null);
      } catch (error) {
        displayGridPendingRenderRef.current = null;
        if (!controller.signal.aborted) setDisplayGridError(error instanceof Error ? publicDataMessage(error.message) : "Places 3D stack is unavailable.");
      } finally {
        if (!controller.signal.aborted && !awaitingRender) setDisplayGridLoading(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // Deliberately on-demand: map movement updates the pending viewport but
    // never starts another database request by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, displayGridRequestTick, layers.placesHeatmap]);

  useEffect(() => {
    if (layers.placesHeatmap) return;
    setDisplayGrid((current) => current.features.length ? emptyCollection() : current);
  }, [layers.placesHeatmap]);

  const layerPanel = <Panel title="Data layers" icon={Layers3}>
    <div className="space-y-3">
      <LayerToggle checked={layers.heatmap} label="Jam heatmap pulse" tooltip="Color and heartbeat reflect congestion from 0 to 10; higher values pulse faster and more strongly. This does not represent people movement." color="linear-gradient(90deg,#2d9b6f,#e9aa40,#d95345,#35131b)" onChange={() => setLayers((current) => ({ ...current, heatmap: !current.heatmap }))} />
      <LayerToggle checked={layers.traffic} label="Road segments" color="#e76538" onChange={() => setLayers((current) => ({ ...current, traffic: !current.traffic }))} />
      <LayerToggle checked={layers.centers} label="Places" color="#8b5cf6" tooltip="Places are classified by primary category. Marker size is place-record count, never visits or footfall." onChange={() => placesLayerEnabled && setLayers((current) => ({ ...current, centers: !current.centers }))} />
      {placesLayerEnabled && layers.centers ? <div className="space-y-2 rounded-xl border border-[#dce4df] bg-[#f8faf8] p-3">
        <div className="flex items-center justify-between"><p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#52645d]">Places</p><span className="text-[9px] font-bold uppercase text-[#71817b]">{placesZoom < 10 ? "Zone aggregate" : placesZoom <= 12 ? "Cluster" : "Point"} · z{placesZoom.toFixed(1)}</span></div>
        <select aria-label="Places category filter" value={placesCategory} onChange={(event) => setPlacesCategory(event.target.value)} className="w-full rounded-lg border border-[#ccd7d1] bg-white px-3 py-2 text-xs font-bold"><option value="">All categories</option>{PLACE_CATEGORIES.map((category) => <option key={category} value={category}>{category[0]!.toUpperCase() + category.slice(1)}</option>)}</select>
        <label className="flex items-center justify-between gap-3 text-[10px] font-semibold text-[#52645d]"><span>Limit to model-eligible places</span><input type="checkbox" checked={placesEligibleOnly} onChange={(event) => setPlacesEligibleOnly(event.target.checked)} /></label>
        <PlacesCategoryLegend />
        <button type="button" onClick={() => { sourceContextCache.delete(placesRequestUrl(placesBbox, placesZoom, placesCategory, placesEligibleOnly)); setPlacesRequestTick((value) => value + 1); }} disabled={placesLoading} aria-busy={placesLoading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#315f53] px-3 py-2 text-[10px] font-bold text-white disabled:opacity-60">
          <RefreshCw size={12} className={placesLoading ? "animate-spin" : ""} />
          <span>Refresh places</span>
        </button>
        <p className={`min-h-[1.25rem] text-[9px] leading-relaxed ${placesViewChanged ? "text-[#8b611c]" : "invisible"}`} aria-live="polite">{placesViewChanged ? "Map or filters changed. Cached Places remain until refresh." : "Places view is current."}</p>
        {!placesLoading && !placesError && placesCollection.features.length === 0 ? <p className="text-[10px] font-semibold text-[#71817b]">No matching places in this viewport.</p> : null}
        {placesError ? <p className="rounded bg-[#fff1d2] px-2 py-1.5 text-[10px] font-semibold text-[#8b611c]">{placesError} Previous results remain visible.</p> : null}
        {placesMeta?.saturatedTaskCount ? <p className="rounded bg-[#fff1d2] px-2 py-1.5 text-[10px] text-[#8b611c]">Partial coverage: {placesMeta.saturatedTaskCount} search tasks reached their result ceiling.</p> : null}
        {placesMeta?.truncated ? <p className="rounded bg-[#fff1d2] px-2 py-1.5 text-[10px] text-[#8b611c]">The display marker budget was reached. Zoom in and refresh for more local detail.</p> : null}
      </div> : !placesLayerEnabled ? <p className="text-[10px] font-semibold text-[#8b611c]">Places layer is disabled.</p> : null}
      <LayerToggle checked={layers.placesHeatmap} label="Places 3D stack" color="linear-gradient(90deg,#2c7bb6,#f1d374,#df3f36)" tooltip="Taller grid columns mean a higher relative index. The height is not a count." onChange={() => {
        if (!placesLayerEnabled) return;
        const enable = !layers.placesHeatmap;
        setLayers((current) => ({ ...current, placesHeatmap: enable }));
        if (enable) setDisplayGridRequestTick((value) => value + 1);
      }} />
      {placesLayerEnabled && layers.placesHeatmap ? <div className="space-y-2 rounded-xl border border-[#dce4df] bg-[#f8faf8] p-3">
        <p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#52645d]">Display-only source grid</p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setDisplayGridMetric("attraction")} className={`rounded-lg px-2 py-2 text-[10px] font-bold ${displayGridMetric === "attraction" ? "bg-[#315f53] text-white" : "bg-white text-[#425750]"}`}>Relative attraction</button>
          <button type="button" onClick={() => setDisplayGridMetric("placeDensity")} className={`rounded-lg px-2 py-2 text-[10px] font-bold ${displayGridMetric === "placeDensity" ? "bg-[#315f53] text-white" : "bg-white text-[#425750]"}`}>Place density</button>
        </div>
        <select aria-label="Places 3D stack category" value={displayGridCategory} onChange={(event) => setDisplayGridCategory(event.target.value)} className="w-full rounded-lg border border-[#ccd7d1] bg-white px-3 py-2 text-xs font-bold">
          <option value="all">All categories</option>
          {PLACE_CATEGORIES.map((category) => <option key={category} value={category}>{category[0]!.toUpperCase() + category.slice(1)}</option>)}
        </select>
        <DisplayGridLegend />
        <button type="button" onClick={() => { sourceContextCache.delete(displayGridRequestUrl(placesBbox, placesZoom, displayGridMetric, displayGridCategory)); setDisplayGridRequestTick((value) => value + 1); }} disabled={displayGridLoading} aria-busy={displayGridLoading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#315f53] px-3 py-2 text-[10px] font-bold text-white disabled:opacity-60">
          <RefreshCw size={12} className={displayGridLoading ? "animate-spin" : ""} />
          <span>Refresh 3D stack</span>
        </button>
        <p className={`min-h-[1.25rem] text-[9px] leading-relaxed ${displayGridViewChanged ? "text-[#8b611c]" : "invisible"}`} aria-live="polite">{displayGridViewChanged ? "Map moved. Cached stack remains until refresh." : "3D stack view is current."}</p>
        {displayGridLoading ? <p className="text-[9px] font-semibold text-[#52645d]">Updating visible grid…</p> : null}
        {displayGridError ? <p className="rounded bg-[#fff1d2] px-2 py-1.5 text-[10px] font-semibold text-[#8b611c]">{displayGridError} Previous cells remain visible.</p> : null}
        {displayGridApplied ? <p className="rounded bg-[#e5eee9] px-2 py-1.5 text-[9px] font-bold text-[#315f53]">Showing {displayGridApplied.category === "all" ? "All categories" : displayGridApplied.category} · {displayGridApplied.cellCount.toLocaleString()} rendered cells</p> : null}
        {displayGridMeta?.isFallback ? <p className="rounded bg-[#e8f1f6] px-2 py-1.5 text-[9px] leading-relaxed text-[#315e78]">Source grid restored from the latest completed partial build.</p> : null}
        {Number(displayGridMeta?.sourceSaturatedTaskCount ?? 0) > 0 ? <p className="rounded bg-[#fff1d2] px-2 py-1.5 text-[10px] text-[#8b611c]">Partial coverage: {Number(displayGridMeta?.sourceSaturatedTaskCount)} search tasks reached their result ceiling.</p> : null}
        {displayGridMeta ? <p className="text-[9px] leading-relaxed text-[#71817b]">Grid {String(displayGridMeta.gridVersion ?? "—")} · build {String(displayGridMeta.displayGridBuildId ?? "—")}</p> : null}
        <p className="text-[9px] leading-relaxed text-[#52645d]">{DISPLAY_GRID_DISCLAIMER}</p>
      </div> : null}
    </div>
    <div className="mt-5"><TrafficJamLegend testId="traffic-filter-legend" /></div>
    <label className="mt-6 block">
      <span className="mb-2 flex justify-between text-[10px] font-bold uppercase tracking-wide text-[#778680]"><span>Minimum confidence</span><span>{percent(minConfidence)}</span></span>
      <input className="mobility-range w-full" type="range" min="0" max="1" step=".05" value={minConfidence} onChange={(event) => setMinConfidence(Number(event.target.value))} />
    </label>
  </Panel>;

  const sourcePanel = <Panel title="Data status" icon={ShieldCheck}><dl className="space-y-3 text-xs"><Pair label="Status" value={data.meta.status} /><Pair label="Freshness" value={ageLabel(data.meta.actualSlotUtc ?? data.meta.slotUtc)} /><Pair label="Coverage" value={percent(data.meta.coverage)} /><Pair label="Features" value={String(data.trafficTiles?.featureCount ?? data.flow.features.length)} /><Pair label="Semantics" value="Measured traffic" /></dl></Panel>;

  const routesPanel = <Panel title="Top 5 monitored routes" icon={RouteIcon}>
    {monitoredRoutes.length ? <div className="space-y-4">{monitoredRoutes.map((route) => <RouteWatch key={route.id} route={route} />)}</div> : <p className="text-xs font-semibold text-[#73817c]">No monitored routes are available.</p>}
  </Panel>;

  return <div className="space-y-5">
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <MetricCard icon={Gauge} label="Weighted jam" value={overview.weightedJamFactor?.toFixed(1) ?? "—"} hint="Visible roads · length weighted" />
      <MetricCard icon={Activity} label="Congested roads" value={formatCongestedRoadShare(overview.congestedRoadShare)} hint="Visible roads · jam factor ≥ 6" />
      <MetricCard icon={CarFront} label="Measured length" value={`${(overview.measuredLengthMeters / 1000).toFixed(1)} km`} hint="Road length in map view" />
      <MetricCard icon={TriangleAlert} label="Closures" value={String(overview.closures)} hint="Visible road closures" />
      <MetricCard icon={RouteIcon} label="Slowest route" value={overview.slowestRoute?.ratioVsTypical != null ? `${overview.slowestRoute.ratioVsTypical.toFixed(2)}×` : "—"} hint={overview.slowestRoute?.name ?? "No sample"} />
    </section>
    <section className={mapExpanded ? "fixed inset-0 z-[80] flex flex-col bg-[#18201e] p-2 sm:p-3" : ""} role={mapExpanded ? "dialog" : undefined} aria-modal={mapExpanded || undefined} aria-label={mapExpanded ? "Bali traffic map workspace" : undefined} data-testid={mapExpanded ? "map-workspace" : undefined}>
      <header className={mapExpanded ? "mb-2 flex min-h-14 shrink-0 items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#222b28] px-3 text-white shadow-2xl sm:px-4" : "hidden"}>
        <div className="flex min-w-0 items-center gap-3">
          <Image
            src="/brand/bukit-vista-logo.png"
            alt="bukitVISTA"
            width={2048}
            height={1260}
            priority
            className="h-10 w-auto shrink-0 rounded-lg bg-white px-2 py-1"
          />
          <div className="min-w-0"><h2 className="truncate text-sm font-bold">Bali traffic explorer</h2><p className="truncate text-[10px] font-semibold text-[#a9bbb4]">Measured traffic · {formatWita(data.meta.slotUtc)} WITA</p></div>
        </div>
        <div className="hidden items-center gap-5 md:flex">
          <WorkspaceStat label="Status" value={data.meta.status} />
          <WorkspaceStat label="Coverage" value={percent(data.meta.coverage)} />
          <WorkspaceStat label="Segments" value={(data.trafficTiles?.featureCount ?? data.flow.features.length).toLocaleString()} />
        </div>
        <button ref={closeWorkspaceRef} type="button" className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-3 text-xs font-bold transition hover:bg-white/15" onClick={() => setMapExpanded(false)} aria-label="Exit map workspace"><Minimize2 size={16} /><span className="hidden sm:inline">Exit full screen</span></button>
      </header>
      <div className={mapExpanded ? "grid min-h-0 flex-1 grid-rows-[minmax(280px,1fr)_minmax(180px,38vh)] gap-2 lg:grid-cols-[minmax(0,1fr)_330px] lg:grid-rows-1" : "grid items-stretch gap-5 2xl:grid-cols-[minmax(0,1fr)_310px]"}>
        <div className={mapExpanded ? "relative min-h-0" : "relative h-full min-h-[560px]"}>
          <BaliMobilityMap key={mode === "latest" && data.trafficTiles ? "traffic-tiles" : "traffic-geojson"} active={active} data={liveMapData} metric="presence" layers={layers} minMobilityScore={100} minTrafficConfidence={minConfidence} selection={selection} onSelect={setSelection} config={config} flowIdentity={flowIdentity} trafficTiles={mode === "latest" ? data.trafficTiles : null} onViewportChange={(nextBbox, zoom) => { setBbox(nextBbox); setPlacesBbox(nextBbox); setPlacesZoom(zoom); }} onBasemapError={setBasemapWarning} onDisplayGridRendered={() => { const applied = displayGridPendingRenderRef.current; if (applied) setDisplayGridApplied(applied); displayGridPendingRenderRef.current = null; setDisplayGridLoading(false); }} expanded={mapExpanded} />
          {displayGridLoading && layers.placesHeatmap ? <DisplayGridLoadingOverlay /> : null}
          {!mapExpanded ? <button ref={openWorkspaceRef} type="button" onClick={() => setMapExpanded(true)} className="absolute right-3 top-[76px] z-20 grid h-9 w-9 place-items-center rounded-lg border border-[#cbd5d0] bg-white/95 text-[#29483f] shadow-lg backdrop-blur transition hover:bg-white" aria-label="Open map workspace" title="Open full-screen traffic explorer"><Maximize2 size={17} /></button> : null}
        </div>
        <aside className={mapExpanded ? "min-h-0 space-y-3 overflow-y-auto rounded-xl bg-[#eef1ef] p-2 lg:p-3" : "space-y-4"} aria-label={mapExpanded ? "Traffic explorer controls" : undefined}>
          {mapExpanded ? <div className="px-2 pb-1 pt-2"><p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-[#6f7f79]">Map configuration</p><p className="mt-1 text-xs font-semibold text-[#344b43]">Change visible overlays without reloading the map.</p></div> : null}
          {layerPanel}
          {sourcePanel}
          {routesPanel}
        </aside>
      </div>
    </section>
  </div>;
}

type RouteSort = "destination" | "current" | "delay" | "ratio";
type HistoryRange = "latest" | "12h";

function latestRouteHistoryPoint(route: RouteSummary): RouteHistoryPoint {
  return {
    collectionSlotUtc: route.collectionSlotUtc ?? new Date().toISOString(),
    sampledAtUtc: route.sampledAtUtc ?? null,
    currentDurationSeconds: route.currentDurationSeconds ?? null,
    typicalDurationSeconds: route.typicalDurationSeconds ?? null,
    baseDurationSeconds: route.baseDurationSeconds ?? null,
    delayVsTypicalSeconds: route.delayVsTypicalSeconds ?? null,
    delayVsBaseSeconds: route.delayVsBaseSeconds ?? null,
    ratioVsTypical: route.ratioVsTypical ?? null,
    ratioVsBase: route.ratioVsBase ?? null
  };
}

function routeHistoryWithGaps(points: RouteHistoryPoint[], window: { startUtc: string; endExclusiveUtc: string }) {
  const bySlot = new globalThis.Map(points.map((point) => [point.collectionSlotUtc, point]));
  const result: RouteHistoryPoint[] = [];
  for (let time = new Date(window.startUtc).getTime(); time < new Date(window.endExclusiveUtc).getTime(); time += 3_600_000) {
    const slot = new Date(time).toISOString();
    result.push(bySlot.get(slot) ?? {
      collectionSlotUtc: slot, sampledAtUtc: null, currentDurationSeconds: null,
      typicalDurationSeconds: null, baseDurationSeconds: null, delayVsTypicalSeconds: null,
      delayVsBaseSeconds: null, ratioVsTypical: null, ratioVsBase: null
    });
  }
  return result;
}

function RoutesView({ routes, selected, setSelectedRouteId, at, config }: { routes: RouteSummary[]; selected: RouteSummary | null; setSelectedRouteId: (id: number) => void; at: string; config: BasemapConfig }) {
  const [routeSort, setRouteSort] = useState<RouteSort>("destination");
  const [historyRange, setHistoryRange] = useState<HistoryRange>("12h");
  const geometryKey = selected ? `${selected.id}|${at}|${selected.collectionSlotUtc ?? "no-slot"}` : "no-route";
  const historyKey = selected ? `${selected.id}|history|${historyRange}|${selected.collectionSlotUtc ?? "no-slot"}` : "no-history";
  const [history, setHistory] = useState<RouteHistoryPoint[]>([]);
  const [historyCoverage, setHistoryCoverage] = useState<HistoryCoverage | null>(null);
  const [geometry, setGeometry] = useState<RouteGeometry | null>(null);
  const [loadedRouteDetailKey, setLoadedRouteDetailKey] = useState(geometryKey);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [geometryLoading, setGeometryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [geometryError, setGeometryError] = useState<string | null>(null);
  const corridors = useMemo(() => {
    const grouped = groupAirportTourismCorridors(routes);
    const value = (corridor: (typeof grouped)[number]) => {
      const directions = [corridor.directions.fromAirport, corridor.directions.toAirport];
      if (routeSort === "current") return Math.max(...directions.map((route) => route?.currentDurationSeconds ?? -Infinity));
      if (routeSort === "delay") return Math.max(...directions.map((route) => route?.delayVsTypicalSeconds ?? -Infinity));
      if (routeSort === "ratio") return Math.max(...directions.map((route) => route?.ratioVsTypical ?? -Infinity));
      return 0;
    };
    return [...grouped].sort((left, right) => routeSort === "destination"
      ? centerLabel(left.tourismCenterKey).localeCompare(centerLabel(right.tourismCenterKey))
      : value(right) - value(left));
  }, [routeSort, routes]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const cacheKey = historyKey;
    const cached = getCachedRouteDetail(cacheKey);
    const needsHistory = cached?.history === undefined;
    setHistory(cached?.history ?? []);
    setHistoryCoverage(cached?.historyCoverage ?? null);
    setHistoryLoading(needsHistory);
    setHistoryError(null);
    if (needsHistory) {
      if (historyRange === "latest") {
        const latest = [latestRouteHistoryPoint(selected)];
        const coverage = { expectedSlots: 1, presentSlots: selected.collectionSlotUtc ? 1 : 0, coverage: selected.collectionSlotUtc ? 1 : 0, missingSlotsUtc: selected.collectionSlotUtc ? [] : ["latest"] };
        cacheRouteDetail(cacheKey, { history: latest, historyCoverage: coverage });
        setHistory(latest);
        setHistoryCoverage(coverage);
        setHistoryLoading(false);
        return () => controller.abort();
      }
      void fetch(`/api/v1/routes/${selected.id}/history?hours=12`, { signal: controller.signal })
        .then((response) => json<{ data: { points: RouteHistoryPoint[]; window: { startUtc: string; endExclusiveUtc: string }; coverage: HistoryCoverage } }>(response))
        .then((result) => {
          if (controller.signal.aborted) return;
          const historyWithGaps = routeHistoryWithGaps(result.data.points, result.data.window);
          cacheRouteDetail(cacheKey, { history: historyWithGaps, historyCoverage: result.data.coverage });
          setHistory(historyWithGaps);
          setHistoryCoverage(result.data.coverage);
        })
        .catch(() => {
          if (!controller.signal.aborted) setHistoryError("Route history is temporarily unavailable.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setHistoryLoading(false);
        });
    }
    return () => controller.abort();
  }, [historyKey, historyRange, selected]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const cacheKey = geometryKey;
    const cached = getCachedRouteDetail(cacheKey);
    const needsGeometry = cached?.geometry === undefined;
    setGeometry(cached?.geometry ?? null);
    setLoadedRouteDetailKey(cacheKey);
    setGeometryLoading(needsGeometry);
    setGeometryError(null);
    if (needsGeometry) {
      const geometryAt = selected.collectionSlotUtc ?? at;
      void fetchJsonWithTimeoutRetry<RouteGeometry>(
        `/api/v1/routes/${selected.id}/geometry?at=${encodeURIComponent(geometryAt)}`,
        { signal: controller.signal, timeoutMs: 5_000, maxAttempts: 3 }
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          const nextGeometry: RouteGeometry = { type: "FeatureCollection", features: result.features };
          cacheRouteDetail(cacheKey, { geometry: nextGeometry });
          setGeometry(nextGeometry);
        })
        .catch(() => {
          if (!controller.signal.aborted) setGeometryError("Actual route geometry is unavailable for this exact time slot.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setGeometryLoading(false);
        });
    }
    return () => controller.abort();
  }, [at, geometryKey, selected]);

  const switchingRoute = loadedRouteDetailKey !== geometryKey;

  if (!routes.length) return <EmptyState title="Route data unavailable" body="No active route samples are available. Fixtures are disabled." />;
  return <div className="space-y-5">
    <Panel title="Airport corridor conditions" icon={RouteIcon} flush><div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e9e6] px-4 py-3"><p className="text-xs text-[#687872]">14 independent directions in seven airport corridors</p><label className="flex items-center gap-2 text-xs font-semibold">Sort by<select value={routeSort} onChange={(event) => setRouteSort(event.target.value as RouteSort)} className="rounded-lg border border-[#ccd7d1] bg-white px-3 py-2"><option value="destination">Destination</option><option value="current">Current duration</option><option value="delay">Delay</option><option value="ratio">Congestion ratio</option></select></label></div><CorridorTable corridors={corridors} selectedRouteId={selected?.id ?? 0} setSelectedRouteId={setSelectedRouteId} /><div className="border-t border-[#e5e9e6] bg-[#fff8e8] px-4 py-3 text-xs font-semibold leading-relaxed text-[#7e622c]">{AIRPORT_CORRIDOR_DISCLAIMER}</div></Panel>
    {selected ? <section className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(420px,.9fr)]">
      <Panel title={`${selected.name} · actual route geometry`} icon={Map} flush>{switchingRoute || geometryLoading ? <RouteGeometrySkeleton /> : geometry ? <RouteGeometryMap data={geometry} config={config} ratioVsTypical={selected.ratioVsTypical ?? null} /> : <div className="grid h-72 place-items-center px-6 text-center text-sm text-[#73817c]">{geometryError ?? "Actual route geometry is unavailable."}</div>}</Panel>
      <Panel title="Measured route history" icon={Activity}><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div className="flex gap-2" role="group" aria-label="Route history range">{(["latest", "12h"] as HistoryRange[]).map((range) => <button key={range} onClick={() => setHistoryRange(range)} className={`rounded-lg px-3 py-1.5 text-xs font-bold ${historyRange === range ? "bg-[#285c4e] text-white" : "bg-[#edf2ef] text-[#52645d]"}`}>{range === "latest" ? "Latest" : "12 hours"}</button>)}</div>{historyCoverage ? <span className={`rounded-lg px-2.5 py-1.5 text-[10px] font-bold ${historyCoverage.coverage === 1 ? "bg-[#e2f2e9] text-[#277151]" : "bg-[#fff1d2] text-[#9b6812]"}`}>{historyCoverage.presentSlots}/{historyCoverage.expectedSlots} measurements</span> : null}</div>{historyCoverage?.missingSlotsUtc.length ? <p className="mb-3 text-xs font-semibold text-[#9b6812]">Missing hourly slots are shown as gaps, never as zero.</p> : null}{historyLoading ? <RouteHistorySkeleton /> : history.some((point) => point.currentDurationSeconds != null) ? <HistoryChart points={history} /> : <div className="grid h-64 place-items-center text-sm text-[#73817c]">{historyError ?? "No persisted route history in this range."}</div>}</Panel>
    </section> : null}
  </div>;
}

function RouteHistorySkeleton() {
  return <div className="relative h-64 overflow-hidden" role="status" aria-label="Loading route history">
    <div className="absolute inset-0 motion-safe:animate-pulse">
      {[16, 42, 68, 94].map((top) => <div key={top} className="absolute left-0 right-0 h-px bg-[#e5eae7]" style={{ top: `${top}%` }} />)}
      <svg viewBox="0 0 640 240" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <path d="M0 115 C70 88 116 150 180 128 S286 61 350 101 S452 177 520 121 S598 79 640 95" fill="none" stroke="#cbd5d0" strokeWidth="5" strokeLinecap="round" />
        <path d="M0 128 C70 100 120 160 184 136 S287 75 352 113 S449 186 520 135 S598 91 640 108" fill="none" stroke="#dce3df" strokeWidth="5" strokeLinecap="round" />
      </svg>
    </div>
    <span className="sr-only">Preparing cached route history…</span>
  </div>;
}

function centerLabel(key: string) {
  return key.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function CorridorTable({ corridors, selectedRouteId, setSelectedRouteId }: { corridors: ReturnType<typeof groupAirportTourismCorridors>; selectedRouteId: number; setSelectedRouteId: (id: number) => void }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[1140px] text-left text-xs"><thead className="bg-[#f4f6f4] text-[10px] uppercase tracking-[.1em] text-[#7d8b86]"><tr><th className="px-4 py-3">Tourism center</th><th className="px-4 py-3">Direction</th><th className="px-4 py-3">Current</th><th className="px-4 py-3">Typical</th><th className="px-4 py-3">Base</th><th className="px-4 py-3">Delay vs typical</th><th className="px-4 py-3">Ratio</th><th className="px-4 py-3">Slot WITA</th><th className="px-4 py-3">Age</th><th className="px-4 py-3">Status</th></tr></thead><tbody>{corridors.flatMap((corridor) => ([
    { label: "From DPS Airport", route: corridor.directions.fromAirport },
    { label: "To DPS Airport", route: corridor.directions.toAirport }
  ] as const).map(({ label, route }, index) => {
    const condition = routeConditionStyle(route?.ratioVsTypical);
    const selectable = Boolean(route && route.status !== "missing");
    return <tr key={`${corridor.routeGroupKey}-${label}`} onClick={() => { if (selectable && route) setSelectedRouteId(route.id); }} className={`border-t border-[#edf0ed] ${selectable ? "cursor-pointer hover:bg-[#f8faf8]" : "bg-[#fafbfa] text-[#8a9691]"} ${route?.id === selectedRouteId ? "bg-[#edf5f1]" : ""}`}>
      {index === 0 ? <td rowSpan={2} className="border-r border-[#edf0ed] px-4 py-3 align-top"><p className="font-bold">{centerLabel(corridor.tourismCenterKey)}</p><p className="mt-1 text-[10px] font-semibold text-[#7c8984]">{corridor.routeGroupKey}</p></td> : null}
      <td className="px-4 py-3"><p className="font-bold">{label}</p><p className="mt-0.5 text-[10px] text-[#7c8984]">{route ? `${route.name} · ${route.distanceMeters == null ? "—" : `${(route.distanceMeters / 1000).toFixed(1)} km`}` : "Direction not configured"}</p></td>
      <td className="px-4 py-3 font-bold">{formatDuration(route?.currentDurationSeconds)}</td><td className="px-4 py-3">{formatDuration(route?.typicalDurationSeconds)}</td><td className="px-4 py-3">{formatDuration(route?.baseDurationSeconds)}</td><td className={`px-4 py-3 ${Number(route?.delayVsTypicalSeconds) < 0 ? "text-[#2f7457]" : "text-[#ad4a43]"}`}>{delayLabel(route?.delayVsTypicalSeconds)}</td><td className="px-4 py-3 font-bold" style={{ color: condition.color }}>{route?.ratioVsTypical == null ? "—" : `${route.ratioVsTypical.toFixed(2)}×`}</td><td className="whitespace-nowrap px-4 py-3">{formatWita(route?.collectionSlotUtc, true)}</td><td className="whitespace-nowrap px-4 py-3">{ageLabel(route?.collectionSlotUtc)}</td><td className="px-4 py-3"><span className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase ${statusTone(route?.status ?? "missing")}`}>{route?.status ?? "missing"}</span></td>
    </tr>;
  }))}</tbody></table></div>;
}

function HistoryChart({ points }: { points: RouteHistoryPoint[] }) {
  const width = 720, height = 180, pad = 24;
  const durationKeys = ["currentDurationSeconds", "typicalDurationSeconds", "baseDurationSeconds"] as const;
  const durationValues = points.flatMap((point) => durationKeys.map((key) => point[key])).filter((value): value is number => value != null);
  const durationMin = durationValues.length ? Math.min(...durationValues) * .9 : 0;
  const durationMax = durationValues.length ? Math.max(...durationValues) * 1.08 : 1;
  const coordinates = (values: Array<number | null>, min: number, max: number) => values.map((value, index) => value == null ? null : {
    x: points.length === 1 ? width / 2 : pad + index * (width - pad * 2) / (points.length - 1),
    y: height - pad - (value - min) / Math.max(.01, max - min) * (height - pad * 2)
  });
  const segmentedPaths = (values: Array<number | null>, min: number, max: number) => {
    const segments: string[] = [];
    let segment = "";
    for (const coordinate of coordinates(values, min, max)) {
      if (!coordinate) {
        if (segment) segments.push(segment);
        segment = "";
      } else {
        segment += `${segment ? " L" : "M"}${coordinate.x.toFixed(1)},${coordinate.y.toFixed(1)}`;
      }
    }
    if (segment) segments.push(segment);
    return segments;
  };
  const delayValues = points.map((point) => point.delayVsTypicalSeconds).filter((value): value is number => value != null);
  const ratioValues = points.map((point) => point.ratioVsTypical).filter((value): value is number => value != null);
  const pressureMin = Math.min(0, ...delayValues.map((value) => value / 60), ...ratioValues);
  const pressureMax = Math.max(1, ...delayValues.map((value) => value / 60), ...ratioValues);
  const grid = [0, 1, 2, 3].map((line) => <line key={line} x1={pad} x2={width - pad} y1={pad + line * (height - pad * 2) / 3} y2={pad + line * (height - pad * 2) / 3} stroke="#e4e9e5" />);
  const series = (values: Array<number | null>, min: number, max: number, color: string, strokeWidth: number) => <>{segmentedPaths(values, min, max).map((path, index) => <path key={`${color}-${index}`} d={path} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />)}{coordinates(values, min, max).map((point, index) => point ? <circle key={`${color}-point-${index}`} cx={point.x} cy={point.y} r="2.4" fill={color} /> : null)}</>;
  return <div className="space-y-4"><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#71817b]">Duration trends</p><svg viewBox={`0 0 ${width} ${height}`} className="h-48 w-full" aria-label="Current, typical and base route duration history">{grid}{series(points.map((point) => point.baseDurationSeconds), durationMin, durationMax, "#a68852", 2)}{series(points.map((point) => point.typicalDurationSeconds), durationMin, durationMax, "#70958a", 2.5)}{series(points.map((point) => point.currentDurationSeconds), durationMin, durationMax, "#cf594f", 3)}</svg><div className="flex justify-center gap-4 text-[10px]"><b className="text-[#cf594f]">Current</b><b className="text-[#70958a]">Typical</b><b className="text-[#a68852]">Base</b></div></div><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#71817b]">Delay minutes and ratio</p><svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full" aria-label="Delay and congestion ratio history">{grid}{series(points.map((point) => point.delayVsTypicalSeconds == null ? null : point.delayVsTypicalSeconds / 60), pressureMin, pressureMax, "#cf594f", 2.5)}{series(points.map((point) => point.ratioVsTypical), pressureMin, pressureMax, "#315f9f", 2.5)}</svg><div className="flex justify-between text-[10px] text-[#7d8b86]"><span>{formatWita(points[0]?.collectionSlotUtc, true)}</span><span className="flex gap-4"><b className="text-[#cf594f]">Delay min</b><b className="text-[#315f9f]">Ratio</b></span><span>{formatWita(points.at(-1)?.collectionSlotUtc, true)}</span></div></div></div>;
}

function HealthView({ flowRuns, routeRuns, windowStatus }: { flowRuns: CollectionRun[]; routeRuns: CollectionRun[]; windowStatus: MvpWindowStatus | null }) {
  const runs = [flowRuns[0], routeRuns[0]].filter((run): run is CollectionRun => Boolean(run)).sort((a, b) => b.slotUtc.localeCompare(a.slotUtc));
  const failures = runs.filter((run) => run.status === "failed").length;
  return <div className="space-y-5"><section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard icon={Database} label="Latest traffic coverage" value={percent(flowRuns[0]?.coverage)} hint={`${flowRuns[0]?.successCount ?? 0}/${flowRuns[0]?.expectedCount ?? 0} collection areas`} /><MetricCard icon={RouteIcon} label="Latest route coverage" value={percent(routeRuns[0]?.coverage)} hint={`${routeRuns[0]?.successCount ?? 0}/${routeRuns[0]?.expectedCount ?? 0} active routes`} /><MetricCard icon={RefreshCw} label="Update retries" value={String((flowRuns[0]?.retryCount ?? 0) + (routeRuns[0]?.retryCount ?? 0))} hint="Latest traffic and route updates" /><MetricCard icon={TriangleAlert} label="Critical updates" value={String(failures + runs.filter((run) => run.isStuck).length)} hint="Failed or stuck updates" /></section>{windowStatus ? <Panel title="Rolling 12-hour window" icon={Clock3}><div className="grid gap-4 text-xs sm:grid-cols-2 xl:grid-cols-4"><Pair label="Window status" value={windowStatus.status} /><Pair label="Traffic slots" value={`${windowStatus.flow.passedSlots}/${windowStatus.flow.expectedSlots}`} /><Pair label="Route slots" value={`${windowStatus.routes.passedSlots}/${windowStatus.routes.expectedSlots}`} /><Pair label="Route samples" value={`${windowStatus.routes.presentSamples}/${windowStatus.routes.expectedSamples}`} /><Pair label="Route geometries" value={`${windowStatus.routes.presentGeometries}/${windowStatus.routes.expectedGeometries}`} /><Pair label="Window start" value={`${formatWita(windowStatus.startUtc)} WITA`} /><Pair label="Window end" value={`${formatWita(windowStatus.endExclusiveUtc)} WITA`} /></div>{windowStatus.status === "partial" ? <p className="mt-4 rounded-lg bg-[#fff1d2] px-3 py-2 text-xs font-semibold text-[#8b611c]">This is the current window. Missing slots are reported explicitly; an older complete window is not substituted.</p> : null}</Panel> : null}<Panel title="Current update status" icon={HeartPulse} flush><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-[#f4f6f4] text-[10px] uppercase tracking-[.1em] text-[#7d8b86]"><tr><th className="px-4 py-3">Slot WITA</th><th className="px-4 py-3">Age</th><th className="px-4 py-3">Data type</th><th className="px-4 py-3">Health</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Coverage</th><th className="px-4 py-3">Retries</th><th className="px-4 py-3">Duration</th><th className="px-4 py-3">Records</th></tr></thead><tbody>{runs.map((run) => <tr key={`${run.source}-${run.id}`} className="border-t border-[#edf0ed]"><td className="whitespace-nowrap px-4 py-3 font-semibold">{formatWita(run.slotUtc)}</td><td className="px-4 py-3">{run.slotAgeMinutes == null ? "—" : `${Math.round(run.slotAgeMinutes)} min`}</td><td className="px-4 py-3">{run.source}</td><td className="px-4 py-3 font-semibold capitalize" title={run.alertCode}>{run.healthState ?? "unknown"}{run.isStuck ? " · stuck" : ""}</td><td className="px-4 py-3"><span className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase ${statusTone(run.status)}`}>{run.status}</span></td><td className="px-4 py-3">{percent(run.coverage)}</td><td className="px-4 py-3">{run.retryCount ?? "—"}</td><td className="px-4 py-3">{run.durationSeconds == null ? "—" : `${run.durationSeconds.toFixed(1)}s`}</td><td className="px-4 py-3">{run.recordCount.toLocaleString()}</td></tr>)}</tbody></table></div><div className="border-t bg-[#f8faf8] px-4 py-3 text-[11px] text-[#66766f]">Detailed diagnostics are restricted.</div></Panel></div>;
}

function MetricCard({ icon: IconComponent, label, value, hint }: { icon: Icon; label: string; value: string; hint: string }) {
  return <article className="rounded-2xl border border-[#dbe2dd] bg-white p-4 shadow-sm"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#e3f0e8] text-[#36745b]"><IconComponent size={17} /></span><p className="mt-4 text-[10px] font-bold uppercase tracking-[.12em] text-[#83908b]">{label}</p><p className="mt-1 truncate text-2xl font-bold tracking-[-.035em]">{value}</p><p className="mt-1 truncate text-[10px] text-[#778680]">{hint}</p></article>;
}

function Panel({ title, icon: IconComponent, children, flush = false }: { title: string; icon: Icon; children: React.ReactNode; flush?: boolean }) {
  return <section className="overflow-hidden rounded-2xl border border-[#dbe2dd] bg-white shadow-sm"><header className="flex items-center gap-2 border-b border-[#e5e9e6] px-4 py-3"><IconComponent size={16} className="text-[#557268]" /><h2 className="text-sm font-bold">{title}</h2></header><div className={flush ? "" : "p-4"}>{children}</div></section>;
}

function Pair({ label, value }: { label: string; value: string }) { return <div className="flex items-center justify-between gap-3"><dt className="text-[#7a8883]">{label}</dt><dd className="text-right font-bold capitalize text-[#2c3e38]">{value}</dd></div>; }

function WorkspaceStat({ label, value }: { label: string; value: string }) {
  return <div className="text-right"><p className="text-[9px] font-bold uppercase tracking-[.13em] text-[#8fa39b]">{label}</p><p className="mt-0.5 text-xs font-bold capitalize text-white">{value}</p></div>;
}

function LayerToggle({ checked, label, color, tooltip, onChange }: { checked: boolean; label: string; color: string; tooltip?: string; onChange: () => void }) {
  const tooltipId = `layer-tooltip-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return <div className="flex items-center gap-2"><button type="button" role="switch" aria-checked={checked} onClick={onChange} className="flex min-w-0 flex-1 items-center gap-3 text-left text-xs font-semibold"><span className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-[#3d7667]" : "bg-[#cfd7d2]"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${checked ? "left-[18px]" : "left-0.5"}`} /></span><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} /><span className="min-w-0 flex-1">{label}</span></button>{tooltip ? <span className="group relative shrink-0"><button type="button" aria-label={`About ${label}`} aria-describedby={tooltipId} className="grid h-6 w-6 place-items-center rounded-full text-[#71817b] hover:bg-[#edf3f0] hover:text-[#315f53]"><Info size={14} /></button><span id={tooltipId} role="tooltip" className="pointer-events-none invisible absolute right-0 top-8 z-20 w-56 rounded-lg bg-[#203c35] px-3 py-2 text-[10px] font-medium leading-relaxed text-white opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">{tooltip}</span></span> : null}</div>;
}

function RouteWatch({ route }: { route: RouteSummary }) {
  const ratio = route.ratioVsTypical;
  const condition = routeConditionStyle(ratio);
  const progress = ratio == null ? 0 : Math.min(100, Math.max(4, (ratio - .8) * 90));
  const lineHeight = Math.min(8, Math.max(4, condition.width - 1));
  return <div title={condition.label}><div className="flex items-center justify-between gap-3"><span className="truncate text-xs font-bold">{route.name}</span><span className="text-xs font-bold" style={{ color: condition.color }}>{ratio == null ? "—" : `${ratio.toFixed(2)}×`}</span></div><div className="mt-1.5 overflow-hidden rounded-full bg-[#edf0ed]" style={{ height: `${lineHeight}px` }}><div className="h-full rounded-full transition-[width,background-color] duration-300" style={{ width: `${progress}%`, backgroundColor: condition.color }} /></div></div>;
}

function EmptyState({ title, body }: { title: string; body: string }) { return <div className="grid min-h-96 place-items-center rounded-2xl border border-dashed border-[#ccd7d1] bg-white p-10 text-center"><div><Database className="mx-auto text-[#80918b]" /><h2 className="mt-3 font-bold">{title}</h2><p className="mt-1 text-sm text-[#74827d]">{body}</p></div></div>; }
