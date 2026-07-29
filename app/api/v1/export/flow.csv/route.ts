import { apiError } from "@/lib/api/response";
import { getFlowMap } from "@/lib/api/data-source";

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const segmentId = Number(url.searchParams.get("segmentId"));
    const result = await getFlowMap({
      bbox: [114.34, -8.9, 115.78, -8.03],
      at: url.searchParams.get("to") ?? "latest",
      limit: 5000,
      minConfidence: 0
    });
    const features = result.collection.features.filter(
      (feature) => !Number.isFinite(segmentId) || feature.properties.segmentId === segmentId
    );
    const header = ["segment_id","segment_key","road_name","collection_slot_utc","source_updated_utc","fetched_at_utc","speed_kph","free_flow_kph","relative_speed","jam_factor","confidence","traversability","road_closure"];
    const rows = features.map(({ properties: p }) => [p.segmentId,p.segmentKey,p.roadName,p.collectionSlotUtc,p.sourceUpdatedUtc,p.fetchedAtUtc,p.speedKph,p.freeFlowKph,p.relativeSpeed,p.jamFactor,p.confidence,p.traversability,p.roadClosure].map(csvCell).join(","));
    return new Response([header.join(","), ...rows].join("\n"), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=bali-traffic-flow.csv" }
    });
  } catch (error) {
    return apiError(error);
  }
}
