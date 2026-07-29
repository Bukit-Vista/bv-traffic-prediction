/**
 * MapLibre fetches vector tiles in a Web Worker. Keep URL templates absolute so
 * same-origin API paths are not resolved against MapLibre's blob worker URL.
 * String concatenation intentionally preserves the `{z}/{x}/{y}` placeholders.
 */
export function resolveTrafficTileUrlTemplate(template: string, origin: string) {
  if (/^https?:\/\//i.test(template)) return template;
  const normalizedOrigin = origin.replace(/\/+$/, "");
  const normalizedPath = template.startsWith("/") ? template : `/${template}`;
  return `${normalizedOrigin}${normalizedPath}`;
}

// Bump only when a previously cacheable tile response must be invalidated in
// browsers. Snapshot identity still lives in the URL path and remains canonical.
export const TRAFFIC_TILE_CLIENT_REVISION = "2";

export function appendTrafficTileClientRevision(
  template: string,
  revision = TRAFFIC_TILE_CLIENT_REVISION
) {
  const separator = template.includes("?") ? "&" : "?";
  return `${template}${separator}client=${encodeURIComponent(revision)}`;
}
