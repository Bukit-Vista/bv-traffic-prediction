import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api/access-control";
import {
  CATCHMENT_DISCLAIMER,
  CATCHMENT_MODEL_VERSION,
  CATCHMENT_PUBLIC_FLAG_KEY,
  CATCHMENT_SEMANTICS,
  CatchmentPreviewUnavailableError,
  catchmentPreviewEtag,
  catchmentPublicFlagEnabled,
  type CatchmentPreviewMeta
} from "@/lib/api/internal-catchment-preview";
import { apiError } from "@/lib/api/response";

export function requirePublicCatchmentRequest(request: Request) {
  if (!catchmentPublicFlagEnabled()) {
    return {
      response: NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Not found." } },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      )
    };
  }
  try {
    enforceRateLimit(request, "public-catchment-v2", { maximum: 180 });
    return {};
  } catch (error) {
    return { response: apiError(error) };
  }
}

export function publicCatchmentJson(
  request: Request,
  meta: CatchmentPreviewMeta,
  data: unknown,
  filters: Record<string, unknown> = {}
) {
  const etag = catchmentPreviewEtag(meta, filters);
  const headers = {
    "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
    "ETag": etag,
    "Vary": "Accept-Encoding"
  };
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json({ meta, data }, { headers });
}

export function publicCatchmentError(error: unknown) {
  if (error instanceof CatchmentPreviewUnavailableError) {
    return NextResponse.json({
      meta: {
        status: "unavailable",
        modelVersion: CATCHMENT_MODEL_VERSION,
        semantics: CATCHMENT_SEMANTICS,
        disclaimer: CATCHMENT_DISCLAIMER,
        featureFlagKey: CATCHMENT_PUBLIC_FLAG_KEY,
        internalPreview: false,
        publicServing: false,
        servingMode: "public"
      },
      data: null,
      error: {
        code: "PUBLIC_V2_NOT_READY",
        message: "The public gravity-here-v2 serving contract is not ready."
      }
    }, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }
  return apiError(error);
}
