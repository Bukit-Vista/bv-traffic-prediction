import { createHash } from "node:crypto";

export const LATEST_CACHE_CONTROL = "private, no-cache, must-revalidate";
export const HISTORICAL_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
export const CACHE_SCHEMA_VERSION = "dashboard-cache-v1";

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

export function conditionalCacheEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.DASHBOARD_CONDITIONAL_CACHE_ENABLED !== "false";
}

export function createResourceEtag(resource: string, identity: unknown, scope: unknown = null) {
  const digest = createHash("sha256")
    .update(stableSerialize({ schema: CACHE_SCHEMA_VERSION, resource, identity, scope }))
    .digest("base64url")
    .slice(0, 27);
  return `W/"${digest}"`;
}

function normalizedEtag(value: string) {
  return value.trim().replace(/^W\//, "");
}

export function requestMatchesEtag(request: Request, etag: string) {
  const header = request.headers.get("if-none-match");
  if (!header) return false;
  return header.split(",").some((candidate) => candidate.trim() === "*" || normalizedEtag(candidate) === normalizedEtag(etag));
}

export function cacheControlForAt(at: string) {
  return at === "latest" ? LATEST_CACHE_CONTROL : HISTORICAL_CACHE_CONTROL;
}

export function applyConditionalHeaders(response: Response, etag: string, cacheControl = LATEST_CACHE_CONTROL) {
  if (!conditionalCacheEnabled()) return response;
  response.headers.set("ETag", etag);
  response.headers.set("Cache-Control", cacheControl);
  response.headers.set("Vary", "Accept-Encoding");
  return response;
}

export function conditionalNotModified(request: Request, etag: string, cacheControl = LATEST_CACHE_CONTROL) {
  if (!conditionalCacheEnabled() || !requestMatchesEtag(request, etag)) return null;
  return new Response(null, {
    status: 304,
    headers: { "ETag": etag, "Cache-Control": cacheControl, "Vary": "Accept-Encoding" }
  });
}
