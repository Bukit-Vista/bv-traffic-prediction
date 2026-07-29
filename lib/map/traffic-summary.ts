export function formatCongestedRoadShare(value: number | null | undefined) {
  if (value == null) return "—";
  const percentage = value * 100;
  if (percentage === 0) return "0%";
  if (percentage < 0.1) return "<0.1%";
  if (percentage < 10) return `${percentage.toFixed(1)}%`;
  return `${Math.round(percentage)}%`;
}
