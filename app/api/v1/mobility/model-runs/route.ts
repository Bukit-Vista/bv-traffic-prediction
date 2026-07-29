import { apiError, apiJson } from "@/lib/api/response";
import { readMobilityRuns, resolveMobilityRun, MOBILITY_DISCLAIMER } from "@/lib/api/mobility-shadow";
import { mobilityModelRunsQuerySchema, parseQuery } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(mobilityModelRunsQuerySchema, request);
    const [runs, latest] = await Promise.all([
      readMobilityRuns(input),
      resolveMobilityRun("latest").catch(() => null)
    ]);
    return apiJson({ runs }, latest?.meta ?? {
      status: "unavailable", semantics: "predicted_relative_mobility", disclaimer: MOBILITY_DISCLAIMER
    });
  } catch (error) {
    return apiError(error);
  }
}
