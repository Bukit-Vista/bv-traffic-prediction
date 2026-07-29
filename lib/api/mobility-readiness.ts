import { getMobilityProductScope } from "@/lib/api/database-serving-contract";
import { FeatureNotReadyError } from "@/lib/api/core";
import { queryRows, type QueryRows } from "@/lib/db/mysql";
import { toIsoUtc } from "@/lib/db/mappers";
import type { MobilityPredictionReadiness } from "@/lib/dashboard/types";
import { MOBILITY_DISCLAIMER, resolveMobilityRun } from "@/lib/api/mobility-shadow";
import { withRedisJsonCache } from "@/lib/cache/redis-json";

type LatestRunRow = {
  id: number;
  prediction_for_utc: string;
  status: "success" | "partial";
  input_coverage: number | null;
  version: string;
  model_active: number;
};

type CountRow = {
  active_zones: number;
  activity_centers: number;
  zone_road_mappings: number;
  zone_predictions: number;
  od_predictions: number;
};

async function loadShadowReadiness(query: QueryRows, checkedAtUtc: string): Promise<MobilityPredictionReadiness> {
  const resolved = await resolveMobilityRun("latest", query).catch(() => null);
  const runId = resolved?.run.modelRunId ?? null;
  const rows = await query<CountRow>(
    `SELECT
      (SELECT COUNT(*) FROM mobility_zones WHERE active = 1) AS active_zones,
      (SELECT COUNT(*) FROM activity_centers
        WHERE active = 1 AND model_input_version = 'here-tourism-category-map-v1') AS activity_centers,
      (SELECT COUNT(*) FROM mobility_zone_road_segments) AS zone_road_mappings,
      (SELECT COUNT(*) FROM mobility_zone_predictions WHERE model_run_id = ?) AS zone_predictions,
      (SELECT COUNT(*) FROM mobility_od_predictions WHERE model_run_id = ?) AS od_predictions`,
    [runId, runId]
  );
  const row = rows[0];
  const counts = {
    activeZones: Number(row?.active_zones ?? 0),
    activityCenters: Number(row?.activity_centers ?? 0),
    zoneRoadMappings: Number(row?.zone_road_mappings ?? 0),
    zonePredictions: Number(row?.zone_predictions ?? 0),
    odPredictions: Number(row?.od_predictions ?? 0)
  };
  const missing: MobilityPredictionReadiness["missing"] = [];
  if (!resolved) missing.push("successful_model_run_missing");
  if (!counts.activeZones) missing.push("active_zones_missing");
  if (!counts.activityCenters) missing.push("activity_centers_missing");
  if (!counts.zoneRoadMappings) missing.push("zone_road_mappings_missing");
  if (!counts.zonePredictions) missing.push("zone_predictions_missing");
  if (!counts.odPredictions) missing.push("od_predictions_missing");
  return {
    workspaceEnabled: true,
    ready: missing.length === 0,
    status: missing.length === 0 ? "ready" : "blocked",
    checkedAtUtc,
    scope: {
      key: "bali-mobility-shadow", version: "v1", status: "internal_shadow",
      predictionEnabled: process.env.MOBILITY_SHADOW_READ_ENABLED !== "false"
    },
    latestModelRun: resolved ? {
      id: String(resolved.run.modelRunId), predictionForUtc: resolved.run.slotUtc,
      status: "success", modelVersion: resolved.run.modelVersion,
      inputCoverage: resolved.run.coverage
    } : null,
    counts,
    missing,
    disclaimer: MOBILITY_DISCLAIMER
  };
}

async function loadReadiness(query: QueryRows, checkedAtUtc: string): Promise<MobilityPredictionReadiness> {
  const [scope, runs, countRows] = await Promise.all([
    getMobilityProductScope(query),
    query<LatestRunRow>(
      `SELECT r.id, r.prediction_for_utc, r.status, r.input_coverage,
              v.version, v.active AS model_active
         FROM mobility_model_runs r
         JOIN mobility_model_versions v ON v.id = r.model_version_id
        WHERE r.status IN ('success','partial')
        ORDER BY r.prediction_for_utc DESC, r.id DESC
        LIMIT 1`
    ),
    query<CountRow>(
      `SELECT
       (SELECT COUNT(*) FROM mobility_zones WHERE active = 1) AS active_zones,
       (SELECT COUNT(*) FROM activity_centers WHERE active = 1) AS activity_centers,
       (SELECT COUNT(*) FROM mobility_zone_road_segments) AS zone_road_mappings,
       (SELECT COUNT(*) FROM mobility_zone_predictions WHERE model_run_id = (
          SELECT id FROM mobility_model_runs WHERE status IN ('success','partial')
          ORDER BY prediction_for_utc DESC, id DESC LIMIT 1
        )) AS zone_predictions,
       (SELECT COUNT(*) FROM mobility_od_predictions WHERE model_run_id = (
          SELECT id FROM mobility_model_runs WHERE status IN ('success','partial')
          ORDER BY prediction_for_utc DESC, id DESC LIMIT 1
        )) AS od_predictions`
    )
  ]);
  const latest = runs[0] ?? null;
  const row = countRows[0];
  const counts = {
    activeZones: Number(row?.active_zones ?? 0),
    activityCenters: Number(row?.activity_centers ?? 0),
    zoneRoadMappings: Number(row?.zone_road_mappings ?? 0),
    zonePredictions: Number(row?.zone_predictions ?? 0),
    odPredictions: Number(row?.od_predictions ?? 0)
  };
  const missing: MobilityPredictionReadiness["missing"] = [];
  if (scope.status !== "approved") missing.push("scope_not_approved");
  if (!scope.predictionEnabled) missing.push("prediction_disabled");
  if (!latest || !Boolean(latest.model_active)) missing.push("active_model_missing");
  if (!latest) missing.push("successful_model_run_missing");
  if (!counts.activeZones) missing.push("active_zones_missing");
  if (!counts.activityCenters) missing.push("activity_centers_missing");
  if (!counts.zoneRoadMappings) missing.push("zone_road_mappings_missing");
  if (!counts.zonePredictions) missing.push("zone_predictions_missing");
  if (!counts.odPredictions) missing.push("od_predictions_missing");

  return {
    workspaceEnabled: true,
    ready: missing.length === 0,
    status: missing.length === 0 ? "ready" : "blocked",
    checkedAtUtc,
    scope: {
      key: scope.scopeKey,
      version: scope.scopeVersion,
      status: scope.status,
      predictionEnabled: scope.predictionEnabled
    },
    latestModelRun: latest ? {
      id: String(latest.id),
      predictionForUtc: toIsoUtc(latest.prediction_for_utc) as string,
      status: latest.status,
      modelVersion: latest.version,
      inputCoverage: latest.input_coverage == null ? null : Number(latest.input_coverage)
    } : null,
    counts,
    missing,
    disclaimer: scope.disclaimer || "Predicted relative mobility is model-derived and is not an observed people or trip count."
  };
}

export async function getMobilityPredictionReadiness(
  query: QueryRows = queryRows,
  now = new Date()
): Promise<MobilityPredictionReadiness> {
  if (query !== queryRows) return loadReadiness(query, now.toISOString());
  return withRedisJsonCache(
    { resource: "mobility-readiness", identity: "latest", ttlSeconds: 15 },
    () => loadShadowReadiness(query, now.toISOString())
  );
}

export async function requireMobilityPredictionReady(query: QueryRows = queryRows) {
  const readiness = await getMobilityPredictionReadiness(query);
  if (!readiness.ready) {
    throw new FeatureNotReadyError(
      "predicted_mobility",
      "The prediction workspace is open, but production mobility inputs and model runs have not passed their data gates."
    );
  }
  return readiness;
}

export function clearMobilityReadinessCache() {
  // Production cache state is held in Redis. Injected-query tests bypass it.
}
