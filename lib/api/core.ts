import type { ApiMeta } from "@/lib/dashboard/types";

export class ApiUnavailableError extends Error {
  constructor(message: string, readonly lastSuccess: string | null = null) {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

export class ApiNotFoundError extends Error {
  constructor(readonly code: "ROUTE_NOT_FOUND" | "SLOT_NOT_FOUND", message: string, readonly requestedSlotUtc: string | null = null) {
    super(message);
    this.name = "ApiNotFoundError";
  }
}

export class ApiAuthorizationError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "ApiAuthorizationError";
  }
}

export class ApiRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many requests. Retry after the indicated interval.");
    this.name = "ApiRateLimitError";
  }
}

export class FeatureNotReadyError extends Error {
  constructor(readonly feature: string, message?: string) {
    super(message ?? `${feature} is unavailable until its production data gates pass.`);
    this.name = "FeatureNotReadyError";
  }
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now().toString(36)}`;
}

export function makeMeta(input: Partial<ApiMeta> = {}): ApiMeta {
  const requestedAtUtc = input.requestedAtUtc ?? input.generatedAt ?? new Date().toISOString();
  const collectionSlotUtc = input.collectionSlotUtc ?? input.slotUtc ?? input.selectedSlot ?? null;
  const isStale = input.isStale ?? input.stale ?? false;
  return {
    requestId: input.requestId ?? requestId(),
    generatedAt: input.generatedAt ?? requestedAtUtc,
    requestedAtUtc,
    selectedSlot: input.selectedSlot ?? collectionSlotUtc,
    slotUtc: input.slotUtc ?? collectionSlotUtc,
    collectionSlotUtc,
    requestedSlotUtc: input.requestedSlotUtc ?? null,
    actualSlotUtc: input.actualSlotUtc ?? collectionSlotUtc,
    windowStartUtc: input.windowStartUtc ?? null,
    windowEndExclusiveUtc: input.windowEndExclusiveUtc ?? null,
    windowHours: input.windowHours ?? null,
    source: input.source ?? "mysql",
    sourceRunId: input.sourceRunId ?? null,
    modelRunId: input.modelRunId ?? null,
    modelVersion: input.modelVersion ?? null,
    freshnessSeconds: input.freshnessSeconds ?? null,
    status: input.status ?? "fresh",
    stale: isStale,
    isStale,
    isFallback: input.isFallback ?? false,
    freshnessState: input.freshnessState ?? (isStale ? "stale" : collectionSlotUtc ? "fresh" : "unknown"),
    coverage: input.coverage ?? null,
    confidence: input.confidence ?? null,
    semantics: input.semantics ?? null,
    disclaimer: input.disclaimer ?? "HERE measurements describe observed traffic conditions and do not represent people counts.",
    routePurpose: input.routePurpose ?? null,
    routeGroupKey: input.routeGroupKey ?? null,
    tourismCenterKey: input.tourismCenterKey ?? null,
    routeDirection: input.routeDirection ?? null,
    ...input
  };
}
