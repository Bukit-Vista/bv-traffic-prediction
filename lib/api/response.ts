import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { ApiMeta } from "@/lib/dashboard/types";
import {
  ApiAuthorizationError,
  ApiNotFoundError,
  ApiRateLimitError,
  ApiUnavailableError,
  FeatureNotReadyError,
  makeMeta
} from "@/lib/api/core";

export {
  ApiAuthorizationError,
  ApiNotFoundError,
  ApiRateLimitError,
  ApiUnavailableError,
  FeatureNotReadyError,
  makeMeta
} from "@/lib/api/core";

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now().toString(36)}`;
}

export function apiJson<T>(
  data: T,
  meta: Partial<ApiMeta> = {},
  init: ResponseInit = {}
) {
  const fullMeta = makeMeta(meta);
  const response = NextResponse.json({ data, meta: fullMeta }, init);
  response.headers.set("X-Request-Id", fullMeta.requestId);
  response.headers.set("Cache-Control", "private, no-cache, must-revalidate");
  response.headers.set("Vary", "Accept-Encoding");
  return response;
}

export function apiGeoJson<T extends { type: "FeatureCollection"; features: unknown[] }>(
  collection: T,
  meta: Partial<ApiMeta> = {},
  init: ResponseInit = {}
) {
  const fullMeta = makeMeta({ featureCount: collection.features.length, ...meta });
  const response = NextResponse.json({ ...collection, meta: fullMeta }, init);
  response.headers.set("X-Request-Id", fullMeta.requestId);
  response.headers.set("Cache-Control", "private, no-cache, must-revalidate");
  response.headers.set("Vary", "Accept-Encoding");
  return response;
}

export function assertJsonResponseSize(value: unknown, maximumBytes = 12 * 1024 * 1024) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > maximumBytes) {
    throw new RangeError(`Response exceeds the ${Math.floor(maximumBytes / 1024 / 1024)} MB limit; reduce the viewport or result limit.`);
  }
  return bytes;
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  const bodyRequestId = response.headers.get("X-Request-Id");
  if (bodyRequestId) response.headers.set("X-Request-Id", bodyRequestId);
  return response;
}

export function apiError(error: unknown) {
  const responseRequestId = requestId();
  const errorPayload = (code: string, message: string, retryable: boolean) => ({
    code, message, retryable, requestId: responseRequestId
  });
  if (error instanceof ZodError) {
    return noStore(NextResponse.json(
      {
        error: {
          ...errorPayload("VALIDATION_ERROR", "The request parameters are invalid.", false),
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        },
        meta: makeMeta({ requestId: responseRequestId, status: "unavailable" })
      },
      { status: 400 }
    ));
  }

  if (error instanceof RangeError) {
    return noStore(NextResponse.json({
      error: errorPayload("VALIDATION_ERROR", error.message, false),
      meta: makeMeta({ requestId: responseRequestId, status: "unavailable" })
    }, { status: 400 }));
  }

  if (error instanceof ApiNotFoundError) {
    return noStore(NextResponse.json({
      error: { ...errorPayload(error.code, error.message, false), requestedSlotUtc: error.requestedSlotUtc },
      meta: makeMeta({ requestId: responseRequestId, status: "unavailable", requestedSlotUtc: error.requestedSlotUtc })
    }, { status: 404 }));
  }

  if (error instanceof ApiAuthorizationError) {
    return noStore(NextResponse.json({
      error: errorPayload(error.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", error.message, false),
      meta: makeMeta({ requestId: responseRequestId, status: "unavailable", source: "authorization" })
    }, { status: error.status }));
  }

  if (error instanceof ApiRateLimitError) {
    const response = NextResponse.json({
      error: errorPayload("RATE_LIMITED", error.message, true),
      meta: makeMeta({ requestId: responseRequestId, status: "unavailable" })
    }, { status: 429 });
    response.headers.set("Retry-After", String(error.retryAfterSeconds));
    return noStore(response);
  }

  if (error instanceof ApiUnavailableError) {
    return noStore(NextResponse.json(
      {
        error: errorPayload("DATA_UNAVAILABLE", error.message, true),
        meta: { ...makeMeta({ requestId: responseRequestId, status: "unavailable" }), lastSuccess: error.lastSuccess }
      },
      { status: 503 }
    ));
  }

  if (error instanceof FeatureNotReadyError) {
    return noStore(NextResponse.json(
      {
        error: { ...errorPayload("FEATURE_NOT_READY", error.message, false), feature: error.feature },
        meta: makeMeta({ requestId: responseRequestId, status: "unavailable", stale: false, source: "feature_gate", disclaimer: "No demo or inferred data is returned for this feature." })
      },
      { status: 503 }
    ));
  }

  const errorCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (["ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "PROTOCOL_CONNECTION_LOST", "PROTOCOL_SEQUENCE_TIMEOUT", "ER_CON_COUNT_ERROR", "ER_QUERY_TIMEOUT", "POOL_CLOSED", "DB_ACCOUNT_NOT_READ_ONLY"].includes(errorCode)) {
    return noStore(NextResponse.json(
      {
        error: errorPayload("DATA_UNAVAILABLE", "Current data is temporarily unavailable.", true),
        meta: makeMeta({ requestId: responseRequestId, status: "unavailable", source: "mysql" })
      },
      { status: 503 }
    ));
  }

  return noStore(NextResponse.json(
    {
      error: {
        ...errorPayload("INTERNAL_ERROR", "The request could not be completed. Database and provider details were redacted.", false)
      },
      meta: makeMeta({ requestId: responseRequestId, status: "unavailable" })
    },
    { status: 500 }
  ));
}
