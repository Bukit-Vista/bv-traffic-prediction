import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api/access-control";
import {
  CATCHMENT_DISCLAIMER,
  CATCHMENT_MODEL_VERSION,
  CATCHMENT_PREVIEW_FLAG_KEY,
  CATCHMENT_SEMANTICS,
  CatchmentPreviewUnavailableError,
  catchmentPreviewEtag,
  catchmentPreviewFlagEnabled,
  type CatchmentPreviewMeta
} from "@/lib/api/internal-catchment-preview";
import { apiError } from "@/lib/api/response";

export function requireInternalCatchmentRequest(request: Request) {
  if (!catchmentPreviewFlagEnabled()) {
    return {
      response: NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Not found." } },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      )
    };
  }
  try {
    enforceRateLimit(request, "internal-catchment-preview", { maximum: 120 });
    return {};
  } catch (error) {
    return { response: apiError(error) };
  }
}

export function internalCatchmentJson(
  request: Request,
  meta: CatchmentPreviewMeta,
  data: unknown,
  filters: Record<string, unknown> = {}
) {
  const etag = catchmentPreviewEtag(meta, filters);
  const headers = {
    "Cache-Control": "private, no-cache, must-revalidate",
    "ETag": etag,
    "Vary": "Accept-Encoding"
  };
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json({ meta, data }, { headers });
}

export function unavailableCatchmentResponse(error: CatchmentPreviewUnavailableError) {
  return NextResponse.json({
    meta: {
      status: "unavailable",
      modelVersion: CATCHMENT_MODEL_VERSION,
      semantics: CATCHMENT_SEMANTICS,
      disclaimer: CATCHMENT_DISCLAIMER,
      featureFlagKey: CATCHMENT_PREVIEW_FLAG_KEY,
      internalPreview: true,
      publicServing: false
    },
    data: null,
    ...(error.reason === "misconfigured"
      ? { error: { code: "PREVIEW_MISCONFIGURED", message: error.message } }
      : {})
  }, {
    status: 503,
    headers: { "Cache-Control": "no-store" }
  });
}

export function internalCatchmentError(error: unknown) {
  if (error instanceof CatchmentPreviewUnavailableError) {
    return unavailableCatchmentResponse(error);
  }
  return apiError(error);
}
