import { apiError } from "@/lib/api/response";
import { getMobilityFlows } from "@/lib/api/data-source";

function csvCell(value: unknown) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const minScore = Math.max(0, Math.min(100, Number(url.searchParams.get("minScore") ?? 45)));
    const result = await getMobilityFlows({ bbox: [114.34,-8.9,115.78,-8.03], at: url.searchParams.get("at") ?? "latest", limit: 5000, minScore });
    const header = ["origin_zone_id","destination_zone_id","origin_name","destination_name","mobility_score","predicted_share","travel_time_seconds","confidence","model_version","metric_semantics"];
    const lines = result.collection.features.map(({ properties: p }) => [p.originZoneId,p.destinationZoneId,p.originName,p.destinationName,p.mobilityScore,p.predictedShare,p.travelTimeSeconds,p.confidence,p.modelVersion,p.metricSemantics].map(csvCell).join(","));
    return new Response([header.join(","), ...lines].join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=bali-predicted-mobility-flows.csv" } });
  } catch (error) { return apiError(error); }
}

