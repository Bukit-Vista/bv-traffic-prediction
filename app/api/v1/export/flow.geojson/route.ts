import { apiError } from "@/lib/api/response";
import { getFlowMap } from "@/lib/api/data-source";
import { mapQuerySchema, parseQuery } from "@/lib/api/validation";
import { withRedisJsonCache } from "@/lib/cache/redis-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(mapQuerySchema, request);
    const cacheInput = { ...input, limit: Math.min(5000, input.limit) };
    const result = await withRedisJsonCache({
      resource: "export-flow-geojson",
      identity: cacheInput,
      freshness: input.at === "latest" ? "latest" : "historical"
    }, () => getFlowMap(cacheInput));
    return new Response(JSON.stringify(result.collection), { headers: { "Content-Type": "application/geo+json", "Content-Disposition": "attachment; filename=bali-traffic-flow.geojson" } });
  } catch (error) { return apiError(error); }
}
