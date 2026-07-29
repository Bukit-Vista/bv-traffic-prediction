export function publicDataMessage(message: string) {
  return message
    .replace(/OpenStreetMap/gi, "map")
    .replace(/HERE Places/gi, "places data")
    .replace(/HERE Flow and Route/gi, "traffic and route data")
    .replace(/HERE Flow/gi, "traffic data")
    .replace(/HERE Routes?/gi, "route data")
    .replace(/\bHERE\b/gi, "data service")
    .replace(/\bMySQL\b/gi, "data service")
    .replace(/\bOSM\b/gi, "map")
    .replace(/\bGADM\b/gi, "administrative data")
    .replace(/\bn8n\b/gi, "automation service");
}

export function publicModelVersion(version: string | null | undefined) {
  if (!version) return "—";
  return version
    .replace(/(^|[-_])here(?=[-_]|$)/gi, "$1")
    .replace(/[-_]{2,}/g, "-")
    .replace(/[-_]$/, "");
}
