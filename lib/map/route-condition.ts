export type RouteConditionStyle = {
  color: string;
  width: number;
  tone: "faster" | "typical" | "slower" | "unavailable";
  label: string;
};

export function routeConditionStyle(ratio: number | null | undefined): RouteConditionStyle {
  if (ratio == null || !Number.isFinite(ratio)) {
    return { color: "#667a73", width: 4, tone: "unavailable", label: "Condition unavailable" };
  }
  if (ratio < 1) {
    return {
      color: "#25845e",
      width: 4,
      tone: "faster",
      label: `${ratio.toFixed(2)}× · faster than typical`
    };
  }
  if (ratio === 1) {
    return { color: "#55766b", width: 4, tone: "typical", label: "1.00× · typical travel time" };
  }
  const width = Math.min(12, 4 + (ratio - 1) * 18);
  return {
    color: ratio >= 1.35 ? "#8f2530" : ratio >= 1.15 ? "#b9363d" : "#d25a4c",
    width,
    tone: "slower",
    label: `${ratio.toFixed(2)}× · slower than typical`
  };
}
