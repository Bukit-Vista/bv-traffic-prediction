export type TrafficSource = "live" | "historical";

export type Route = {
  id: number;
  slug: string;
  originLabel: string;
  originLat: number;
  originLng: number;
  destinationLabel: string;
  destinationLat: number;
  destinationLng: number;
  category: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RouteSample = {
  id: number;
  routeId: number;
  ingestionRunId: number | null;
  sampleHour: string;
  sampledAt: string;
  provider: string;
  apiProduct: string;
  trafficSource: TrafficSource;
  distanceMeters: number;
  durationSeconds: number;
  trafficDurationSeconds: number;
  trafficDelaySeconds: number;
  congestionScore: number;
  httpStatus: number | null;
  trackingId: string | null;
  rawSummaryJson: unknown;
};

export type IngestionRun = {
  id: number;
  source: string;
  sampleHour: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "failed";
  routeExpectedCount: number;
  routeSuccessCount: number;
  routeFailureCount: number;
  incidentSuccess: boolean;
  flowTileExpectedCount: number;
  flowTileSuccessCount: number;
  errorJson: unknown;
};

export type TrafficIncident = {
  id: number;
  snapshotId: number;
  providerIncidentId: string | null;
  iconCategory: string | null;
  magnitudeOfDelay: string | null;
  startTime: string | null;
  endTime: string | null;
  fromLabel: string | null;
  toLabel: string | null;
  lengthMeters: number | null;
  delaySeconds: number | null;
  geometryGeoJson: unknown;
  rawIncidentJson: unknown;
};
