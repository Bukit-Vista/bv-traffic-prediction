import { apiError, apiJson } from "@/lib/api/response";
import { getMobilityFlows } from "@/lib/api/data-source";
import { idSchema } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ zoneId: string }> }) {
  try {
    const zoneId = idSchema.parse((await context.params).zoneId);
    const url = new URL(request.url);
    const result = await getMobilityFlows({ bbox: [114.34,-8.9,115.78,-8.03], at: url.searchParams.get("at") ?? "latest", limit: Math.min(100, Number(url.searchParams.get("limit") ?? 10)), minScore: 0, originZoneId: zoneId });
    return apiJson({ relationships: result.collection.features }, { selectedSlot: result.selectedSlot, source: result.source, disclaimer: "Relative prediction, not a people or trip count." });
  } catch (error) { return apiError(error); }
}

