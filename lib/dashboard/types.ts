export type Position = [number, number];

export type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiLineString"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };

export type BaliBoundaryProperties = Record<string, unknown> & {
  boundaryKey: "bali-province";
  name: string;
  source: "OpenStreetMap" | "GADM 4.0";
  osmRelationId: 1615621;
  osmVersion: number | null;
  osmTimestamp: string | null;
  osmRelationUrl: string;
  sourceUrl: string;
  license: "ODbL-1.0" | "GADM data licence";
  attribution: string;
  importedAt: string;
  bbox: [number, number, number, number];
  geometrySource?: string;
  geometrySourceUrl?: string;
  relationBoundaryKind?: "maritime-administrative";
};

export type RegencyBoundaryProperties = Record<string, unknown> & {
  zoneId: number;
  zoneKey: string;
  name: string;
  regencyName: string;
  center: Position;
  sourceId: string | number | null;
};

export type BasemapConfig = {
  tileUrl: string;
  attribution: string;
  minZoom: number;
  maxZoom: number;
  deploymentMode: "demo-internal" | "managed";
  boundaryUrl: string;
  regencyBoundaryUrl: string;
};

export type GeoJsonFeature<P extends Record<string, unknown> = Record<string, unknown>> = {
  type: "Feature";
  id?: string | number;
  geometry: Geometry;
  properties: P;
};

export type FeatureCollection<P extends Record<string, unknown> = Record<string, unknown>> = {
  type: "FeatureCollection";
  features: Array<GeoJsonFeature<P>>;
};

export type ApiMeta = {
  requestId: string;
  generatedAt: string;
  requestedAtUtc?: string;
  /** @deprecated Use slotUtc. Retained for one compatibility release. */
  selectedSlot: string | null;
  slotUtc?: string | null;
  collectionSlotUtc?: string | null;
  requestedSlotUtc?: string | null;
  actualSlotUtc?: string | null;
  fallbackSlotUtc?: string | null;
  windowStartUtc?: string | null;
  windowEndExclusiveUtc?: string | null;
  windowHours?: number | null;
  source: string;
  sourceRunId?: string | null;
  modelRunId?: string | null;
  modelVersion?: string | null;
  freshnessSeconds: number | null;
  status: "running" | "success" | "complete" | "failed" | "fresh" | "stale" | "critical" | "partial" | "unavailable";
  stale?: boolean;
  isStale?: boolean;
  isFallback?: boolean;
  freshnessState?: "fresh" | "stale" | "critically_stale" | "unknown";
  coverage?: number | null;
  confidence?: number | null;
  semantics?: "measured_traffic" | "measured_route_condition" | "predicted_relative_mobility" | "source_activity_centers" | "source_derived_places_heatmap" | null;
  truncated?: boolean;
  featureCount?: number;
  disclaimer?: string;
  fallbackReason?: string | null;
  placeImportRunId?: number | null;
  importVersion?: string | null;
  categoryMappingVersion?: string | null;
  zoneVersion?: string | null;
  lastImportedAtUtc?: string | null;
  saturatedTaskCount?: number | null;
  failedTaskCount?: number | null;
  displayGridBuildId?: number | null;
  gridVersion?: string | null;
  sourceImportRunId?: number | null;
  sourceCompletedAtUtc?: string | null;
  builtAtUtc?: string | null;
  sourceSaturatedTaskCount?: number | null;
  routePurpose?: string | null;
  routeGroupKey?: string | null;
  tourismCenterKey?: string | null;
  routeDirection?: "from_airport" | "to_airport" | "other" | null;
};

export type FlowProperties = Record<string, unknown> & {
  segmentId: number;
  segmentKey: string;
  provider?: string;
  providerReference?: string | null;
  referenceType?: string;
  observationId?: number;
  roadName: string;
  functionalClass: number | null;
  lengthMeters?: number | null;
  collectionSlotUtc?: string;
  sourceUpdatedUtc?: string | null;
  fetchedAtUtc?: string;
  /** @deprecated Collection slot is the analytical identity. */
  observedAt?: string;
  speedKph: number | null;
  speedUncappedKph?: number | null;
  freeFlowKph: number | null;
  relativeSpeed: number | null;
  jamFactor: number | null;
  jamTendency: number | null;
  confidence: number | null;
  traversability: string | null;
  roadClosure: boolean;
  slotAgeMinutes?: number | null;
};

export type IncidentProperties = Record<string, unknown> & {
  incidentId: number;
  category: string;
  severity: string;
  description: string;
  startTime: string;
  endTime: string | null;
  roadClosure: boolean;
  lengthMeters: number | null;
  sourceTimestamp: string;
};

export type MobilityZoneProperties = Record<string, unknown> & {
  zoneId: number;
  zoneKey: string;
  name: string;
  regencyName: string | null;
  zoneVersion?: string;
  timeBucketUtc: string;
  timeBucketLocal: string;
  presenceScore: number;
  inboundScore: number;
  outboundScore: number;
  attractionScore: number;
  hotspotRank: number | null;
  confidence: number;
  featureCoverage?: number | null;
  meanJamFactor: number | null;
  meanSpeedKph: number | null;
  modelVersion: string;
  runStatus: "success" | "partial";
  isStale: boolean;
};

export type MobilityFlowProperties = Record<string, unknown> & {
  originZoneId: number;
  originZoneKey?: string;
  originCatchmentKey?: string;
  destinationZoneId: number;
  destinationZoneKey?: string;
  destinationCatchmentKey?: string;
  originName: string;
  destinationName: string;
  mobilityScore: number;
  predictedShare: number;
  travelTimeSeconds: number | null;
  durationSeconds?: number | null;
  distanceMeters?: number | null;
  confidence: number;
  modelVersion: string;
  predictionForUtc?: string;
  semantics?: "predicted_relative_mobility";
  disclaimer?: string;
  pathSemantics?: "cached_here_road_path" | "zone_centroid_fallback" | "traffic_network_guided";
  routeWeightedJamFactor?: number | null;
  routeGeometryUpdatedAtUtc?: string | null;
  metricSemantics: "relative_prediction_not_people_count";
  flowVisualMode?: "general_od";
};

export type CenterProperties = Record<string, unknown> & {
  centerId: number;
  zoneId: number;
  zoneKey?: string;
  name: string;
  category: string;
  attractionScore: number;
  centerCount?: number;
  source: string;
};

export type DisplayGridProperties = Record<string, unknown> & {
  cellId: number | string;
  cellKey: string;
  category: string;
  relativeIndex: number;
  attractionIndex: number;
  placeDensityIndex: number;
  activePlaceCount: number;
  modelEligiblePlaceCount: number;
  rawAttractionWeight: number;
  centerLongitude: number;
  centerLatitude: number;
};

export type RouteSummary = {
  id: number;
  slug: string;
  name: string;
  originLabel: string;
  destinationLabel: string;
  category: string;
  routePurpose: "airport_tourism" | "general" | string;
  routeGroupKey: string;
  tourismCenterKey: string;
  routeDirection: "from_airport" | "to_airport" | "other";
  distanceMeters: number | null;
  currentDurationSeconds?: number | null;
  typicalDurationSeconds?: number | null;
  baseDurationSeconds?: number | null;
  delayVsTypicalSeconds?: number | null;
  delayVsBaseSeconds?: number | null;
  ratioVsTypical?: number | null;
  ratioVsBase?: number | null;
  collectionSlotUtc?: string | null;
  sampledAtUtc?: string | null;
  provider?: "here" | string | null;
  /** @deprecated Use typicalDurationSeconds. */
  typicalSeconds: number | null;
  /** @deprecated Use currentDurationSeconds. */
  liveSeconds: number | null;
  /** @deprecated Use delayVsTypicalSeconds. */
  delaySeconds: number | null;
  /** @deprecated Use ratioVsTypical. */
  congestionRatio: number | null;
  /** @deprecated Use collectionSlotUtc. */
  sampleHourUtc: string | null;
  confidence: number | null;
  status: "fresh" | "stale" | "missing";
  geometryAvailable: boolean;
};

export type RouteIdentity = Pick<RouteSummary,
  "id" | "slug" | "name" | "originLabel" | "destinationLabel" | "category" |
  "routePurpose" | "routeGroupKey" | "tourismCenterKey" | "routeDirection"
>;

export type AirportCorridor = {
  routeGroupKey: string;
  tourismCenterKey: string;
  directions: {
    fromAirport: RouteSummary | null;
    toAirport: RouteSummary | null;
  };
};

export type TrafficOverview = {
  weightedJamFactor: number | null;
  congestedRoadShare: number | null;
  closures: number;
  /** @deprecated Incidents are not part of the production overview. */
  activeIncidents?: number;
  slowestRoute: RouteSummary | null;
  measuredLengthMeters: number;
  coverage: number;
};

export type MobilityOverview = {
  activeZones: number;
  topHotspot: string | null;
  medianPresenceScore: number | null;
  inputCoverage: number | null;
  runStatus: "success" | "partial" | "unavailable";
  modelVersion: string | null;
};

export type MobilityPredictionReadiness = {
  workspaceEnabled: true;
  ready: boolean;
  status: "ready" | "blocked";
  checkedAtUtc: string;
  scope: {
    key: string;
    version: string;
    status: string;
    predictionEnabled: boolean;
  };
  latestModelRun: {
    id: string;
    predictionForUtc: string;
    status: "success" | "partial";
    modelVersion: string;
    inputCoverage: number | null;
  } | null;
  counts: {
    activeZones: number;
    activityCenters: number;
    zoneRoadMappings: number;
    zonePredictions: number;
    odPredictions: number;
  };
  missing: Array<
    | "scope_not_approved"
    | "prediction_disabled"
    | "active_model_missing"
    | "successful_model_run_missing"
    | "active_zones_missing"
    | "activity_centers_missing"
    | "zone_road_mappings_missing"
    | "zone_predictions_missing"
    | "od_predictions_missing"
  >;
  disclaimer: string;
};

export type CollectionRun = {
  id: number;
  slotUtc: string;
  status: "running" | "success" | "partial" | "failed";
  source: string;
  expectedCount: number;
  successCount: number;
  failedCount: number;
  recordCount: number;
  durationSeconds: number | null;
  attemptCount?: number;
  retryCount?: number;
  http429Count?: number;
  slotAgeMinutes?: number | null;
  alertCode?: string;
  coverage?: number | null;
  finishedAtUtc?: string | null;
  healthState?: string;
  isRunning?: boolean;
  isStuck?: boolean;
  errorMessage: string | null;
};

export type CollectorState = {
  dataset: "flow" | "routes" | string;
  runId: string;
  collectionSlotUtc: string;
  status: "running" | "success" | "partial" | "failed";
  expectedCount: number;
  successfulCount: number;
  failedCount: number;
  recordCount: number;
  coverageRatio: number | null;
  retryCount: number;
  http429Count: number;
  startedAtUtc: string;
  finishedAtUtc: string | null;
  durationSeconds: number | null;
  slotAgeMinutes: number | null;
  freshnessState: "fresh" | "stale" | "critically_stale" | "unknown";
  healthState: "healthy" | "running" | "warning" | "critical" | string;
  alertCode: string | null;
  isStale: boolean;
  isPartial: boolean;
  isFailed: boolean;
  isRunning: boolean;
  isStuck: boolean;
};

export type FlowSlot = {
  slotUtc: string;
  sourceRunId: string;
  status: "success" | "partial";
  coverage: number | null;
};

export type DashboardResourceVersions = {
  flow: string;
  routes: string;
  flowHealth: string;
  routeHealth: string;
};

export type TrafficTileSnapshot = {
  version: string;
  tileUrlTemplate: string;
  minZoom: number;
  maxZoom: number;
  sourceLayers: {
    lines: "traffic_lines";
    pulsePoints: "traffic_pulse_points";
  };
  slotUtc: string;
  sourceRunId: string;
  featureCount: number;
  pulsePointCount: number;
};

export type RouteHistoryPoint = {
  collectionSlotUtc: string;
  sampledAtUtc: string | null;
  currentDurationSeconds: number | null;
  typicalDurationSeconds: number | null;
  baseDurationSeconds: number | null;
  delayVsTypicalSeconds: number | null;
  delayVsBaseSeconds: number | null;
  ratioVsTypical: number | null;
  ratioVsBase: number | null;
};

export type HistoryCoverage = {
  expectedSlots: number;
  presentSlots: number;
  coverage: number;
  missingSlotsUtc: string[];
};

export type MvpWindowStatus = {
  startUtc: string;
  endExclusiveUtc: string;
  windowHours: number;
  status: "complete" | "partial";
  flow: HistoryCoverage & {
    passedSlots: number;
    partialSlotsUtc: string[];
    failedSlotsUtc: string[];
    stuckSlotsUtc: string[];
  };
  routes: HistoryCoverage & {
    passedSlots: number;
    partialSlotsUtc: string[];
    failedSlotsUtc: string[];
    stuckSlotsUtc: string[];
    expectedRoutesPerSlot: number;
    expectedSamples: number;
    presentSamples: number;
    expectedGeometries: number;
    presentGeometries: number;
    missingGeometrySlotsUtc: string[];
  };
};

export type SourceDashboardData = {
  generatedAt: string;
  versions: DashboardResourceVersions | null;
  flow: FeatureCollection<FlowProperties>;
  trafficOverview: TrafficOverview;
  trafficOverviewByConfidence?: Record<string, TrafficOverview>;
  routes: RouteSummary[];
  slots: FlowSlot[];
  flowRuns: CollectionRun[];
  routeRuns: CollectionRun[];
  sourceStates?: CollectorState[];
  windowStatus?: MvpWindowStatus | null;
  meta: ApiMeta;
  trafficTiles?: TrafficTileSnapshot | null;
};

export type DashboardFixture = {
  generatedAt: string;
  selectedSlot: string;
  slots: string[];
  trafficOverview: TrafficOverview;
  mobilityOverview: MobilityOverview;
  flow: FeatureCollection<FlowProperties>;
  incidents: FeatureCollection<IncidentProperties>;
  zones: FeatureCollection<MobilityZoneProperties>;
  mobilityFlows: FeatureCollection<MobilityFlowProperties>;
  centers: FeatureCollection<CenterProperties>;
  routes: RouteSummary[];
  flowRuns: CollectionRun[];
  hourlyRuns: CollectionRun[];
  meta: ApiMeta;
};
