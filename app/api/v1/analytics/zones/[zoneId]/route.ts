import { apiError, apiJson } from "@/lib/api/response";
import { fixtureForSlot } from "@/lib/api/demo-source";
import { idSchema } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ zoneId: string }> }) {
  try {
    const zoneId = idSchema.parse((await context.params).zoneId);
    const fixture = fixtureForSlot("latest");
    const zone = fixture.zones.features.find((feature) => feature.properties.zoneId === zoneId);
    if (!zone) return apiJson(null, { status: "unavailable" }, { status: 404 });
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hourWita: hour, weightedJamFactor: Number(Math.max(0, Math.min(10, (zone.properties.meanJamFactor ?? 3) + Math.sin((hour - 7) / 3) * 1.7)).toFixed(2)), congestedShare: Number(Math.max(.04, Math.min(.9, zone.properties.presenceScore / 130 + Math.sin(hour / 3) * .08)).toFixed(2)), coverage: zone.properties.confidence }));
    return apiJson({ zone: zone.properties, hourly, weighting: "road_overlap_length" }, { selectedSlot: zone.properties.timeBucketUtc, source: "demo_fixture" });
  } catch (error) { return apiError(error); }
}

