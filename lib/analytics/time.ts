export const DEFAULT_APP_TIMEZONE =
  process.env.APP_TIMEZONE ?? "Asia/Makassar";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function truncateToUtcHour(date = new Date()) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours()
    )
  );
}

export function toSampleHourIso(date = new Date()) {
  return truncateToUtcHour(date).toISOString();
}

function getLocalParts(date: Date, timeZone = DEFAULT_APP_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit"
  }).formatToParts(date);

  const value = (type: string) => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) {
      throw new Error(`Missing date part ${type}`);
    }
    return Number(part.value);
  };

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour")
  };
}

export function getLocalHour(dateInput: string | Date, timeZone = DEFAULT_APP_TIMEZONE) {
  return getLocalParts(new Date(dateInput), timeZone).hour;
}

export function getLocalDateKey(
  dateInput: string | Date,
  timeZone = DEFAULT_APP_TIMEZONE
) {
  const parts = getLocalParts(new Date(dateInput), timeZone);
  return `${parts.year}-${parts.month.toString().padStart(2, "0")}-${parts.day
    .toString()
    .padStart(2, "0")}`;
}

function getTimeZoneOffsetMs(date: Date, timeZone = DEFAULT_APP_TIMEZONE) {
  const parts = getLocalParts(date, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour
  );
  return localAsUtc - truncateToUtcHour(date).getTime();
}

export function getLocalDayUtcRange(
  date = new Date(),
  timeZone = DEFAULT_APP_TIMEZONE
) {
  const parts = getLocalParts(date, timeZone);
  const localMidnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const offset = getTimeZoneOffsetMs(new Date(localMidnightAsUtc), timeZone);
  const start = new Date(localMidnightAsUtc - offset);
  const end = new Date(start.getTime() + DAY_MS);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function getLocalDateUtcRange(
  dateKey: string,
  timeZone = DEFAULT_APP_TIMEZONE
) {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  const offset = getTimeZoneOffsetMs(new Date(localMidnightAsUtc), timeZone);
  const start = new Date(localMidnightAsUtc - offset);
  const end = new Date(start.getTime() + DAY_MS);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function addDaysToDateKey(dateKey: string, days: number) {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }

  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)
  );
  return date.toISOString().slice(0, 10);
}

export function localDateRangeToUtc(
  startDateKey: string,
  endDateKey: string,
  timeZone = DEFAULT_APP_TIMEZONE
) {
  const start = getLocalDateUtcRange(startDateKey, timeZone).start;
  const end = getLocalDateUtcRange(addDaysToDateKey(endDateKey, 1), timeZone).start;
  return { start, end };
}

export function isoHoursAgo(hours: number, from = new Date()) {
  return new Date(from.getTime() - hours * HOUR_MS).toISOString();
}

export function isoDaysAgo(days: number, from = new Date()) {
  return new Date(from.getTime() - days * DAY_MS).toISOString();
}
