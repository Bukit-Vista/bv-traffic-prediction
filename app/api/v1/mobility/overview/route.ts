import { apiError, apiJson } from "@/lib/api/response";
import { readMobilityFlows, readMobilityZones } from "@/lib/api/mobility-shadow";
import { mobilityZonesQuerySchema, parseQuery } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (!url.searchParams.has("bbox")) url.searchParams.set("bbox", "114.34,-8.90,115.78,-8.03");
    const input = parseQuery(mobilityZonesQuerySchema, new Request(url, request));
    const [result, flows] = await Promise.all([
      readMobilityZones(input),
      readMobilityFlows({ bbox: input.bbox, at: input.at, limit: 10, minScore: 0 })
    ]);
    return apiJson({
      zoneCount: result.run.zoneCount,
      odPairCount: result.run.odCount,
      topHotspots: result.collection.features.slice(0, 5).map(({ properties }) => ({
        zoneId: properties.zoneId, zoneKey: properties.zoneKey, name: properties.name,
        presenceScore: properties.presenceScore, hotspotRank: properties.hotspotRank,
        confidence: properties.confidence
      })),
      topFlows: flows.collection.features.map(({ properties }) => ({
        originZoneKey: properties.originZoneKey, destinationZoneKey: properties.destinationZoneKey,
        mobilityScore: properties.mobilityScore, predictedShare: properties.predictedShare,
        confidence: properties.confidence
      }))
    }, result.meta);
  } catch (error) {
    return apiError(error);
  }
}
