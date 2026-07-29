import { apiError, apiJson } from "@/lib/api/response";
import { readMobilityRuns, resolveMobilityRun, MOBILITY_DISCLAIMER } from "@/lib/api/mobility-shadow";
import { parseQuery, rangeQuerySchema } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(rangeQuerySchema, request);
    const [runs, latest] = await Promise.all([
      readMobilityRuns({ from: input.from, to: input.to, limit: input.limit }),
      resolveMobilityRun("latest").catch(() => null)
    ]);
    return apiJson({
      slots: runs
        .filter((run) => run.status === "success" || run.status === "partial")
        .map((run) => ({
          slotUtc: run.slotUtc, modelRunId: run.modelRunId, sourceRunId: run.sourceRunId,
          status: run.status, coverage: run.coverage
        })),
      intervalMinutes: 30
    }, latest?.meta ?? {
      status: "unavailable", semantics: "predicted_relative_mobility", disclaimer: MOBILITY_DISCLAIMER
    });
  } catch (error) {
    return apiError(error);
  }
}
