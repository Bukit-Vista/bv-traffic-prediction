import { calculateCongestionScore } from "@/lib/analytics/congestion";
import {
  getLocalDayUtcRange,
  getLocalHour,
  isoDaysAgo
} from "@/lib/analytics/time";
import { getRetentionDays } from "@/lib/config";
import {
  mapRoute,
  mapRouteSample,
  type RouteRow,
  type RouteSampleRow
} from "@/lib/db/mappers";
import { queryRows, toMysqlDateTime, type QueryRows } from "@/lib/db/mysql";

export async function getRouteDetail(
  slug: string,
  input: { query?: QueryRows } = {}
) {
  const query = input.query ?? queryRows;
  const route =
    (
      await query<RouteRow>(
        `
          SELECT *
          FROM routes
          WHERE slug = ?
          LIMIT 1
        `,
        [slug]
      )
    )
      .map(mapRoute)
      .at(0) ?? null;

  if (!route) {
    return null;
  }

  const retentionDays = getRetentionDays();
  const since = isoDaysAgo(retentionDays);
  const samples = (
    await query<RouteSampleRow>(
      `
        SELECT *
        FROM route_samples
        WHERE route_id = ?
          AND traffic_source = 'live'
          AND sample_hour_utc >= ?
        ORDER BY sample_hour_utc
      `,
      [route.id, toMysqlDateTime(since)]
    )
  ).map(mapRouteSample);

  const latest =
    (
      await query<RouteSampleRow>(
        `
          SELECT *
          FROM route_samples
          WHERE route_id = ?
            AND traffic_source = 'live'
          ORDER BY sample_hour_utc DESC
          LIMIT 1
        `,
        [route.id]
      )
    )
      .map(mapRouteSample)
      .at(0) ?? null;

  const todayRange = getLocalDayUtcRange();
  const todaySamples = (
    await query<RouteSampleRow>(
      `
        SELECT *
        FROM route_samples
        WHERE route_id = ?
          AND traffic_source = 'live'
          AND sample_hour_utc >= ?
          AND sample_hour_utc < ?
        ORDER BY sample_hour_utc
      `,
      [
        route.id,
        toMysqlDateTime(todayRange.start),
        toMysqlDateTime(todayRange.end)
      ]
    )
  ).map(mapRouteSample);

  const hourlyBuckets = new Map<number, { sum: number; count: number }>();
  for (const sample of samples) {
    const score = calculateCongestionScore(sample);
    if (score == null) {
      continue;
    }
    const hour = getLocalHour(sample.sampleHour);
    const bucket = hourlyBuckets.get(hour) ?? { sum: 0, count: 0 };
    bucket.sum += score;
    bucket.count += 1;
    hourlyBuckets.set(hour, bucket);
  }

  return {
    route,
    latest,
    retentionDays,
    today: todaySamples.map((sample) => ({
      hour: getLocalHour(sample.sampleHour),
      sampleHour: sample.sampleHour,
      currentMinutes: Math.round(sample.trafficDurationSeconds / 60),
      normalMinutes: Math.round(sample.durationSeconds / 60)
    })),
    history: samples.map((sample) => ({
      sampleHour: sample.sampleHour,
      score: calculateCongestionScore(sample)
    })),
    hourlyAverage: Array.from({ length: 24 }, (_, hour) => {
      const bucket = hourlyBuckets.get(hour);
      return {
        hour,
        score: bucket ? bucket.sum / bucket.count : null,
        count: bucket?.count ?? 0
      };
    })
  };
}
