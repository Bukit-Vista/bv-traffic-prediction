import { DEFAULT_APP_TIMEZONE } from "@/lib/analytics/time";

export function formatDistanceToNow(dateInput: string | Date) {
  const ms = Date.now() - new Date(dateInput).getTime();
  const minutes = Math.max(0, Math.round(ms / 60_000));

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }

  return `${Math.round(hours / 24)}d ago`;
}

export function formatAppDateTime(dateInput: string | Date) {
  return `${new Intl.DateTimeFormat("en-GB", {
    timeZone: DEFAULT_APP_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(dateInput))} WITA`;
}
