import { apiError, apiGeoJson } from "@/lib/api/response";
import { readMobilityFlows } from "@/lib/api/mobility-shadow";
import { mobilityFlowsQuerySchema, parseQuery } from "@/lib/api/validation";
import { withRedisJsonCache } from "@/lib/cache/redis-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(mobilityFlowsQuerySchema, request);
    const result = await withRedisJsonCache({
      resource: "mobility-flows",
      identity: input,
      freshness: input.at === "latest" ? "latest" : "historical"
    }, () => readMobilityFlows(input));
    return apiGeoJson(result.collection, result.meta);
  } catch (error) {
    return apiError(error);
  }
}
