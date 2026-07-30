import {
  buildHeatmap,
  MAX_HEATMAP_RANGE_DAYS
} from "@/lib/analytics/heatmap";
import {
  addDaysToDateKey,
  getLocalDateUtcRange,
  getLocalDateKey,
  localDateRangeToUtc
} from "@/lib/analytics/time";
import {
  mapRoute,
  mapRouteSample,
  type RouteRow,
  type RouteSampleRow
} from "@/lib/db/mappers";
import { queryRows, toMysqlDateTime, type QueryRows } from "@/lib/db/mysql";

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type HeatmapRangeInput = {
  startDate?: string | null;
  endDate?: string | null;
  now?: Date;
  query?: QueryRows;
};

function assertDateKey(value: string, label: string) {
  if (!DATE_KEY_PATTERN.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real calendar date`);
  }
}

function diffDaysInclusive(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}

function dateKeysInRange(startDate: string, days: number) {
  return Array.from({ length: days }, (_, index) =>
    addDaysToDateKey(startDate, index)
  );
}

export function normalizeHeatmapRange(input: HeatmapRangeInput = {}) {
  const today = getLocalDateKey(input.now ?? new Date());
  const startDate = input.startDate || today;
  const endDate = input.endDate || startDate;

  assertDateKey(startDate, "start");
  assertDateKey(endDate, "end");

  const days = diffDaysInclusive(startDate, endDate);
  if (days < 1) {
    throw new Error("end must be on or after start");
  }

  if (days > MAX_HEATMAP_RANGE_DAYS) {
    throw new Error(`range cannot exceed ${MAX_HEATMAP_RANGE_DAYS} days`);
  }

  return {
    startDate,
    endDate,
    days,
    maxEndDate: addDaysToDateKey(startDate, MAX_HEATMAP_RANGE_DAYS - 1)
  };
}

export async function getHeatmapRangeData(input: HeatmapRangeInput = {}) {
  const query = input.query ?? queryRows;
  const range = normalizeHeatmapRange(input);
  const utcRange = localDateRangeToUtc(range.startDate, range.endDate);
  const routeRows = (
    await query<RouteRow>(`
      SELECT *
      FROM routes
      WHERE active = 1
      ORDER BY category, origin_label
    `)
  ).map(mapRoute);

  const samples =
    routeRows.length === 0
      ? []
      : (
          await query<RouteSampleRow>(
            `
              SELECT *
              FROM route_samples
              WHERE traffic_source = 'live'
                AND route_id IN (${routeRows.map(() => "?").join(", ")})
                AND sample_hour_utc >= ?
                AND sample_hour_utc < ?
              ORDER BY sample_hour_utc, route_id
            `,
            [
              ...routeRows.map((route) => route.id),
              toMysqlDateTime(utcRange.start),
              toMysqlDateTime(utcRange.end)
            ]
          )
        ).map(mapRouteSample);

  const heatmaps = dateKeysInRange(range.startDate, range.days).map((date) => {
    const dayUtcRange = getLocalDateUtcRange(date);
    const daySamples = samples.filter(
      (sample) =>
        sample.sampleHour >= dayUtcRange.start && sample.sampleHour < dayUtcRange.end
    );

    return {
      date,
      utcRange: dayUtcRange,
      rows: buildHeatmap(routeRows, daySamples)
    };
  });

  return {
    ...range,
    utcRange,
    heatmaps,
    rows: heatmaps[0]?.rows ?? []
  };
}
