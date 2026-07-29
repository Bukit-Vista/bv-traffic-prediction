import { getMobilityPredictionReadiness } from "@/lib/api/mobility-readiness";
import { apiError, apiJson } from "@/lib/api/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const readiness = await getMobilityPredictionReadiness();
    return apiJson(readiness, {
      slotUtc: readiness.latestModelRun?.predictionForUtc ?? null,
      modelRunId: readiness.latestModelRun?.id ?? null,
      modelVersion: readiness.latestModelRun?.modelVersion ?? null,
      status: readiness.ready ? readiness.latestModelRun?.status ?? "fresh" : "unavailable",
      stale: false,
      coverage: readiness.latestModelRun?.inputCoverage ?? null,
      semantics: "predicted_relative_mobility",
      source: "mobility_readiness_gate",
      disclaimer: readiness.disclaimer
    });
  } catch (error) {
    return apiError(error);
  }
}
