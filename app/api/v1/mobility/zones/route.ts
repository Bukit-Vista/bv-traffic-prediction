import { apiError, apiGeoJson } from "@/lib/api/response";
import { readMobilityZones } from "@/lib/api/mobility-shadow";
import { mobilityZonesQuerySchema, parseQuery } from "@/lib/api/validation";
import { withRedisJsonCache } from "@/lib/cache/redis-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(mobilityZonesQuerySchema, request);
    const result = await withRedisJsonCache({
      resource: "mobility-zones",
      identity: input,
      freshness: input.at === "latest" ? "latest" : "historical"
    }, () => readMobilityZones(input));
    return apiGeoJson(result.collection, result.meta);
  } catch (error) {
    return apiError(error);
  }
}
