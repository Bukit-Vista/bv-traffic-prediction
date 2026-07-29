import "dotenv/config";
import { closeMySqlPool, queryRows } from "@/lib/db/mysql";

type LatestRunRow = {
  model_run_id: number;
  model_version: string;
  model_active: number | boolean;
  status: string;
  zone_count: number;
  od_count: number;
  input_coverage: number | null;
  error_json: unknown | null;
  public_serving_enabled: number | boolean;
};

function requiredBaselineRunId(argv: string[]) {
  const flagIndex = argv.indexOf("--after-model-run-id");
  const value = Number(flagIndex >= 0 ? argv[flagIndex + 1] : Number.NaN);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      "Pass the activation evidence at runtime: --after-model-run-id <positive integer>. Run IDs are never stored in application code."
    );
  }
  return value;
}

function enabled(value: number | boolean) {
  return value === true || Number(value) === 1;
}

async function main() {
  const baselineModelRunId = requiredBaselineRunId(process.argv.slice(2));
  const rows = await queryRows<LatestRunRow>(`SELECT
    latest.model_run_id,
    latest.model_version,
    versions.active AS model_active,
    latest.status,
    latest.zone_count,
    latest.od_count,
    latest.input_coverage,
    runs.error_json,
    latest.public_serving_enabled
  FROM api_internal_mobility_catchment_latest_run_v1 latest
  JOIN mobility_model_runs runs
    ON runs.id = latest.model_run_id
  JOIN mobility_model_versions versions
    ON versions.id = runs.model_version_id
    AND versions.version = latest.model_version`);
  const row = rows[0];
  const checks = [
    { key: "scheduled_run_newer_than_activation", actual: Number(row?.model_run_id ?? 0), expected: `> ${baselineModelRunId}`, ok: Number(row?.model_run_id ?? 0) > baselineModelRunId },
    { key: "model_version", actual: row?.model_version ?? null, expected: "gravity-here-v2", ok: row?.model_version === "gravity-here-v2" },
    { key: "model_active", actual: row ? enabled(row.model_active) : false, expected: true, ok: Boolean(row && enabled(row.model_active)) },
    { key: "status", actual: row?.status ?? null, expected: "success", ok: row?.status === "success" },
    { key: "zone_count", actual: Number(row?.zone_count ?? 0), expected: 21, ok: Number(row?.zone_count ?? 0) === 21 },
    { key: "od_count", actual: Number(row?.od_count ?? 0), expected: 420, ok: Number(row?.od_count ?? 0) === 420 },
    { key: "input_coverage", actual: row?.input_coverage == null ? null : Number(row.input_coverage), expected: ">= 0.90", ok: row?.input_coverage != null && Number(row.input_coverage) >= 0.90 },
    { key: "error_json", actual: row?.error_json ?? null, expected: null, ok: Boolean(row && row.error_json == null) },
    { key: "database_public_serving", actual: row ? enabled(row.public_serving_enabled) : false, expected: true, ok: Boolean(row && enabled(row.public_serving_enabled)) }
  ];
  const ready = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({
    ready,
    action: ready
      ? "MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED may be enabled for this deployment."
      : "Keep MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED=false.",
    checks
  }, null, 2)}\n`);
  if (!ready) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ready: false,
    error: error instanceof Error ? error.message : "Mobility v2 release gate failed"
  })}\n`);
  process.exitCode = 1;
}).finally(closeMySqlPool);
