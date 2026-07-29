import { apiError, apiJson } from "@/lib/api/response";
import { getMobilityFlows, getMobilityZones } from "@/lib/api/data-source";
import { idSchema } from "@/lib/api/validation";

const BALI_BBOX: [number, number, number, number] = [114.34, -8.9, 115.78, -8.03];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ zoneId: string }> }) {
  try {
    const zoneId = idSchema.parse((await context.params).zoneId);
    const at = new URL(request.url).searchParams.get("at") ?? "latest";
    const [zones, origins, destinations] = await Promise.all([
      getMobilityZones({ bbox: BALI_BBOX, at, limit: 5000 }),
      getMobilityFlows({ bbox: BALI_BBOX, at, limit: 5, minScore: 0, destinationZoneId: zoneId }),
      getMobilityFlows({ bbox: BALI_BBOX, at, limit: 5, minScore: 0, originZoneId: zoneId })
    ]);
    const zone = zones.collection.features.find((feature) => feature.properties.zoneId === zoneId);
    if (!zone) return apiJson(null, { status: "unavailable" }, { status: 404 });
    return apiJson({ zone, topOrigins: origins.collection.features, topDestinations: destinations.collection.features }, {
      selectedSlot: zone.properties.timeBucketUtc, source: zones.source,
      disclaimer: "Predicted relative mobility index. This is not an observed people count."
    });
  } catch (error) { return apiError(error); }
}

