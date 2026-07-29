import { apiError } from "@/lib/api/response";
import { getMobilityZones } from "@/lib/api/data-source";
import { withRedisJsonCache } from "@/lib/cache/redis-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const input = { bbox: [114.34,-8.9,115.78,-8.03] as [number, number, number, number], at: url.searchParams.get("at") ?? "latest", limit: 5000 };
    const result = await withRedisJsonCache({
      resource: "export-mobility-zones-geojson",
      identity: input,
      freshness: input.at === "latest" ? "latest" : "historical"
    }, () => getMobilityZones(input));
    return new Response(JSON.stringify({ ...result.collection, meta: { selectedSlot: result.selectedSlot, disclaimer: "Predicted relative mobility index. This is not an observed people count." } }), { headers: { "Content-Type": "application/geo+json", "Content-Disposition": "attachment; filename=bali-mobility-zones.geojson" } });
  } catch (error) { return apiError(error); }
}
