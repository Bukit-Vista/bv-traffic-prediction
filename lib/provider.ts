const PROVIDER_LABELS: Record<string, string> = {
  here: "HERE",
  tomtom: "TomTom"
};

export function formatProviderName(provider: string | null | undefined) {
  const value = provider?.trim();
  if (!value) {
    return "Unknown";
  }

  const key = value.toLowerCase();
  const knownLabel = PROVIDER_LABELS[key];
  if (knownLabel) {
    return knownLabel;
  }

  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) =>
      part.length <= 3 && part === part.toUpperCase()
        ? part
        : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`
    )
    .join(" ");
}

export function formatRoutingAttribution(
  providers: Array<string | null | undefined>
) {
  const labels = Array.from(
    new Set(
      providers
        .filter((provider): provider is string => Boolean(provider?.trim()))
        .map(formatProviderName)
    )
  );

  if (labels.length === 0) {
    return "Travel time and distance results are derived from routing provider data.";
  }

  if (labels.length === 1) {
    return `Travel time and distance results are derived from ${labels[0]} routing data.`;
  }

  const last = labels.at(-1);
  const prefix = labels.slice(0, -1).join(", ");
  return `Travel time and distance results are derived from ${prefix}, and ${last} routing data.`;
}
