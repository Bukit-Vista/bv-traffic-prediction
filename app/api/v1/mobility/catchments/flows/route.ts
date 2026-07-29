import {
  publicCatchmentError,
  publicCatchmentJson,
  requirePublicCatchmentRequest
} from "@/lib/api/public-catchment-route";
import { readCatchmentFlows } from "@/lib/api/internal-catchment-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optionalNumber(value: string | null) {
  return value == null || value === "" ? undefined : Number(value);
}

export async function GET(request: Request) {
  const access = requirePublicCatchmentRequest(request);
  if (access.response) return access.response;
  try {
    const url = new URL(request.url);
    const origin = url.searchParams.get("origin");
    const destination = url.searchParams.get("destination");
    const minScore = optionalNumber(url.searchParams.get("minScore"));
    const limit = optionalNumber(url.searchParams.get("limit"));
    const result = await readCatchmentFlows(
      { origin, destination, minScore, limit },
      undefined,
      "public"
    );
    return publicCatchmentJson(request, result.meta, {
      run: {
        modelRunId: result.meta.modelRunId,
        flowRunId: result.meta.flowRunId,
        modelVersion: result.meta.modelVersion,
        predictionForUtc: result.meta.predictionForUtc,
        status: result.meta.status,
        zoneCount: result.meta.zoneCount,
        odCount: result.meta.odCount,
        inputCoverage: result.meta.inputCoverage,
        semantics: result.meta.semantics,
        disclaimer: result.meta.disclaimer
      },
      originCatchmentKey: result.originCatchmentKey,
      destinationCatchmentKey: result.destinationCatchmentKey,
      minScore: result.minScore,
      totalAvailablePairCount: result.totalAvailablePairCount,
      returnedPairCount: result.returnedPairCount,
      flows: result.flows
    }, {
      origin: result.originCatchmentKey,
      destination: result.destinationCatchmentKey,
      minScore: result.minScore,
      limit
    });
  } catch (error) {
    return publicCatchmentError(error);
  }
}
