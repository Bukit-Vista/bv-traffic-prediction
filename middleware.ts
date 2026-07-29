import { NextResponse, type NextRequest } from "next/server";

const FEATURES: Array<[prefix: string, feature: string]> = [
  ["/api/v1/incidents", "incidents"],
  ["/api/v1/analytics", "unsupported_analytics"],
];

const SERVING_CONFIG_PATHS = new Set([
  "/api/v1/mobility/scope",
  "/api/v1/mobility/readiness",
  "/api/v1/mobility/airport-destinations/config",
  "/api/v1/health"
]);
const SOURCE_DERIVED_MOBILITY_PATHS = new Set([
  "/api/v1/mobility/centers",
  "/api/v1/mobility/display-grid"
]);
const PUBLIC_CATCHMENT_V2_PREFIX = "/api/v1/mobility/catchments/";

export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin");
  const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const crossOrigin = Boolean(origin && origin !== request.nextUrl.origin);
  const originAllowed = !crossOrigin || configuredOrigins.includes(origin!);
  if (!originAllowed) {
    return NextResponse.json({
      error: { code: "CORS_ORIGIN_DENIED", message: "This origin is not allowed to access the API.", retryable: false, requestId: crypto.randomUUID() },
      meta: { requestedAtUtc: new Date().toISOString(), status: "unavailable" }
    }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    if (origin) response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type,If-None-Match");
    response.headers.set("Access-Control-Max-Age", "600");
    response.headers.append("Vary", "Origin");
    return response;
  }
  if (request.nextUrl.pathname.startsWith(PUBLIC_CATCHMENT_V2_PREFIX) &&
      process.env.MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED !== "true") {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found." } },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (request.nextUrl.pathname.startsWith("/api/v1/mobility/") &&
      !request.nextUrl.pathname.startsWith(PUBLIC_CATCHMENT_V2_PREFIX) &&
      !SOURCE_DERIVED_MOBILITY_PATHS.has(request.nextUrl.pathname) &&
      !SERVING_CONFIG_PATHS.has(request.nextUrl.pathname) &&
      process.env.MOBILITY_SHADOW_READ_ENABLED === "false") {
    return NextResponse.json({
      error: { code: "FEATURE_NOT_READY", feature: "mobility_shadow_read", message: "Internal mobility shadow reads are disabled." },
      meta: {
        requestId: crypto.randomUUID(), generatedAt: new Date().toISOString(), selectedSlot: null,
        slotUtc: null, status: "unavailable", stale: false, source: "feature_gate",
        semantics: "predicted_relative_mobility",
        disclaimer: "Relative mobility prediction based on traffic, accessibility, and attraction signals. It does not represent actual people, vehicles, or trip counts."
      }
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (SOURCE_DERIVED_MOBILITY_PATHS.has(request.nextUrl.pathname) &&
      process.env.MOBILITY_PLACES_LAYER_ENABLED === "false") {
    return NextResponse.json({
      error: { code: "FEATURE_NOT_READY", feature: "mobility_places_layer", message: "The HERE Places map layer is disabled." },
      meta: { requestId: crypto.randomUUID(), generatedAt: new Date().toISOString(), status: "unavailable", source: "feature_gate", semantics: request.nextUrl.pathname.endsWith("display-grid") ? "source_derived_places_heatmap" : "source_activity_centers" }
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const sourceDashboardEnabled = process.env.BALI_SOURCE_DASHBOARD_ENABLED === "true" ||
    (process.env.NODE_ENV !== "production" && process.env.BALI_SOURCE_DASHBOARD_ENABLED !== "false");
  if (!sourceDashboardEnabled &&
      request.nextUrl.pathname.startsWith("/api/v1/") && !SERVING_CONFIG_PATHS.has(request.nextUrl.pathname)) {
    return NextResponse.json({
      error: { code: "SOURCE_DASHBOARD_DISABLED", message: "The Bali source dashboard is disabled until the Step 3 release gate passes.", retryable: false, requestId: crypto.randomUUID() },
      meta: { requestedAtUtc: new Date().toISOString(), status: "unavailable", source: "feature_gate" }
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (process.env.AIRPORT_TOURISM_ROUTES_ENABLED === "false" &&
      (request.nextUrl.pathname.startsWith("/api/v1/routes") || request.nextUrl.pathname === "/api/v1/export/routes.csv")) {
    return NextResponse.json({
      error: { code: "FEATURE_NOT_READY", feature: "airport_tourism_routes", message: "Airport-tourism routes are disabled until the 14/14 source acceptance gate passes." },
      meta: {
        requestId: crypto.randomUUID(), generatedAt: new Date().toISOString(), selectedSlot: null, slotUtc: null,
        source: "feature_gate", sourceRunId: null, modelRunId: null, modelVersion: null,
        status: "unavailable", stale: false, freshnessSeconds: null, coverage: null,
        confidence: null, semantics: "measured_route_condition",
        disclaimer: "No route direction is inferred or copied from the opposite direction."
      }
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const sourceCutoverPaths = ["/api/v1/dashboard", "/api/v1/flow", "/api/v1/routes", "/api/v1/traffic", "/api/v1/ops"];
  if (process.env.HERE_SOURCE_CUTOVER_ENABLED === "false" &&
      (sourceCutoverPaths.some((prefix) => request.nextUrl.pathname.startsWith(prefix)) || SERVING_CONFIG_PATHS.has(request.nextUrl.pathname))) {
    return NextResponse.json({
      error: { code: "SOURCE_CUTOVER_DISABLED", message: "The HERE source-data cutover is disabled for this deployment." },
      meta: {
        requestId: crypto.randomUUID(), generatedAt: new Date().toISOString(), selectedSlot: null, slotUtc: null,
        source: "cutover_flag", sourceRunId: null, modelRunId: null, modelVersion: null,
        status: "unavailable", stale: false, freshnessSeconds: null, coverage: null,
        confidence: null, semantics: null, disclaimer: "No fixture fallback is permitted."
      }
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  // Configuration and readiness remain available even when source serving is
  // disabled so the workspace can explain which production gates are missing.
  if (SERVING_CONFIG_PATHS.has(request.nextUrl.pathname)) return corsResponse(request, origin);
  const match = FEATURES.find(([prefix]) => request.nextUrl.pathname.startsWith(prefix));
  if (!match) return corsResponse(request, origin);

  const [, feature] = match;
  const generatedAt = new Date().toISOString();
  return NextResponse.json(
    {
      error: {
        code: "FEATURE_NOT_READY",
        feature,
        message: `${feature} is unavailable until its production data gates pass.`
      },
      meta: {
        requestId: crypto.randomUUID(), generatedAt, selectedSlot: null, slotUtc: null,
        source: "feature_gate", sourceRunId: null, modelRunId: null, modelVersion: null,
        status: "unavailable", stale: false, freshnessSeconds: null, coverage: null,
        confidence: null, semantics: null,
        disclaimer: "No demo or inferred data is returned for this feature."
      }
    },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}

function corsResponse(request: NextRequest, origin: string | null) {
  const response = NextResponse.next();
  if (origin && origin !== request.nextUrl.origin) response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.append("Vary", "Origin");
  return response;
}

export const config = {
  matcher: ["/api/v1/:path*"]
};
