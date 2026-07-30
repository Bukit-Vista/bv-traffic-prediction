import { rankLatestRoutes } from "@/lib/analytics/ranking";
import { getRetentionDays } from "@/lib/config";
import {
  mapIngestionRun,
  mapRoute,
  mapRouteSample,
  type IngestionRunRow,
  type RouteRow,
  type RouteSampleRow
} from "@/lib/db/mappers";
import { queryRows, type QueryRows } from "@/lib/db/mysql";
import { getHeatmapRangeData } from "@/lib/data/heatmap-range";

export async function getDashboardData(input: { query?: QueryRows } = {}) {
  const query = input.query ?? queryRows;
  const retentionDays = getRetentionDays();
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
              SELECT rs.*
              FROM route_samples rs
              JOIN (
                SELECT route_id, MAX(sample_hour_utc) AS sample_hour_utc
                FROM route_samples
                WHERE traffic_source = 'live'
                  AND route_id IN (${routeRows.map(() => "?").join(", ")})
                GROUP BY route_id
              ) latest
                ON latest.route_id = rs.route_id
               AND latest.sample_hour_utc = rs.sample_hour_utc
              WHERE rs.traffic_source = 'live'
            `,
            routeRows.map((route) => route.id)
          )
        ).map(mapRouteSample);
  const sampleByRoute = new Map(samples.map((sample) => [sample.routeId, sample]));

  const latestInputs = routeRows.map((route) => ({
    route,
    sample: sampleByRoute.get(route.id) ?? null
  }));

  const latestRun =
    (
      await query<IngestionRunRow>(`
        SELECT *
        FROM ingestion_runs
        ORDER BY started_at_utc DESC
        LIMIT 1
      `)
    )
      .map(mapIngestionRun)
      .at(0) ?? null;
  const heatmap = await getHeatmapRangeData({ query });

  return {
    generatedAt: new Date().toISOString(),
    routes: routeRows,
    leaderboard: rankLatestRoutes(latestInputs),
    heatmap,
    latestRun,
    retentionDays
  };
}
